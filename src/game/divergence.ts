import type { UnitSnapshot, WorldSnapshot } from "./snapshot";

/**
 * Where the authority and a client disagree (docs/multiplayer.md Phase E item 10a).
 *
 * The developer's call on the 9/10 sequencing was **B: the client renders snapshots AND keeps
 * simulating**, so the two can be compared and the difference logged. This module is that
 * comparison, and it is the entire reason B was worth choosing — "they drift" is a bug report
 * nobody can act on, "unit 41's hp is 260 here and 245 there, 1.2 s after the match started" is
 * a lead.
 *
 * **It compares two SNAPSHOTS, never a snapshot against a live world.** The local side is put
 * through the same `snapshotFor` the authority used, so both sides are the same shape, redacted
 * by the same rules, for the same recipient. That is what makes a reported difference mean
 * "these two worlds disagree" rather than "these two representations disagree" — a comparator
 * that read the local `SimUnit` directly would report the AoI redaction and the illusion mask as
 * drift on every single tick, and drown the real signal on its first run.
 *
 * It follows that a client can only diff what it was SENT. Anything the fog withheld is absent
 * from the authority's snapshot and must not be counted as missing — see `divergence`'s
 * handling of `remembered`, which is the one place that distinction bites.
 */

/** One disagreement. Deliberately flat and JSON-shaped: these end up in a log line, and later
 *  (item 11) possibly on the wire back to the host. */
export type Divergence =
  /** The authority sent a unit the local sim does not have. */
  | { kind: "missing"; id: number }
  /** The local sim has a unit the authority did not send. The ambiguous one — see below. */
  | { kind: "extra"; id: number }
  /** Both have it; a field disagrees. */
  | { kind: "field"; id: number; field: string; local: unknown; authority: unknown };

export interface DivergenceOptions {
  /**
   * Positions and timers are floats accumulated over different numbers of steps, so exact
   * equality would report every unit every tick. This is "close enough that no player could
   * tell", not "close enough to be the same number".
   */
  epsilon?: number;
  /**
   * Stop after this many findings. A genuinely desynced world produces one per unit per field,
   * and a log line per unit per tick is not a diagnostic, it is a denial of service against
   * whoever has to read it. The first few are the interesting ones anyway: drift has a cause,
   * and the cause is usually one unit.
   */
  limit?: number;
  /**
   * Fields that are allowed to disagree. Empty by default ON PURPOSE — the temptation with a
   * drift detector is to silence whatever is noisy, and a field silenced before anybody
   * understood why it was noisy is a desync nobody will ever find. Add to this only with a
   * reason, in the caller.
   */
  ignore?: readonly string[];
}

const DEFAULT_EPSILON = 0.5; // world units — half a unit is far below anything visible
const DEFAULT_LIMIT = 24;

/** Numbers compare with tolerance; everything else structurally. Arrays and nested objects go
 *  through JSON, which is exact — they are the composites (`buffs`, `abilities`, the build
 *  queue) where an off-by-one IS the bug rather than float noise. */
function differs(a: unknown, b: unknown, epsilon: number): boolean {
  if (typeof a === "number" && typeof b === "number") {
    // NaN is never equal to itself, so it would otherwise be reported forever. It is also
    // always a bug, so it is reported once, loudly, as a difference from whatever it faces.
    if (Number.isNaN(a) || Number.isNaN(b)) return !(Number.isNaN(a) && Number.isNaN(b));
    return Math.abs(a - b) > epsilon;
  }
  if (typeof a !== typeof b) return true;
  if (a === null || b === null || typeof a !== "object") return a !== b;
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Compare what the authority sent against what this client simulated for itself.
 *
 * Both arguments must have been built by `snapshotFor` for the SAME recipient. Passing two
 * different recipients' snapshots compares two different redactions and reports nonsense; the
 * recipient stamp each snapshot carries is checked for exactly that reason, and a mismatch is
 * reported as a single finding rather than silently producing hundreds.
 */
export function divergence(
  authority: WorldSnapshot,
  local: WorldSnapshot,
  opts: DivergenceOptions = {},
): Divergence[] {
  const epsilon = opts.epsilon ?? DEFAULT_EPSILON;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const ignore = new Set(opts.ignore ?? []);
  const out: Divergence[] = [];

  // A mis-addressed snapshot is not drift, and reporting it as drift would send somebody
  // hunting a desync that does not exist. `WorldSnapshot.recipient` is carried in the payload
  // precisely so this is noticeable rather than silently rendered (item 5).
  if (authority.recipient !== local.recipient) {
    return [{ kind: "field", id: -1, field: "recipient", local: local.recipient, authority: authority.recipient }];
  }

  const mine = new Map<number, UnitSnapshot>();
  for (const u of local.units) mine.set(u.id, u);

  for (const a of authority.units) {
    if (out.length >= limit) return out;
    const b = mine.get(a.id);
    if (!b) {
      out.push({ kind: "missing", id: a.id });
      continue;
    }
    mine.delete(a.id);
    // A REMEMBERED record is a last-seen image, and every live value in it was deliberately
    // zeroed (item 6). Diffing those zeros against the local sim's live values would report
    // the redaction as drift on every fogged building on the map. Only its identity and pose
    // are knowledge, and only those are compared.
    // Read as bags of fields. `UnitSnapshot` has no index signature — deliberately, it is a
    // named contract — so the cast happens once, here, rather than at four use sites.
    const av = a as unknown as Record<string, unknown>;
    const bv = b as unknown as Record<string, unknown>;
    const fields: readonly string[] = a.remembered || b.remembered ? MEMORY_FIELDS : Object.keys(a);
    for (const f of fields) {
      if (ignore.has(f)) continue;
      if (!differs(av[f], bv[f], epsilon)) continue;
      out.push({ kind: "field", id: a.id, field: f, local: bv[f], authority: av[f] });
      if (out.length >= limit) return out;
    }
  }

  // Whatever is left is local-only. This is the ambiguous case and the comment matters: it is
  // NOT necessarily drift. The authority withholds what this recipient cannot see (item 6), so
  // a unit the client is simulating but was not sent may simply have walked into the fog. It is
  // still reported, because the alternative — staying silent — would hide a genuinely
  // desynced-into-existence unit, and one line saying "extra" is cheap to dismiss when you know
  // where the unit is.
  for (const id of mine.keys()) {
    if (out.length >= limit) return out;
    out.push({ kind: "extra", id });
  }

  return out;
}

/**
 * What a remembered record actually claims to know. Everything else in it is a redacted zero.
 *
 * **`remembered` itself is deliberately absent**, and finding that out is why this list exists
 * rather than being `Object.keys` minus a few. It is a fact about the OBSERVER's fog, not about
 * the world: each side rebuilds its own grid on its own 10 Hz clock, so the authority and a
 * client will constantly disagree by one rebuild about whether they currently have eyes on a
 * building. That is skew, not drift, and reporting it would put a finding on the log for every
 * fogged structure on the map several times a second — burying the one line that matters.
 */
const MEMORY_FIELDS = ["id", "owner", "team", "typeId", "x", "y", "facing", "altModel"] as const;

/** One line a human can read, for the console. Kept here so the format is the same wherever it
 *  is logged and a change to `Divergence` cannot leave a formatter behind. */
export function describeDivergence(d: Divergence): string {
  if (d.kind === "missing") return `unit ${d.id}: sent by the authority, absent locally`;
  if (d.kind === "extra") return `unit ${d.id}: simulated locally, not sent (may simply be fogged)`;
  return `unit ${d.id}.${d.field}: local ${JSON.stringify(d.local)} vs authority ${JSON.stringify(d.authority)}`;
}
