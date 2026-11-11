/**
 * @fileoverview Tests for the shape checks on a typed IBM i profile and
 * password. All credentials here are made up.
 */

import { describe, expect, it } from "vitest";
import {
  checkCredentials,
  isProfileAllowed,
} from "../../../src/ibmi-mcp-server/oauth/credentialSyntax.js";

const PASSWORD = "dummy-Pw-123";

const check = (profile: string | Buffer, password: string | Buffer) =>
  checkCredentials(
    Buffer.isBuffer(profile) ? profile : Buffer.from(profile, "latin1"),
    Buffer.isBuffer(password) ? password : Buffer.from(password, "latin1"),
  );

describe("checkCredentials: profile", () => {
  it.each([
    ["TESTUSER", "TESTUSER"],
    ["testuser", "TESTUSER"],
    ["TestUser", "TESTUSER"],
    ["A", "A"],
    ["z", "Z"],
    ["ABCDEFGHIJ", "ABCDEFGHIJ"],
    ["A#$_09azAZ", "A#$_09AZAZ"],
    ["A123456789", "A123456789"],
    ["#1", "#1"],
  ])("accepts %j as %j", (typed, profile) => {
    expect(check(typed, PASSWORD)).toEqual({ ok: true, profile });
  });

  it.each([
    ["empty", ""],
    ["11 characters", "ABCDEFGHIJK"],
    ["a Kerberos-style name", "USER@REALM"],
    ["@ alone", "@"],
    ["a space inside", "TEST USER"],
    ["a leading space", " TESTUSER"],
    ["a trailing space", "TESTUSER "],
    ["a hyphen", "TEST-USER"],
    ["a dot", "TEST.USER"],
    ["a semicolon", "A;B"],
    ["a NUL", "A\0B"],
    ["a line feed", "A\nB"],
    ["a national character", "J\xd8RGEN"],
    // jt400 signs a name that starts with a digit on as Q plus the digits.
    ["a digit first", "1TESTUSER"],
    ["0 first", "0A"],
    ["9 first", "9A"],
    ["digits only", "0123456789"],
    // The byte on each side of every allowed range.
    ["/ (below 0)", "A/"],
    [": (above 9)", "A:"],
    ["[ (above Z)", "A["],
    ["` (below a)", "A`"],
    ["{ (above z)", "A{"],
    ['" (below #)', 'A"'],
    ["% (above $)", "A%"],
    ["^ (below _)", "A^"],
  ])("refuses a profile with %s", (_what, typed) => {
    expect(check(typed, PASSWORD)).toEqual({
      ok: false,
      reason: "profile_syntax",
    });
  });

  it("reports the profile first when both fields are wrong", () => {
    expect(check("USER@REALM", "")).toEqual({
      ok: false,
      reason: "profile_syntax",
    });
  });
});

describe("checkCredentials: password", () => {
  it.each([
    ["one character", "x"],
    ["128 characters", "x".repeat(128)],
    ["the lowest printable character after space", "!"],
    ["the highest printable character", "~"],
    [
      'every printable character but ; " : and %',
      "a !#$&'()*+,-./0<=>?@A[]^_`{|}~z",
    ],
    ["an asterisk inside", "a*b"],
    ["an asterisk at the end", "ab*"],
    ["a space inside", "correct horse"],
    ["a backslash inside", "a\\b"],
    ["a leading backslash", "\\ab"],
  ])("accepts %s", (_what, password) => {
    expect(check("TESTUSER", password)).toEqual({
      ok: true,
      profile: "TESTUSER",
    });
  });

  it.each([
    ["empty", ""],
    ["129 characters", "x".repeat(129)],
    ["a leading space", " dummy-Pw-123"],
    ["a trailing space", "dummy-Pw-123 "],
    ["only a space", " "],
    ["a tab", "dummy\tPw"],
    ["a line feed", "dummy\nPw"],
    ["a NUL", "dummy\0Pw"],
    ["0x1F", "dummy\x1fPw"],
    ["DEL (0x7F)", "dummy\x7fPw"],
    ["a byte above ASCII", "dummy\x80Pw"],
    ["a Latin-1 letter", "p\xe4ssword"],
  ])("refuses a password that is or has %s", (_what, password) => {
    expect(check("TESTUSER", password)).toEqual({
      ok: false,
      reason: "password_syntax",
    });
  });

  it("refuses a multi-byte UTF-8 password", () => {
    expect(check("TESTUSER", Buffer.from("pässword", "utf8"))).toEqual({
      ok: false,
      reason: "password_syntax",
    });
  });

  // Mapepire puts the password into a JDBC URL: each of these would add or
  // change a connection property there.
  it.each([
    ["a second property", "x;user=QSECOFR"],
    ["a property at the end", "dummy-Pw-123;"],
    ["a leading semicolon", ";trace=true"],
    ["a quote that opens a value", 'x";trace=true'],
    ["a quoted value", '"dummy-Pw-123"'],
    ["a trailing quote", 'dummy-Pw-123"'],
    ["a trailing backslash", "dummy-Pw-123\\"],
    ["only a backslash", "\\"],
  ])("refuses the JDBC injection shape with %s", (_what, password) => {
    expect(check("TESTUSER", password)).toEqual({
      ok: false,
      reason: "password_syntax",
    });
  });

  // mapepire-server before 2.3.6 would sign on with a different password
  // (":" and "%"); jt400 reads a leading "*" as a special value.
  it.each([
    ["a colon inside", "dummy:Pw-123"],
    ["a colon at the end", "dummy-Pw-123:"],
    ["a colon at the start", ":dummy-Pw-123"],
    ["only a colon", ":"],
    ["a percent sign", "dummy%Pw-123"],
    ["a doubled percent sign", "dummy%%Pw-123"],
    ["a percent sign at the end", "dummy-Pw-123%"],
    ["an asterisk at the start", "*dummy-Pw-123"],
    ["a special value", "*CURRENT"],
    ["only an asterisk", "*"],
  ])(
    "refuses a password no Mapepire version passes on unchanged: %s",
    (_what, password) => {
      expect(check("TESTUSER", password)).toEqual({
        ok: false,
        reason: "password_syntax",
      });
    },
  );
});

describe("checkCredentials: password equal to the profile", () => {
  it.each([
    ["TESTUSER", "TESTUSER"],
    ["TESTUSER", "testuser"],
    ["testuser", "TESTUSER"],
    ["TestUser", "tESTuSER"],
    ["A#$_09", "a#$_09"],
  ])("refuses profile %j with password %j", (profile, password) => {
    expect(check(profile, password)).toEqual({
      ok: false,
      reason: "password_is_profile",
    });
  });

  it.each([
    ["TESTUSER", "TESTUSER1"],
    ["TESTUSER", "TESTUSE"],
    ["TESTUSER", "TESTUSEX"],
    ["TESTUSER", "XESTUSER"],
  ])("accepts profile %j with password %j", (profile, password) => {
    expect(check(profile, password)).toMatchObject({ ok: true });
  });
});

describe("checkCredentials: what it leaves behind", () => {
  it("does not change either buffer", () => {
    const profile = Buffer.from("testuser");
    const password = Buffer.from(PASSWORD);
    check(profile, password);
    expect(profile.toString()).toBe("testuser");
    expect(password.toString()).toBe(PASSWORD);
  });

  it.each([
    ["USER@REALM", PASSWORD],
    ["TESTUSER", "bad;dummy-Pw"],
    ["TESTUSER", "testuser"],
  ])("echoes nothing typed in a refusal (%j)", (profile, password) => {
    const result = check(profile, password);
    expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
    expect(JSON.stringify(result)).not.toContain(profile);
    expect(JSON.stringify(result).toLowerCase()).not.toContain(
      password.toLowerCase(),
    );
  });
});

describe("isProfileAllowed", () => {
  it("allows every profile that does not start with Q when the list is empty", () => {
    expect(isProfileAllowed("TESTUSER", [])).toBe(true);
    expect(isProfileAllowed("AQ", [])).toBe(true);
    expect(isProfileAllowed("QSECOFR", [])).toBe(false);
    expect(isProfileAllowed("QUSER", [])).toBe(false);
    expect(isProfileAllowed("Q", [])).toBe(false);
  });

  it("allows only listed names and prefixes when the list is set", () => {
    const allowed = ["ALICE", "DEV*"];
    expect(isProfileAllowed("ALICE", allowed)).toBe(true);
    expect(isProfileAllowed("DEVJANE", allowed)).toBe(true);
    expect(isProfileAllowed("DEV", allowed)).toBe(true);
    expect(isProfileAllowed("ALICEX", allowed)).toBe(false);
    expect(isProfileAllowed("ALIC", allowed)).toBe(false);
    expect(isProfileAllowed("XDEV", allowed)).toBe(false);
    expect(isProfileAllowed("TESTUSER", allowed)).toBe(false);
  });

  it("does not read an exact name as a prefix", () => {
    expect(isProfileAllowed("DEVJANE", ["DEV"])).toBe(false);
  });

  it("allows a Q profile only when it is listed exactly", () => {
    expect(isProfileAllowed("QSECOFR", ["QSECOFR"])).toBe(true);
    expect(isProfileAllowed("QSECOFR", ["Q*"])).toBe(false);
    expect(isProfileAllowed("QSECOFR", ["QSEC*"])).toBe(false);
    expect(isProfileAllowed("QSECOFR", ["QSECOFR*"])).toBe(false);
    expect(isProfileAllowed("QPGMR", ["QSECOFR"])).toBe(false);
    expect(isProfileAllowed("TESTUSER", ["QSECOFR"])).toBe(false);
  });
});
