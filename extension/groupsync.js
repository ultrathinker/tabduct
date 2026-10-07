// Tabduct extension — pure logic for the "⚡" tab-group <-> sharing sync (unit-tested in
// scripts/test-store.mjs). The group is a UI hint, not a trust boundary: it can only add a
// share when the USER put a tab into the group, and (opt-in) remove one when they took it out.

// Our own programmatic group moves must not be mistaken for user gestures. Each move we make
// is recorded as one EXPECTED event for that tab; the onUpdated listener consumes one per
// event. A counter (not a set): two overlapping moves of the same tab produce two events and
// both must be masked, or the second one is treated as a user dragging the tab out.
export class GroupMask {
  constructor(ttlMs = 2000) { this.ttl = ttlMs; this.m = new Map(); }
  mark(ids, now = Date.now()) {
    for (const id of ids) { const a = this.m.get(id) || []; a.push(now + this.ttl); this.m.set(id, a); }
  }
  // True when this event was expected (and uses it up).
  consume(id, now = Date.now()) {
    const live = (this.m.get(id) || []).filter((t) => t > now);
    if (!live.length) { this.m.delete(id); return false; }
    live.shift();
    if (live.length) this.m.set(id, live); else this.m.delete(id);
    return true;
  }
}

// What to do about a tab whose group membership changed by a user gesture.
//  share   — dragged INTO our group while not shared
//  unshare — taken OUT of our group while shared (only when the user opted into that)
//  null    — nothing
// A tab Chrome itself just put into the group (a link opened from a grouped tab) is NOT a
// user sharing it: that would bypass "don't auto-share tabs opened from shared tabs".
export function groupAction({ tier, useTabGroup, inOurGroup, shared, blocked, justOpened, noAutoShareOpened, unshareOnLeave }) {
  if (useTabGroup === false) return null;
  if (tier !== "tabs") return null; // per-tab mode only
  if (inOurGroup && !shared) {
    if (blocked) return null; // filtered-out origins can't be shared
    if (justOpened && noAutoShareOpened !== false) return null;
    return "share";
  }
  if (!inOurGroup && shared) return unshareOnLeave === true ? "unshare" : null;
  return null;
}
