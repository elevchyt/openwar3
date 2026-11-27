// JASS runtime value model (Phase 7 — issue #33; see docs/triggers.md).
//
// JASS is statically typed, but our tree-walker is dynamic, so every value carries
// its kind. The one distinction that MUST be tracked (not inferred) is integer vs
// real, because JASS arithmetic depends on it: `integer / integer` is TRUNCATING
// integer division (7/2 == 3), while any real operand makes it real division
// (7/2.0 == 3.5). Getting this wrong silently corrupts damage/timing math, so we
// keep 'int' and 'real' as separate kinds rather than one JS number.
//
// Handles (unit, player, trigger, timer, group, rect, …) are opaque reference
// types in JASS; we model them as an integer id into the runtime's handle table
// plus the JASS type name (for diagnostics). `code` is a bare `function Foo`
// reference. `null` is JASS's null — the default for handle and string types.

export type JassValue =
  | { k: "int"; n: number }
  | { k: "real"; n: number }
  | { k: "bool"; b: boolean }
  | { k: "string"; s: string }
  | { k: "handle"; h: number; ty: string }
  | { k: "code"; fn: string }
  | { k: "null" };

export const JNULL: JassValue = { k: "null" };

export const jInt = (n: number): JassValue => ({ k: "int", n: n | 0 });
export const jReal = (n: number): JassValue => ({ k: "real", n });
export const jBool = (b: boolean): JassValue => ({ k: "bool", b });
export const jStr = (s: string): JassValue => ({ k: "string", s });
export const jHandle = (h: number, ty: string): JassValue => ({ k: "handle", h, ty });
export const jCode = (fn: string): JassValue => ({ k: "code", fn });

/** Numeric value of an int/real (0 for non-numbers). Used where JASS would have
 *  coerced an integer to a real (implicit widening is legal in that direction). */
export function asNum(v: JassValue): number {
  return v.k === "int" || v.k === "real" ? v.n : 0;
}

/** Integer value (truncated) of an int/real. */
export function asInt(v: JassValue): number {
  return v.k === "int" ? v.n : v.k === "real" ? Math.trunc(v.n) : 0;
}

/** JASS boolean-ness. Only actual booleans are truthy in JASS conditions — there
 *  is no implicit int/handle→bool, so a non-bool is treated as false. */
export function truthy(v: JassValue): boolean {
  return v.k === "bool" && v.b;
}

/** String value: strings pass through; other kinds coerce the way JASS's `+`
 *  string-concatenation and I2S-less contexts effectively present them. Mainly
 *  used by natives that log/format. */
export function asStr(v: JassValue): string {
  switch (v.k) {
    case "string":
      return v.s;
    case "int":
      return String(v.n);
    case "real":
      return String(v.n);
    case "bool":
      return v.b ? "true" : "false";
    case "null":
      return "";
    default:
      return "";
  }
}

/** The handle id of a handle value, or -1 for null/non-handles (a natural
 *  "no such object" sentinel for bridge lookups). */
export function asHandle(v: JassValue): number {
  return v.k === "handle" ? v.h : -1;
}

/**
 * How far apart two reals may be and still be `==`. The game's `==` on reals is TOLERANT while
 * its `!=` is EXACT — so `0.1 + 0.2 == 0.3` and `1.0001 == 1.0` are both true and `!=` is not
 * the negation of `==` — which is long-standing community knowledge of the VM (the Hive JASS
 * threads on comparing reals; issue #374) rather than anything in a file, and the value is the
 * one those threads give. Not yet measured on the client. It is what makes
 * `GetUnitState(u, UNIT_STATE_LIFE) == GetUnitState(u, UNIT_STATE_MAX_LIFE)` and the GUI's
 * "Real Comparison – Equal to" hold for a unit whose life is a hair under its maximum.
 */
export const REAL_EQUALS_EPSILON = 0.001;

/** JASS `==` equality. Numbers compare by value across int/real — two integers exactly, and
 *  with a real on either side within `REAL_EQUALS_EPSILON`; handles by id; null equals null,
 *  any null-valued handle, `false`, `0` and `0.0`. Strings/bools by value. `!=` is NOT this
 *  negated: see `jassNotEquals`. */
export function jassEquals(a: JassValue, b: JassValue): boolean {
  if (a.k === "null" || b.k === "null") {
    // In the game's VM null is a raw 0, so a boolean, integer or real compares against it by
    // value: `false == null`, `0 == null` and `0.0 == null` are all TRUE. Measured on the real
    // 1.30.4 client (a probe map printing each comparison, literals and variables alike):
    // `true`, `1` and `1.0` are not null, and a STRING is the exception — `"" == null` is false
    // and only a string that IS null equals it, which is what the both-null rule below says.
    // Map optimizers rely on the boolean case — `IsUnitType(u, t) != null` is their spelling
    // of `!= false` (the IsUnitType-in-a-condition workaround), and BleachVsOnepiece13's `MG`
    // wraps all 568 of its type checks in it, as do the hero filters of the install's own
    // DotA 6.77b AI and Angel Arena. Reading `false != null` as TRUE made every unit every
    // type there: a dummy counted as a hero, re-fired the "a hero enters the rect" trigger
    // that spawned it, and spawned more of itself until the match ground to a halt.
    const other = a.k === "null" ? b : a;
    if (other.k === "bool") return !other.b;
    if (other.k === "int" || other.k === "real") return other.n === 0;
    // null == null, and null == a handle only if that handle is itself null (we
    // never mint a null handle — real handles have ids ≥ 0), so both-null is the
    // only other true case here.
    return a.k === "null" && b.k === "null";
  }
  if ((a.k === "int" || a.k === "real") && (b.k === "int" || b.k === "real")) {
    if (a.k === "int" && b.k === "int") return a.n === b.n;
    return Math.abs(a.n - b.n) < REAL_EQUALS_EPSILON;
  }
  if (a.k === "bool" && b.k === "bool") return a.b === b.b;
  if (a.k === "string" && b.k === "string") return a.s === b.s;
  if (a.k === "handle" && b.k === "handle") return a.h === b.h;
  if (a.k === "code" && b.k === "code") return a.fn === b.fn;
  return false;
}

/** JASS `!=`: the negation of `==` everywhere EXCEPT two numbers with a real among them, which
 *  differ whenever they are not bit-for-bit the same value (see `REAL_EQUALS_EPSILON`). */
export function jassNotEquals(a: JassValue, b: JassValue): boolean {
  if ((a.k === "real" && (b.k === "int" || b.k === "real")) || (b.k === "real" && a.k === "int")) return a.n !== b.n;
  return !jassEquals(a, b);
}

/** The zero/default value for a JASS type name — what an uninitialised local,
 *  global, array slot, or unimplemented-native return should read as. Integers 0,
 *  reals 0.0, booleans false, strings/handles/code null.
 *
 *  A STRING is null too, not "": an uninitialised `string` global, local or array slot is
 *  `== null` in the game, and vJass struct string members are tested exactly that way. Every
 *  reader that wants text goes through `asStr`, which reads null as "", so a null string still
 *  prints and concatenates as empty. */
export function defaultForType(type: string): JassValue {
  switch (type) {
    case "integer":
      return jInt(0);
    case "real":
      return jReal(0);
    case "boolean":
      return jBool(false);
    case "nothing":
      return JNULL;
    default:
      return JNULL; // every handle type defaults to null
  }
}
