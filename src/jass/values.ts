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

/** JASS `==` equality. Numbers compare by value across int/real; handles by id;
 *  null equals null and equals any null-valued handle. Strings/bools by value. */
export function jassEquals(a: JassValue, b: JassValue): boolean {
  if (a.k === "null" || b.k === "null") {
    // null == null, and null == a handle only if that handle is itself null (we
    // never mint a null handle — real handles have ids ≥ 0), so both-null is the
    // only true case here.
    return a.k === "null" && b.k === "null";
  }
  if ((a.k === "int" || a.k === "real") && (b.k === "int" || b.k === "real")) return a.n === b.n;
  if (a.k === "bool" && b.k === "bool") return a.b === b.b;
  if (a.k === "string" && b.k === "string") return a.s === b.s;
  if (a.k === "handle" && b.k === "handle") return a.h === b.h;
  if (a.k === "code" && b.k === "code") return a.fn === b.fn;
  return false;
}

/** The zero/default value for a JASS type name — what an uninitialised local,
 *  global, array slot, or unimplemented-native return should read as. Integers 0,
 *  reals 0.0, booleans false, strings/handles/code null. */
export function defaultForType(type: string): JassValue {
  switch (type) {
    case "integer":
      return jInt(0);
    case "real":
      return jReal(0);
    case "boolean":
      return jBool(false);
    case "string":
      return jStr("");
    case "nothing":
      return JNULL;
    default:
      return JNULL; // every handle type defaults to null
  }
}
