/**
 * @fileoverview Shape checks on a typed IBM i profile and password, made
 * before anything is forwarded to the IBM i. They work on bytes: no
 * JavaScript string is made of the password, and nothing typed is logged,
 * returned or thrown.
 * @module src/ibmi-mcp-server/oauth/credentialSyntax
 */

import type { CredentialRefusal } from "./contracts.js";

const MAX_PROFILE_BYTES = 10;
const MAX_PASSWORD_BYTES = 128;

const SPACE = 0x20;
const DOUBLE_QUOTE = 0x22;
const PERCENT = 0x25;
const ASTERISK = 0x2a;
const COLON = 0x3a;
const SEMICOLON = 0x3b;
const BACKSLASH = 0x5c;

const isDigit = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 0x30 && byte <= 0x39;

/** An ASCII lower-case letter as its upper-case letter; any other byte as it is. */
const upperCase = (byte: number): number =>
  byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;

/** Whether a byte, upper-cased, is one of `A-Z 0-9 # $ _`. */
function isProfileByte(byte: number): boolean {
  const upper = upperCase(byte);
  return (
    (upper >= 0x41 && upper <= 0x5a) ||
    isDigit(upper) ||
    upper === 0x23 ||
    upper === 0x24 ||
    upper === 0x5f
  );
}

/**
 * Whether a password can sign on through Mapepire unchanged, on every 2.x
 * version of it. Mapepire puts it into a JDBC URL, where `;` starts another
 * property, `"` and a trailing `\` change how the value is read, and edge
 * spaces are dropped. Before 2.3.6 it also splits the `Authorization` value
 * at every `:` and, off IBM i, uses the URL as a format string, so `:` and
 * `%` would sign on with a different password. jt400 reads a leading `*` as
 * a special value.
 */
function isPasswordShape(password: Buffer): boolean {
  const last = password[password.length - 1];
  return (
    password.length >= 1 &&
    password.length <= MAX_PASSWORD_BYTES &&
    password[0] !== SPACE &&
    password[0] !== ASTERISK &&
    last !== SPACE &&
    last !== BACKSLASH &&
    password.every(
      (byte) =>
        byte >= SPACE &&
        byte <= 0x7e &&
        byte !== SEMICOLON &&
        byte !== DOUBLE_QUOTE &&
        byte !== COLON &&
        byte !== PERCENT,
    )
  );
}

/**
 * Checks the sign-in form's fields as bytes, without making a string of the
 * password and without changing either buffer.
 *
 * - Profile: upper-cased, then `^[A-Z0-9#$_]{1,10}$` (so `@` is refused),
 *   not starting with a digit: jt400 signs such a name on as `Q` plus the
 *   digits, a different profile than the one typed.
 * - Password: 1 to 128 bytes, each 0x20 to 0x7E, no `;`, no `"`, no `:`, no
 *   `%`, no leading `*`, no trailing `\`, no leading or trailing space.
 * - A password equal to the profile, ignoring case, is refused.
 *
 * @returns The upper-case profile, or the first rule that failed.
 */
export function checkCredentials(
  profile: Buffer,
  password: Buffer,
): { ok: true; profile: string } | { ok: false; reason: CredentialRefusal } {
  if (
    profile.length < 1 ||
    profile.length > MAX_PROFILE_BYTES ||
    isDigit(profile[0]) ||
    !profile.every(isProfileByte)
  ) {
    return { ok: false, reason: "profile_syntax" };
  }
  if (!isPasswordShape(password)) {
    return { ok: false, reason: "password_syntax" };
  }
  if (
    password.length === profile.length &&
    password.every((byte, i) => upperCase(byte) === upperCase(profile[i]!))
  ) {
    return { ok: false, reason: "password_is_profile" };
  }
  return { ok: true, profile: profile.toString("latin1").toUpperCase() };
}

/**
 * `OAUTH_ALLOWED_PROFILES`. A profile starting with `Q` (IBM-supplied) may
 * sign on only when the list names it exactly. Any other profile may sign on
 * when the list is empty, names it exactly, or has a `PREFIX*` entry it
 * starts with.
 *
 * @param profile - Upper-case profile, as `checkCredentials` returns it.
 * @param allowedProfiles - `config.oauth.allowedProfiles` (upper-case).
 */
export function isProfileAllowed(
  profile: string,
  allowedProfiles: readonly string[],
): boolean {
  if (allowedProfiles.includes(profile)) {
    return true;
  }
  if (profile.startsWith("Q")) {
    return false;
  }
  return (
    allowedProfiles.length === 0 ||
    allowedProfiles.some(
      (entry) => entry.endsWith("*") && profile.startsWith(entry.slice(0, -1)),
    )
  );
}
