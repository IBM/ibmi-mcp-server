/**
 * @fileoverview Per-profile sign-on budgets, shared by the sign-in page and
 * reconnects. They keep this server from using up a profile's QMAXSIGN
 * attempts on the IBM i. No timers and no clock: the time is passed in.
 * @module src/ibmi-mcp-server/oauth/throttle
 */

import { createHmac, createSecretKey, randomBytes } from "node:crypto";
import {
  MAX_SIGNONS_IN_FLIGHT,
  SOFT_BUDGET,
  THROTTLE_MAX_PROFILES,
  type CreateSignOnThrottle,
} from "./contracts.js";

/** Never configured, never exported, lost at exit. */
const fingerprintKey = createSecretKey(randomBytes(32));

/**
 * HMAC-SHA256 of the upper-case profile under a random per-process key, hex.
 * It keys the throttle's state, and it is what a log line carries for a
 * profile that has not signed on: the profile field may hold a mistyped
 * password.
 */
export function fingerprint(profile: string): string {
  return createHmac("sha256", fingerprintKey)
    .update(profile.toUpperCase())
    .digest("hex");
}

/** What is remembered about one profile. */
interface ProfileState {
  /** Rejected sign-ons since the last success. */
  rejected: number;
  /**
   * Sign-ons since the last success that were forwarded and whose result is
   * not known (OTHER, TIMEOUT): the IBM i may have counted each as failed.
   */
  unknown: number;
  /** Times of the OTHER and TIMEOUT results inside the soft window. */
  softFailures: number[];
  /** The profile is paused until this time. */
  pausedUntil: number;
  /** Whether the profile's one sign-on slot is taken. */
  inFlight: boolean;
}

/**
 * Creates the throttle.
 *
 * A profile is blocked, with no time refill, after `maxFailures` rejected
 * sign-ons, or after twice that many sign-ons that were rejected or whose
 * result is not known, with no success between. The second bound is what
 * limits sign-ons whose answer is late, lost or not recognised: the soft
 * budget alone would forward two of them every 30 minutes for ever.
 *
 * State is capped at `THROTTLE_MAX_PROFILES` profiles. At the cap, room is
 * made only by forgetting a profile that holds nothing countable: no
 * rejection, no result that is not known, no soft failure inside the window,
 * no pause and no slot. Forgetting anything else would refill a budget. When
 * no such entry is left, a profile that has signed on in this process (every
 * profile that holds a grant has) still gets an entry, beyond the cap: those
 * are bounded by the sign-ons that worked. A sign-on for any other profile
 * without an entry is answered `busy`, because its result could not be
 * counted.
 *
 * @param maxFailures - `OAUTH_SIGNON_MAX_FAILURES`.
 */
export const createSignOnThrottle: CreateSignOnThrottle = (maxFailures) => {
  const profiles = new Map<string, ProfileState>();
  let inFlight = 0;

  const isBlocked = (state: ProfileState): boolean =>
    state.rejected >= maxFailures ||
    state.rejected + state.unknown >= 2 * maxFailures;

  const holdsNothing = (state: ProfileState, now: number): boolean =>
    !state.inFlight &&
    state.rejected === 0 &&
    state.unknown === 0 &&
    now >= state.pausedUntil &&
    state.softFailures.every((at) => now - at >= SOFT_BUDGET.windowMs);

  const makeRoom = (now: number): boolean => {
    if (profiles.size < THROTTLE_MAX_PROFILES) {
      return true;
    }
    for (const [key, state] of profiles) {
      if (holdsNothing(state, now)) {
        return profiles.delete(key);
      }
    }
    return false;
  };

  return {
    fingerprint,

    begin(profile, now, signedOn = false) {
      const key = fingerprint(profile);
      let state = profiles.get(key);
      if (state) {
        if (isBlocked(state)) {
          return "blocked";
        }
        if (now < state.pausedUntil) {
          return "paused";
        }
        if (state.inFlight) {
          return "busy";
        }
      }
      if (inFlight >= MAX_SIGNONS_IN_FLIGHT) {
        return "busy";
      }
      if (!state) {
        if (!makeRoom(now) && !signedOn) {
          return "busy";
        }
        state = {
          rejected: 0,
          unknown: 0,
          softFailures: [],
          pausedUntil: 0,
          inFlight: false,
        };
        profiles.set(key, state);
      }
      state.inFlight = true;
      inFlight++;
      return "ok";
    },

    end(profile, outcome, now) {
      const key = fingerprint(profile);
      const state = profiles.get(key);
      if (!state?.inFlight) {
        return;
      }
      state.inFlight = false;
      inFlight--;
      state.softFailures = state.softFailures.filter(
        (at) => now - at < SOFT_BUDGET.windowMs,
      );
      if (outcome.class === "ok") {
        state.rejected = 0;
        state.unknown = 0;
      } else if (outcome.class === "rejected" && !outcome.detail) {
        state.rejected++;
      } else if (outcome.class === "other" || outcome.class === "timeout") {
        state.unknown++;
        state.softFailures.push(now);
        if (state.softFailures.length >= SOFT_BUDGET.failures) {
          state.pausedUntil = now + SOFT_BUDGET.pauseMs;
        }
      }
      if (
        state.rejected === 0 &&
        state.unknown === 0 &&
        state.softFailures.length === 0
      ) {
        profiles.delete(key);
      }
    },

    unblock(profile) {
      const state = profiles.get(fingerprint(profile));
      if (!state || !isBlocked(state)) {
        return false;
      }
      state.rejected = 0;
      state.unknown = 0;
      state.softFailures = [];
      state.pausedUntil = 0;
      return true;
    },

    get blocked() {
      let count = 0;
      for (const state of profiles.values()) {
        if (isBlocked(state)) {
          count++;
        }
      }
      return count;
    },
  };
};
