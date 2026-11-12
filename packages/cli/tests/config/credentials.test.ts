import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "stream";
import {
  expandEnvVars,
  promptLine,
  promptPassword,
} from "../../src/config/credentials.js";

describe("expandEnvVars", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env["TEST_HOST"] = "myhost.example.com";
    process.env["TEST_USER"] = "TESTUSER";
    process.env["TEST_PASS"] = "secret123";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should expand a single env var", () => {
    expect(expandEnvVars("${TEST_HOST}")).toBe("myhost.example.com");
  });

  it("should expand multiple env vars", () => {
    expect(expandEnvVars("${TEST_USER}@${TEST_HOST}")).toBe(
      "TESTUSER@myhost.example.com",
    );
  });

  it("should leave unset vars unexpanded", () => {
    expect(expandEnvVars("${NONEXISTENT_VAR}")).toBe("${NONEXISTENT_VAR}");
  });

  it("should return plain strings unchanged", () => {
    expect(expandEnvVars("plain-value")).toBe("plain-value");
  });

  it("should handle empty env var value", () => {
    process.env["EMPTY_VAR"] = "";
    expect(expandEnvVars("${EMPTY_VAR}")).toBe("");
  });

  it("should handle mixed text and vars", () => {
    expect(expandEnvVars("host=${TEST_HOST}:8076")).toBe(
      "host=myhost.example.com:8076",
    );
  });
});

describe("promptPassword (TTY)", () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const originalStderrWrite = process.stderr.write;
  let fakeStdin: PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: (mode: boolean) => void;
  };
  let stderrWrites: string[];

  beforeEach(() => {
    fakeStdin = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(mode: boolean) {
        fakeStdin.isRaw = mode;
      },
    });
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });
    stderrWrites = [];
    process.stderr.write = ((chunk: string) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", stdinDescriptor);
    process.stderr.write = originalStderrWrite;
  });

  it("should not echo typed characters", async () => {
    const pending = promptPassword("Password: ");
    for (const c of "hunter2") fakeStdin.write(c);
    fakeStdin.write("\r");

    await expect(pending).resolves.toBe("hunter2");
    expect(stderrWrites.join("")).toBe("Password: \n");
    expect(fakeStdin.isRaw).toBe(false);
  });

  it("should accept a pasted value ending in a newline as one chunk", async () => {
    const pending = promptPassword("Password: ");
    fakeStdin.write("hunter2\r");

    await expect(pending).resolves.toBe("hunter2");
  });

  it("should apply backspace", async () => {
    const pending = promptPassword("Password: ");
    fakeStdin.write("abcx\u007f\n");

    await expect(pending).resolves.toBe("abc");
  });

  it("should reject on Ctrl+C and restore the terminal mode", async () => {
    const pending = promptPassword("Password: ");
    fakeStdin.write("abc\u0003");

    await expect(pending).rejects.toThrow("Cancelled");
    expect(fakeStdin.isRaw).toBe(false);
  });
});

describe("promptLine", () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const originalStderrWrite = process.stderr.write;
  let fakeStdin: PassThrough;

  beforeEach(() => {
    fakeStdin = new PassThrough();
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", stdinDescriptor);
    process.stderr.write = originalStderrWrite;
  });

  it("should resolve with the entered line", async () => {
    const pending = promptLine("Continue? (y/N) ");
    fakeStdin.write("y\n");

    await expect(pending).resolves.toBe("y");
  });

  it("should resolve with an empty answer when input ends", async () => {
    const pending = promptLine("Continue? (y/N) ");
    fakeStdin.end();

    await expect(pending).resolves.toBe("");
  });
});
