/**
 * @fileoverview Tests for the per-profile sign-on budgets. Profiles are made
 * up; the time is a number the tests pass in.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_SIGNONS_IN_FLIGHT,
  SOFT_BUDGET,
  THROTTLE_MAX_PROFILES,
  type RejectionDetail,
  type SignOnClass,
  type SignOnThrottle,
} from "../../../src/ibmi-mcp-server/oauth/contracts.js";
import {
  createSignOnThrottle,
  fingerprint,
} from "../../../src/ibmi-mcp-server/oauth/throttle.js";

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** One whole sign-on: takes the slot, gives it back with `outcome`. */
function attempt(
  throttle: SignOnThrottle,
  profile: string,
  outcome: SignOnClass,
  now = T0,
  detail?: RejectionDetail,
) {
  const decision = throttle.begin(profile, now);
  if (decision === "ok") {
    throttle.end(profile, { class: outcome, detail }, now);
  }
  return decision;
}

/** Whether a sign-on would be forwarded now, without leaving one in flight. */
function probe(throttle: SignOnThrottle, profile: string, now = T0) {
  const decision = throttle.begin(profile, now);
  if (decision === "ok") {
    throttle.end(profile, { class: "pre" }, now);
  }
  return decision;
}

describe("fingerprint", () => {
  it("is a hex HMAC-SHA256 that does not contain the profile", () => {
    const value = fingerprint("TESTUSER");
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(value.toUpperCase()).not.toContain("TESTUSER");
  });

  it("is the same for one profile in any case, and differs between profiles", () => {
    expect(fingerprint("testuser")).toBe(fingerprint("TESTUSER"));
    expect(fingerprint("TESTUSER")).not.toBe(fingerprint("TESTUSE"));
  });

  it("is the throttle's own, and the same across throttles of one process", () => {
    const a = createSignOnThrottle(2);
    const b = createSignOnThrottle(2);
    expect(a.fingerprint("TESTUSER")).toBe(fingerprint("TESTUSER"));
    expect(b.fingerprint("TESTUSER")).toBe(a.fingerprint("TESTUSER"));
  });
});

describe("hard budget", () => {
  it("blocks a profile after the configured number of rejections", () => {
    const throttle = createSignOnThrottle(2);
    expect(attempt(throttle, "TESTUSER", "rejected")).toBe("ok");
    expect(throttle.blocked).toBe(0);
    expect(attempt(throttle, "TESTUSER", "rejected")).toBe("ok");
    expect(throttle.blocked).toBe(1);
    expect(throttle.begin("TESTUSER", T0)).toBe("blocked");
  });

  it("honours OAUTH_SIGNON_MAX_FAILURES", () => {
    const one = createSignOnThrottle(1);
    attempt(one, "TESTUSER", "rejected");
    expect(one.begin("TESTUSER", T0)).toBe("blocked");

    const three = createSignOnThrottle(3);
    attempt(three, "TESTUSER", "rejected");
    attempt(three, "TESTUSER", "rejected");
    expect(probe(three, "TESTUSER")).toBe("ok");
    attempt(three, "TESTUSER", "rejected");
    expect(three.begin("TESTUSER", T0)).toBe("blocked");
  });

  it("does not refill with time", () => {
    const throttle = createSignOnThrottle(2);
    attempt(throttle, "TESTUSER", "rejected", T0);
    attempt(throttle, "TESTUSER", "rejected", T0 + 24 * 60 * MINUTE);
    expect(throttle.begin("TESTUSER", T0 + 365 * 24 * 60 * MINUTE)).toBe(
      "blocked",
    );
  });

  it("is cleared by a success between rejections", () => {
    const throttle = createSignOnThrottle(2);
    attempt(throttle, "TESTUSER", "rejected");
    attempt(throttle, "TESTUSER", "ok");
    attempt(throttle, "TESTUSER", "rejected");
    expect(throttle.blocked).toBe(0);
    expect(attempt(throttle, "TESTUSER", "rejected")).toBe("ok");
    expect(throttle.begin("TESTUSER", T0)).toBe("blocked");
  });

  it("counts each profile on its own, whatever the case it is given in", () => {
    const throttle = createSignOnThrottle(2);
    attempt(throttle, "TESTUSER", "rejected");
    attempt(throttle, "testuser", "rejected");
    expect(throttle.begin("TESTUSER", T0)).toBe("blocked");
    expect(probe(throttle, "OTHERUSER")).toBe("ok");
  });

  it.each([
    ["pre", undefined],
    ["mapepire", undefined],
    ["rejected", "expired"],
    ["rejected", "disabled"],
  ] as const)("does not count %s %s", (outcome, detail) => {
    const throttle = createSignOnThrottle(1);
    for (let i = 0; i < 5; i++) {
      expect(attempt(throttle, "TESTUSER", outcome, T0, detail)).toBe("ok");
    }
    expect(throttle.blocked).toBe(0);
  });

  it("does not count OTHER and TIMEOUT as rejections", () => {
    const throttle = createSignOnThrottle(2);
    attempt(throttle, "TESTUSER", "other", T0);
    attempt(throttle, "TESTUSER", "timeout", T0 + DAY);
    attempt(throttle, "TESTUSER", "other", T0 + 2 * DAY);
    expect(throttle.blocked).toBe(0);
    expect(probe(throttle, "TESTUSER", T0 + 3 * DAY)).toBe("ok");
  });
});

describe("sign-ons whose result is not known", () => {
  it.each([1, 2, 3])(
    "block a profile after twice OAUTH_SIGNON_MAX_FAILURES=%i of them, however far apart",
    (maxFailures) => {
      const throttle = createSignOnThrottle(maxFailures);
      for (let i = 0; i < 2 * maxFailures; i++) {
        expect(throttle.blocked).toBe(0);
        expect(
          attempt(
            throttle,
            "TESTUSER",
            i % 2 ? "timeout" : "other",
            T0 + i * DAY,
          ),
        ).toBe("ok");
      }
      expect(throttle.blocked).toBe(1);
      expect(throttle.begin("TESTUSER", T0 + 365 * DAY)).toBe("blocked");
      expect(probe(throttle, "OTHERUSER", T0 + 365 * DAY)).toBe("ok");
    },
  );

  it("count toward that bound together with rejections", () => {
    const throttle = createSignOnThrottle(2);
    attempt(throttle, "TESTUSER", "other", T0);
    attempt(throttle, "TESTUSER", "rejected", T0 + DAY);
    attempt(throttle, "TESTUSER", "timeout", T0 + 2 * DAY);
    expect(probe(throttle, "TESTUSER", T0 + 3 * DAY)).toBe("ok");
    expect(attempt(throttle, "TESTUSER", "other", T0 + 3 * DAY)).toBe("ok");
    expect(throttle.begin("TESTUSER", T0 + 4 * DAY)).toBe("blocked");
  });

  it("are forgotten at a success", () => {
    const throttle = createSignOnThrottle(1);
    attempt(throttle, "TESTUSER", "other", T0);
    attempt(throttle, "TESTUSER", "ok", T0 + DAY);
    expect(attempt(throttle, "TESTUSER", "timeout", T0 + 2 * DAY)).toBe("ok");
    expect(throttle.blocked).toBe(0);
    expect(attempt(throttle, "TESTUSER", "other", T0 + 3 * DAY)).toBe("ok");
    expect(throttle.blocked).toBe(1);
  });

  it("are cleared by unblock once they block", () => {
    const throttle = createSignOnThrottle(1);
    attempt(throttle, "TESTUSER", "other", T0);
    expect(throttle.unblock("TESTUSER")).toBe(false);
    attempt(throttle, "TESTUSER", "timeout", T0 + DAY);
    expect(throttle.begin("TESTUSER", T0 + 2 * DAY)).toBe("blocked");

    expect(throttle.unblock("TESTUSER")).toBe(true);

    expect(throttle.blocked).toBe(0);
    expect(attempt(throttle, "TESTUSER", "other", T0 + 2 * DAY)).toBe("ok");
    expect(probe(throttle, "TESTUSER", T0 + 3 * DAY)).toBe("ok");
  });
});

describe("unblock", () => {
  it("clears a block and gives the whole budget back", () => {
    const throttle = createSignOnThrottle(2);
    attempt(throttle, "TESTUSER", "rejected");
    attempt(throttle, "TESTUSER", "rejected");
    expect(throttle.unblock("testuser")).toBe(true);
    expect(throttle.blocked).toBe(0);
    expect(attempt(throttle, "TESTUSER", "rejected")).toBe("ok");
    expect(attempt(throttle, "TESTUSER", "rejected")).toBe("ok");
    expect(throttle.begin("TESTUSER", T0)).toBe("blocked");
  });

  it("returns false and changes nothing for a profile that is not blocked", () => {
    const throttle = createSignOnThrottle(2);
    expect(throttle.unblock("TESTUSER")).toBe(false);
    attempt(throttle, "TESTUSER", "rejected");
    expect(throttle.unblock("TESTUSER")).toBe(false);
    attempt(throttle, "TESTUSER", "rejected");
    expect(throttle.begin("TESTUSER", T0)).toBe("blocked");
  });

  it("unblocks one profile only", () => {
    const throttle = createSignOnThrottle(1);
    attempt(throttle, "TESTUSER", "rejected");
    attempt(throttle, "OTHERUSER", "rejected");
    expect(throttle.blocked).toBe(2);
    throttle.unblock("TESTUSER");
    expect(throttle.blocked).toBe(1);
    expect(throttle.begin("OTHERUSER", T0)).toBe("blocked");
  });
});

describe("soft budget", () => {
  it.each([
    ["other", "other"],
    ["timeout", "timeout"],
    ["other", "timeout"],
  ] as const)("pauses a profile after %s then %s", (first, second) => {
    const throttle = createSignOnThrottle(2);
    attempt(throttle, "TESTUSER", first, T0);
    expect(probe(throttle, "TESTUSER", T0 + MINUTE)).toBe("ok");
    attempt(throttle, "TESTUSER", second, T0 + MINUTE);
    expect(throttle.begin("TESTUSER", T0 + MINUTE)).toBe("paused");
    expect(throttle.blocked).toBe(0);
    expect(probe(throttle, "OTHERUSER", T0 + MINUTE)).toBe("ok");
  });

  it("pauses for 30 minutes, then gives a fresh budget", () => {
    const throttle = createSignOnThrottle(3);
    const pausedAt = T0 + MINUTE;
    attempt(throttle, "TESTUSER", "other", T0);
    attempt(throttle, "TESTUSER", "other", pausedAt);
    const resumesAt = pausedAt + SOFT_BUDGET.pauseMs;
    expect(throttle.begin("TESTUSER", resumesAt - 1)).toBe("paused");
    expect(attempt(throttle, "TESTUSER", "other", resumesAt)).toBe("ok");
    expect(probe(throttle, "TESTUSER", resumesAt)).toBe("ok");
  });

  it("counts only results inside the 30-minute window", () => {
    const throttle = createSignOnThrottle(3);
    attempt(throttle, "TESTUSER", "other", T0);
    // Exactly one window later the first result no longer counts.
    attempt(throttle, "TESTUSER", "other", T0 + SOFT_BUDGET.windowMs);
    expect(probe(throttle, "TESTUSER", T0 + SOFT_BUDGET.windowMs)).toBe("ok");
    // One millisecond inside the window of the second, it does.
    const inside = T0 + 2 * SOFT_BUDGET.windowMs - 1;
    attempt(throttle, "TESTUSER", "timeout", inside);
    expect(throttle.begin("TESTUSER", inside)).toBe("paused");
  });

  it("is not cleared by a success or by unblock", () => {
    const throttle = createSignOnThrottle(2);
    attempt(throttle, "TESTUSER", "other", T0);
    attempt(throttle, "TESTUSER", "ok", T0);
    attempt(throttle, "TESTUSER", "other", T0);
    expect(throttle.unblock("TESTUSER")).toBe(false);
    expect(throttle.begin("TESTUSER", T0)).toBe("paused");
  });
});

describe("sign-ons in flight", () => {
  it("allows one per profile", () => {
    const throttle = createSignOnThrottle(2);
    expect(throttle.begin("TESTUSER", T0)).toBe("ok");
    expect(throttle.begin("TESTUSER", T0)).toBe("busy");
    expect(throttle.begin("testuser", T0)).toBe("busy");
    throttle.end("TESTUSER", { class: "ok" }, T0);
    expect(throttle.begin("TESTUSER", T0)).toBe("ok");
  });

  it(`allows ${MAX_SIGNONS_IN_FLIGHT} in all`, () => {
    const throttle = createSignOnThrottle(2);
    for (let i = 0; i < MAX_SIGNONS_IN_FLIGHT; i++) {
      expect(throttle.begin(`USER${i}`, T0)).toBe("ok");
    }
    expect(throttle.begin("TESTUSER", T0)).toBe("busy");
    throttle.end("USER0", { class: "pre" }, T0);
    expect(throttle.begin("TESTUSER", T0)).toBe("ok");
    expect(throttle.begin("USER0", T0)).toBe("busy");
  });

  it("gives the slot back whatever the outcome", () => {
    const throttle = createSignOnThrottle(5);
    for (const outcome of [
      "ok",
      "pre",
      "mapepire",
      "rejected",
      "other",
    ] as const) {
      expect(attempt(throttle, "TESTUSER", outcome)).toBe("ok");
    }
    for (let i = 0; i < MAX_SIGNONS_IN_FLIGHT; i++) {
      expect(throttle.begin(`USER${i}`, T0)).toBe("ok");
    }
  });

  it("counts a rejection that ends while another profile is in flight", () => {
    const throttle = createSignOnThrottle(1);
    throttle.begin("TESTUSER", T0);
    throttle.begin("OTHERUSER", T0);
    throttle.end("TESTUSER", { class: "rejected" }, T0);
    expect(throttle.begin("TESTUSER", T0)).toBe("blocked");
    expect(throttle.begin("OTHERUSER", T0)).toBe("busy");
  });

  it("ignores an end without a begin", () => {
    const throttle = createSignOnThrottle(1);
    throttle.end("TESTUSER", { class: "rejected" }, T0);
    expect(throttle.blocked).toBe(0);
    // The in-flight count did not go below zero: the limit still holds.
    for (let i = 0; i < MAX_SIGNONS_IN_FLIGHT; i++) {
      expect(throttle.begin(`USER${i}`, T0)).toBe("ok");
    }
    expect(throttle.begin("TESTUSER", T0)).toBe("busy");
  });

  it("ignores a second end of one sign-on", () => {
    const throttle = createSignOnThrottle(3);
    throttle.begin("TESTUSER", T0);
    throttle.end("TESTUSER", { class: "rejected" }, T0);
    throttle.end("TESTUSER", { class: "rejected" }, T0);
    throttle.end("TESTUSER", { class: "rejected" }, T0);
    expect(throttle.blocked).toBe(0);
    for (let i = 0; i < MAX_SIGNONS_IN_FLIGHT; i++) {
      expect(throttle.begin(`USER${i}`, T0)).toBe("ok");
    }
    expect(throttle.begin("TESTUSER", T0)).toBe("busy");
  });
});

describe(`cap of ${THROTTLE_MAX_PROFILES} profiles`, () => {
  /** Leaves `count` profiles in the table, each with one `outcome`. */
  const fill = (
    throttle: SignOnThrottle,
    count: number,
    outcome: SignOnClass,
  ) => {
    for (let i = 0; i < count; i++) {
      attempt(throttle, `FILL${i}`, outcome);
    }
  };

  it("keeps no entry for a profile with nothing to remember", () => {
    const throttle = createSignOnThrottle(2);
    attempt(throttle, "TESTUSER", "other");
    // Successes, and failures that count nothing, take no room: were they
    // kept, the table would be full and TESTUSER, the oldest, forgotten.
    fill(throttle, THROTTLE_MAX_PROFILES / 2, "ok");
    fill(throttle, THROTTLE_MAX_PROFILES, "pre");
    attempt(throttle, "OTHERUSER", "other");

    attempt(throttle, "TESTUSER", "other");
    expect(throttle.begin("TESTUSER", T0)).toBe("paused");
  });

  it("forgets the oldest profile that holds no rejection", () => {
    const throttle = createSignOnThrottle(2);
    attempt(throttle, "VICTIM", "rejected");
    fill(throttle, THROTTLE_MAX_PROFILES - 1, "other");

    expect(attempt(throttle, "TESTUSER", "other")).toBe("ok");

    // FILL0 was forgotten: a second OTHER inside the window does not pause it.
    attempt(throttle, "FILL0", "other");
    expect(probe(throttle, "FILL0")).toBe("ok");
    // FILL2 was not (FILL1 made room for FILL0): its second OTHER pauses it.
    attempt(throttle, "FILL2", "other");
    expect(throttle.begin("FILL2", T0)).toBe("paused");
    // The older rejection was kept: one more blocks the profile.
    attempt(throttle, "VICTIM", "rejected");
    expect(throttle.begin("VICTIM", T0)).toBe("blocked");
  });

  it("a table full of single rejections refuses no one: the oldest that is not blocked is forgotten", () => {
    const throttle = createSignOnThrottle(2);
    attempt(throttle, "BLOCKED", "rejected");
    attempt(throttle, "BLOCKED", "rejected");
    fill(throttle, THROTTLE_MAX_PROFILES - 1, "rejected");
    expect(throttle.blocked).toBe(1);

    // A profile the table does not hold signs on, as does a second one.
    expect(attempt(throttle, "TESTUSER", "ok")).toBe("ok");
    expect(attempt(throttle, "OTHERUSER", "rejected")).toBe("ok");

    // FILL0 made room: its rejection is forgotten, so it takes two more.
    attempt(throttle, "FILL0", "rejected");
    expect(probe(throttle, "FILL0")).toBe("ok");
    // FILL2 was kept (FILL1 made room for FILL0): one more blocks it.
    attempt(throttle, "FILL2", "rejected");
    expect(throttle.begin("FILL2", T0)).toBe("blocked");
    // The blocked profile, the oldest of all, was never forgotten.
    expect(throttle.begin("BLOCKED", T0)).toBe("blocked");
    expect(throttle.unblock("BLOCKED")).toBe(true);
  });

  it("never forgets a blocked profile: when every entry is blocked, an untracked profile is busy", () => {
    const throttle = createSignOnThrottle(1);
    fill(throttle, THROTTLE_MAX_PROFILES, "rejected");
    expect(throttle.blocked).toBe(THROTTLE_MAX_PROFILES);

    expect(throttle.begin("TESTUSER", T0)).toBe("busy");
    expect(throttle.begin("FILL0", T0)).toBe("blocked");

    // An unblock frees its entry at the next success, or makes it the one
    // that is forgotten.
    expect(throttle.unblock("FILL7")).toBe(true);
    expect(throttle.begin("TESTUSER", T0)).toBe("ok");
    expect(throttle.begin("OTHERUSER", T0)).toBe("busy");
  });

  it("does not forget a profile whose sign-on is in flight", () => {
    const throttle = createSignOnThrottle(1);
    expect(throttle.begin("FLYING", T0)).toBe("ok");
    fill(throttle, THROTTLE_MAX_PROFILES - 1, "rejected");

    expect(throttle.begin("TESTUSER", T0)).toBe("busy");
    expect(throttle.begin("FLYING", T0)).toBe("busy");
  });
});
