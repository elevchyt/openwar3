// JASS tree-walking interpreter (Phase 7 — issue #33; see docs/triggers.md).
//
// Evaluates a loaded JassProgram: initialises globals, then runs functions on
// demand (config(), main(), trigger callbacks). Design rules that matter:
//   • int vs real arithmetic is type-directed (integer/ integer truncates) — see
//     values.ts. This is why we track the value kind rather than using JS numbers.
//   • JASS `and`/`or` DO NOT short-circuit — both operands are always evaluated
//     (a well-known JASS gotcha; it's why generated GUI code nests `if`s instead
//     of using `and`). We match that so side-effecting operands behave correctly.
//   • never hard-crash the map: an unknown function/variable or a failed native
//     logs once and yields a typed default (CLAUDE.md "safe default" rule). A
//     runaway loop/recursion is capped rather than hanging the browser.

import type { Expr, FunctionDecl, JassProgram, Stmt, VarDecl } from "./ast";
import { Runtime, JassArray, type NativeCtx } from "./runtime";
import {
  asInt, asNum, asStr, defaultForType, jassEquals, jBool, jInt, jReal, jStr, JNULL, truthy, type JassValue,
} from "./values";

class ReturnSignal {
  constructor(readonly value: JassValue) {}
}

/** A function call frame: local variables + local arrays. Parameters live in the
 *  same var map (JASS has no separate parameter scope). */
class Frame {
  readonly vars = new Map<string, JassValue>();
  readonly arrays = new Map<string, JassArray>();
}

const MAX_CALL_DEPTH = 3000; // deep enough for blizzard.j; a backstop against runaway recursion
const MAX_LOOP_ITERS = 2_000_000; // init loops are tiny; this only guards a pathological script

export class Interpreter {
  private depth = 0;
  private globalDecls: VarDecl[] = [];
  private readonly ctx: NativeCtx;

  constructor(public readonly rt: Runtime) {
    this.ctx = { rt, call: (name, args) => this.callFunction(name, args) };
  }

  /** Register a program's natives/functions and collect its global declarations
   *  (initialisers run later, in initGlobals, once every unit is loaded). */
  load(prog: JassProgram): void {
    for (const n of prog.natives) this.rt.nativeReturns.set(n.name, n.returns);
    for (const f of prog.functions) this.rt.functions.set(f.name, f);
    this.globalDecls.push(...prog.globals);
  }

  /** Evaluate all collected global initialisers, in load order (common.j, then
   *  blizzard.j, then war3map.j) — after native impls are registered, so an
   *  initialiser like `PLAYER_COLOR_RED = ConvertPlayerColor(0)` resolves. */
  initGlobals(): void {
    for (const g of this.globalDecls) {
      if (g.isArray) {
        this.rt.globalArrays.set(g.name, new JassArray(g.type, () => defaultForType(g.type)));
      } else {
        this.rt.globals.set(g.name, g.init ? this.eval(g.init, null) : defaultForType(g.type));
      }
    }
  }

  /** Call a function by name: native impl → user function → declared-but-
   *  unimplemented native (typed default) → unknown (null). Never throws for a
   *  missing target. */
  callFunction(name: string, args: JassValue[]): JassValue {
    const nat = this.rt.natives.get(name);
    if (nat) {
      try {
        return nat(this.ctx, args);
      } catch (err) {
        this.rt.warnOnce(name, `threw: ${(err as Error).message}`);
        return defaultForType(this.rt.nativeReturns.get(name) ?? "nothing");
      }
    }
    const fn = this.rt.functions.get(name);
    if (fn) return this.callUser(fn, args);
    const ret = this.rt.nativeReturns.get(name);
    if (ret !== undefined) {
      this.rt.warnOnce(name);
      return defaultForType(ret);
    }
    this.rt.warnOnce(name, "unknown function");
    return JNULL;
  }

  private callUser(fn: FunctionDecl, args: JassValue[]): JassValue {
    if (++this.depth > MAX_CALL_DEPTH) {
      this.depth--;
      this.rt.warnOnce(fn.name, "call depth exceeded");
      return defaultForType(fn.returns);
    }
    const frame = new Frame();
    for (let i = 0; i < fn.params.length; i++) {
      frame.vars.set(fn.params[i].name, args[i] ?? defaultForType(fn.params[i].type));
    }
    for (const loc of fn.locals) {
      if (loc.isArray) frame.arrays.set(loc.name, new JassArray(loc.type, () => defaultForType(loc.type)));
      else frame.vars.set(loc.name, loc.init ? this.eval(loc.init, frame) : defaultForType(loc.type));
    }
    try {
      this.execBlock(fn.body, frame);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        this.depth--;
        return e.value;
      }
      this.depth--;
      throw e;
    }
    this.depth--;
    return defaultForType(fn.returns);
  }

  private execBlock(stmts: Stmt[], frame: Frame): void {
    for (const s of stmts) this.exec(s, frame);
  }

  private exec(s: Stmt, frame: Frame): void {
    switch (s.kind) {
      case "call":
        this.callFunction(s.name, s.args.map((a) => this.eval(a, frame)));
        return;
      case "set": {
        const value = this.eval(s.value, frame);
        if (s.index !== undefined) {
          const idx = asInt(this.eval(s.index, frame));
          this.arrayFor(s.name, frame).set(idx, value);
        } else if (frame.vars.has(s.name)) {
          frame.vars.set(s.name, value);
        } else {
          this.rt.globals.set(s.name, value);
        }
        return;
      }
      case "return":
        throw new ReturnSignal(s.value ? this.eval(s.value, frame) : JNULL);
      case "if": {
        for (const b of s.branches) {
          if (truthy(this.eval(b.cond, frame))) {
            this.execBlock(b.body, frame);
            return;
          }
        }
        if (s.elseBody) this.execBlock(s.elseBody, frame);
        return;
      }
      case "loop": {
        let iters = 0;
        while (true) {
          if (++iters > MAX_LOOP_ITERS) {
            this.rt.warnOnce("<loop>", "iteration cap hit");
            return;
          }
          try {
            for (const st of s.body) this.exec(st, frame);
          } catch (e) {
            if (e instanceof ExitLoop) return;
            throw e;
          }
        }
      }
      case "exitwhen":
        if (truthy(this.eval(s.cond, frame))) throw EXIT_LOOP;
        return;
    }
  }

  private arrayFor(name: string, frame: Frame | null): JassArray {
    const local = frame?.arrays.get(name);
    if (local) return local;
    let g = this.rt.globalArrays.get(name);
    if (!g) {
      g = new JassArray("integer", () => jInt(0)); // tolerate an undeclared array target
      this.rt.globalArrays.set(name, g);
    }
    return g;
  }

  private eval(e: Expr, frame: Frame | null): JassValue {
    switch (e.kind) {
      case "int":
        return jInt(e.value);
      case "real":
        return jReal(e.value);
      case "string":
        return jStr(e.value);
      case "bool":
        return jBool(e.value);
      case "null":
        return JNULL;
      case "code":
        return { k: "code", fn: e.name };
      case "var": {
        if (frame?.vars.has(e.name)) return frame.vars.get(e.name)!;
        const g = this.rt.globals.get(e.name);
        if (g !== undefined) return g;
        this.rt.warnOnce(e.name, "undefined variable");
        return JNULL;
      }
      case "index": {
        const idx = asInt(this.eval(e.index, frame));
        return this.arrayFor(e.name, frame).get(idx);
      }
      case "call":
        return this.callFunction(e.name, e.args.map((a) => this.eval(a, frame)));
      case "unary":
        return this.evalUnary(e.op, this.eval(e.expr, frame));
      case "binary":
        return this.evalBinary(e, frame);
    }
  }

  private evalUnary(op: "-" | "not" | "+", v: JassValue): JassValue {
    if (op === "not") return jBool(!truthy(v));
    if (op === "+") return v;
    return v.k === "real" ? jReal(-v.n) : jInt(-asInt(v)); // negate, preserving kind
  }

  private evalBinary(e: Extract<Expr, { kind: "binary" }>, frame: Frame | null): JassValue {
    // and/or: JASS evaluates BOTH sides (no short-circuit) — do the same.
    if (e.op === "and") return jBool(truthy(this.eval(e.left, frame)) && truthy(this.eval(e.right, frame)));
    if (e.op === "or") return jBool(truthy(this.eval(e.left, frame)) || truthy(this.eval(e.right, frame)));

    const l = this.eval(e.left, frame);
    const r = this.eval(e.right, frame);
    switch (e.op) {
      case "==":
        return jBool(jassEquals(l, r));
      case "!=":
        return jBool(!jassEquals(l, r));
      case "<":
        return jBool(asNum(l) < asNum(r));
      case ">":
        return jBool(asNum(l) > asNum(r));
      case "<=":
        return jBool(asNum(l) <= asNum(r));
      case ">=":
        return jBool(asNum(l) >= asNum(r));
      case "+":
        if (l.k === "string" || r.k === "string") return jStr(asStr(l) + asStr(r));
        return this.arith(l, r, (a, b) => a + b);
      case "-":
        return this.arith(l, r, (a, b) => a - b);
      case "*":
        return this.arith(l, r, (a, b) => a * b);
      case "/":
        return this.divide(l, r);
    }
  }

  /** +,-,* : integer if BOTH operands are integers, else real (JASS widening). */
  private arith(l: JassValue, r: JassValue, f: (a: number, b: number) => number): JassValue {
    const bothInt = l.k === "int" && r.k === "int";
    const val = f(asNum(l), asNum(r));
    return bothInt ? jInt(val) : jReal(val);
  }

  /** `/` : integer/integer is TRUNCATING integer division; any real operand makes
   *  it real division. Divide-by-zero yields 0 (JASS doesn't propagate Inf/NaN). */
  private divide(l: JassValue, r: JassValue): JassValue {
    const b = asNum(r);
    if (l.k === "int" && r.k === "int") return jInt(b === 0 ? 0 : Math.trunc(asNum(l) / b));
    return jReal(b === 0 ? 0 : asNum(l) / b);
  }

  /** Load, register natives, then initialise globals — the standard boot for a set
   *  of programs (common.j, blizzard.j, war3map.j). Native registration is done by
   *  the caller between load() and initGlobals(); this helper just runs a program. */
  run(fnName: string, args: JassValue[] = []): JassValue {
    return this.callFunction(fnName, args);
  }
}

/** Non-error control-flow token for `exitwhen` (thrown to unwind out of loop body). */
class ExitLoop {}
const EXIT_LOOP = new ExitLoop();
