/**
 * The file logger rotates with pino-roll. pino-roll 1.x computed the next
 * daily rotation as "start + 24 hours, then midnight", which on a 25-hour
 * day (the end of daylight saving time) is the start itself: it rotated in a
 * loop all day and left millions of empty files. This runs the real
 * transport through such a day.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// pino-roll ships no type declarations.
const build = createRequire(import.meta.url)("pino-roll") as (
  options: Record<string, unknown>,
) => Promise<Writable>;

const originalTz = process.env.TZ;
let dir: string | undefined;

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("log rotation", () => {
  it("rotates once a day across the end of daylight saving time", async () => {
    process.env.TZ = "America/Chicago";
    // 2026-11-01 01:30 CDT: the day that has 25 hours in this zone.
    vi.useFakeTimers({
      now: new Date("2026-11-01T06:30:00Z"),
      toFake: ["Date", "setTimeout", "clearTimeout"],
    });
    dir = mkdtempSync(join(tmpdir(), "log-rotation-"));

    const stream = await build({
      file: join(dir, "combined.log"),
      frequency: "daily",
      mkdir: true,
      limit: { count: 5, removeOtherLogFiles: true },
    });
    stream.write("first\n");
    // One hour of that day: a rotation loop would create a file per tick.
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    stream.end();
    await new Promise((resolve) => stream.once("close", resolve));

    expect(readdirSync(dir)).toHaveLength(1);
  });
});
