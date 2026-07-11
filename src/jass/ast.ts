// JASS abstract syntax tree (Phase 7 — issue #33; see docs/triggers.md).
//
// JASS2 is the scripting language the Warcraft III World Editor compiles every
// map's triggers into (war3map.j). The grammar is small and fully specified by
// the JASS Manual's BNF (see docs/REFERENCES.md "JASS scripting references"); the
// authority for exact native signatures is the `common.j` in the user's own MPQs.
// These node types cover the whole language: globals, native/function decls, and
// the statement/expression forms below. No closures, no user types — the only
// "first-class function" is a bare `function Foo` reference (a `code` value).

export type Expr =
  | { kind: "int"; value: number } // decimal / 0x / $ hex / 'fourcc' rawcode — all 32-bit ints
  | { kind: "real"; value: number }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "var"; name: string } // a variable reference (local, param, or global)
  | { kind: "index"; name: string; index: Expr } // array element read: name[index]
  | { kind: "call"; name: string; args: Expr[] } // function/native call in expression position
  | { kind: "code"; name: string } // `function Foo` — a reference to a function (a `code`/handle)
  | { kind: "unary"; op: "-" | "not" | "+"; expr: Expr }
  | { kind: "binary"; op: BinOp; left: Expr; right: Expr };

export type BinOp = "+" | "-" | "*" | "/" | "==" | "!=" | "<" | ">" | "<=" | ">=" | "and" | "or";

export type Stmt =
  | { kind: "set"; name: string; index?: Expr; value: Expr } // set x = e  /  set a[i] = e
  | { kind: "call"; name: string; args: Expr[] } // call Foo(...)
  | { kind: "if"; branches: Array<{ cond: Expr; body: Stmt[] }>; elseBody?: Stmt[] }
  | { kind: "loop"; body: Stmt[] }
  | { kind: "exitwhen"; cond: Expr }
  | { kind: "return"; value?: Expr };

/** A local or global variable/array declaration (with an optional initializer). */
export interface VarDecl {
  type: string; // JASS type name (integer, real, unit, …) — we're dynamically typed, kept for defaults
  name: string;
  isArray: boolean;
  isConstant: boolean;
  init?: Expr;
}

export interface Param {
  type: string;
  name: string;
}

export interface FunctionDecl {
  name: string;
  params: Param[];
  returns: string; // return type name, or "nothing"
  isConstant: boolean;
  locals: VarDecl[];
  body: Stmt[];
}

/** A `native` declaration — a function the ENGINE provides (implemented in JS in
 *  src/jass/natives/). We keep its return type so an unimplemented native can
 *  still hand back a correctly-typed default instead of crashing the map. */
export interface NativeDecl {
  name: string;
  params: Param[];
  returns: string;
  isConstant: boolean;
}

/** One parsed JASS compilation unit (common.j, blizzard.j, or a map's war3map.j). */
export interface JassProgram {
  globals: VarDecl[];
  natives: NativeDecl[];
  functions: FunctionDecl[];
}
