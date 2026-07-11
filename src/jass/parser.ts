// JASS recursive-descent parser (Phase 7 — issue #33; see docs/triggers.md).
//
// Produces a JassProgram (globals + native decls + function decls) from a token
// stream. The grammar is the full JASS2 language — small enough to hand-write:
// globals blocks, native/function declarations, and the six statement forms
// (set/call/if/loop/exitwhen/return) over a standard precedence-climbing
// expression grammar. Operator precedence (low→high): or, and, comparisons,
// +/-, *//, unary (-,+,not). See the JASS Manual BNF in docs/REFERENCES.md.

import type { BinOp, Expr, FunctionDecl, JassProgram, NativeDecl, Param, Stmt, VarDecl } from "./ast";
import { tokenize, type Token } from "./lexer";

export class JassParseError extends Error {
  constructor(message: string, public line: number) {
    super(`JASS parse error (line ${line}): ${message}`);
  }
}

const CMP_OPS = new Set(["==", "!=", "<", ">", "<=", ">="]);

class Parser {
  private p = 0;
  constructor(private t: Token[]) {}

  private peek(o = 0): Token {
    return this.t[Math.min(this.p + o, this.t.length - 1)];
  }
  private next(): Token {
    return this.t[this.p++];
  }
  private isKw(w: string, o = 0): boolean {
    const tok = this.peek(o);
    return tok.kind === "id" && tok.value === w;
  }
  private isOp(w: string, o = 0): boolean {
    const tok = this.peek(o);
    return tok.kind === "op" && tok.value === w;
  }
  private eat(kind: string, value?: string): boolean {
    const tok = this.peek();
    const ok = tok.kind === kind && (value === undefined || tok.value === value);
    if (ok) this.p++;
    return ok;
  }
  private expectOp(w: string): void {
    if (!this.eat("op", w)) throw new JassParseError(`expected '${w}', got '${this.peek().value}'`, this.peek().line);
  }
  private expectKw(w: string): void {
    if (!(this.isKw(w) && this.eat("id", w))) throw new JassParseError(`expected '${w}', got '${this.peek().value}'`, this.peek().line);
  }
  private expectId(): string {
    const tok = this.peek();
    if (tok.kind !== "id") throw new JassParseError(`expected identifier, got '${tok.value}'`, tok.line);
    this.p++;
    return tok.value;
  }
  private skipNewlines(): void {
    while (this.peek().kind === "newline") this.p++;
  }
  /** End of a single-line construct: a newline or EOF. */
  private endLine(): void {
    if (this.peek().kind === "newline") this.p++;
    else if (this.peek().kind !== "eof") {
      // Tolerate trailing junk on a line rather than derail — advance to the newline.
      while (this.peek().kind !== "newline" && this.peek().kind !== "eof") this.p++;
      if (this.peek().kind === "newline") this.p++;
    }
  }

  parse(): JassProgram {
    const prog: JassProgram = { globals: [], natives: [], functions: [] };
    while (this.peek().kind !== "eof") {
      this.skipNewlines();
      if (this.peek().kind === "eof") break;
      if (this.isKw("globals")) {
        this.parseGlobals(prog.globals);
      } else if (this.isKw("type")) {
        this.endLine(); // `type X extends Y` — type hierarchy is documentation to us; skip
      } else {
        let isConstant = false;
        if (this.isKw("constant")) {
          this.next();
          isConstant = true;
        }
        if (this.isKw("native")) {
          prog.natives.push(this.parseNative(isConstant));
        } else if (this.isKw("function")) {
          prog.functions.push(this.parseFunction(isConstant));
        } else {
          this.endLine(); // unknown top-level line — skip defensively
        }
      }
    }
    return prog;
  }

  private parseGlobals(out: VarDecl[]): void {
    this.expectKw("globals");
    this.endLine();
    while (true) {
      this.skipNewlines();
      if (this.isKw("endglobals")) {
        this.next();
        break;
      }
      if (this.peek().kind === "eof") break;
      out.push(this.parseVarDecl(true));
    }
  }

  /** A global or local variable declaration line: `[constant] TYPE [array] NAME [= expr]`. */
  private parseVarDecl(allowConstant: boolean): VarDecl {
    let isConstant = false;
    if (allowConstant && this.isKw("constant")) {
      this.next();
      isConstant = true;
    }
    const type = this.expectId();
    const isArray = this.isKw("array") && this.eat("id", "array");
    const name = this.expectId();
    let init: Expr | undefined;
    if (this.isOp("=")) {
      this.next();
      init = this.parseExpr();
    }
    this.endLine();
    return { type, name, isArray, isConstant, init };
  }

  private parseParams(): Param[] {
    this.expectKw("takes");
    if (this.isKw("nothing")) {
      this.next();
      return [];
    }
    const params: Param[] = [];
    do {
      const type = this.expectId();
      const name = this.expectId();
      params.push({ type, name });
    } while (this.eat("op", ","));
    return params;
  }

  private parseReturnType(): string {
    this.expectKw("returns");
    if (this.isKw("nothing")) {
      this.next();
      return "nothing";
    }
    return this.expectId();
  }

  private parseNative(isConstant: boolean): NativeDecl {
    this.expectKw("native");
    const name = this.expectId();
    const params = this.parseParams();
    const returns = this.parseReturnType();
    this.endLine();
    return { name, params, returns, isConstant };
  }

  private parseFunction(isConstant: boolean): FunctionDecl {
    this.expectKw("function");
    const name = this.expectId();
    const params = this.parseParams();
    const returns = this.parseReturnType();
    this.endLine();
    const locals: VarDecl[] = [];
    const body: Stmt[] = [];
    while (true) {
      this.skipNewlines();
      if (this.isKw("endfunction")) {
        this.next();
        break;
      }
      if (this.peek().kind === "eof") break;
      if (this.isKw("local")) {
        this.next();
        locals.push(this.parseVarDecl(false));
      } else {
        body.push(this.parseStatement());
      }
    }
    return { name, params, returns, isConstant, locals, body };
  }

  private parseStatement(): Stmt {
    if (this.isKw("debug")) this.next(); // `debug` prefix — run the following statement normally
    if (this.isKw("set")) return this.parseSet();
    if (this.isKw("call")) return this.parseCall();
    if (this.isKw("if")) return this.parseIf();
    if (this.isKw("loop")) return this.parseLoop();
    if (this.isKw("exitwhen")) {
      this.next();
      const cond = this.parseExpr();
      this.endLine();
      return { kind: "exitwhen", cond };
    }
    if (this.isKw("return")) {
      this.next();
      let value: Expr | undefined;
      if (this.peek().kind !== "newline" && this.peek().kind !== "eof") value = this.parseExpr();
      this.endLine();
      return { kind: "return", value };
    }
    throw new JassParseError(`unexpected statement start '${this.peek().value}'`, this.peek().line);
  }

  private parseSet(): Stmt {
    this.expectKw("set");
    const name = this.expectId();
    let index: Expr | undefined;
    if (this.isOp("[")) {
      this.next();
      index = this.parseExpr();
      this.expectOp("]");
    }
    this.expectOp("=");
    const value = this.parseExpr();
    this.endLine();
    return { kind: "set", name, index, value };
  }

  private parseCall(): Stmt {
    this.expectKw("call");
    const name = this.expectId();
    this.expectOp("(");
    const args = this.parseArgs();
    this.expectOp(")");
    this.endLine();
    return { kind: "call", name, args };
  }

  private parseIf(): Stmt {
    this.expectKw("if");
    const branches: Array<{ cond: Expr; body: Stmt[] }> = [];
    let elseBody: Stmt[] | undefined;
    const firstCond = this.parseExpr();
    this.expectKw("then");
    this.endLine();
    branches.push({ cond: firstCond, body: [] });
    let current = branches[0].body;
    while (true) {
      this.skipNewlines();
      if (this.isKw("elseif")) {
        this.next();
        const cond = this.parseExpr();
        this.expectKw("then");
        this.endLine();
        branches.push({ cond, body: [] });
        current = branches[branches.length - 1].body;
      } else if (this.isKw("else")) {
        this.next();
        this.endLine();
        elseBody = [];
        current = elseBody;
      } else if (this.isKw("endif")) {
        this.next();
        this.endLine();
        break;
      } else if (this.peek().kind === "eof") {
        break;
      } else {
        current.push(this.parseStatement());
      }
    }
    return { kind: "if", branches, elseBody };
  }

  private parseLoop(): Stmt {
    this.expectKw("loop");
    this.endLine();
    const body: Stmt[] = [];
    while (true) {
      this.skipNewlines();
      if (this.isKw("endloop")) {
        this.next();
        this.endLine();
        break;
      }
      if (this.peek().kind === "eof") break;
      body.push(this.parseStatement());
    }
    return { kind: "loop", body };
  }

  private parseArgs(): Expr[] {
    const args: Expr[] = [];
    if (this.isOp(")")) return args;
    do {
      args.push(this.parseExpr());
    } while (this.eat("op", ","));
    return args;
  }

  // --- expressions (precedence climbing) ------------------------------------
  private parseExpr(): Expr {
    return this.parseOr();
  }
  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isKw("or")) {
      this.next();
      left = { kind: "binary", op: "or", left, right: this.parseAnd() };
    }
    return left;
  }
  private parseAnd(): Expr {
    let left = this.parseCmp();
    while (this.isKw("and")) {
      this.next();
      left = { kind: "binary", op: "and", left, right: this.parseCmp() };
    }
    return left;
  }
  private parseCmp(): Expr {
    let left = this.parseAdd();
    while (this.peek().kind === "op" && CMP_OPS.has(this.peek().value)) {
      const op = this.next().value as BinOp;
      left = { kind: "binary", op, left, right: this.parseAdd() };
    }
    return left;
  }
  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().value as BinOp;
      left = { kind: "binary", op, left, right: this.parseMul() };
    }
    return left;
  }
  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = this.next().value as BinOp;
      left = { kind: "binary", op, left, right: this.parseUnary() };
    }
    return left;
  }
  private parseUnary(): Expr {
    if (this.isKw("not")) {
      this.next();
      return { kind: "unary", op: "not", expr: this.parseUnary() };
    }
    if (this.isOp("-")) {
      this.next();
      return { kind: "unary", op: "-", expr: this.parseUnary() };
    }
    if (this.isOp("+")) {
      this.next();
      return { kind: "unary", op: "+", expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): Expr {
    const tok = this.peek();
    if (tok.kind === "int") {
      this.next();
      return { kind: "int", value: tok.num ?? 0 };
    }
    if (tok.kind === "real") {
      this.next();
      return { kind: "real", value: tok.num ?? 0 };
    }
    if (tok.kind === "string") {
      this.next();
      return { kind: "string", value: tok.str ?? "" };
    }
    if (this.isKw("true") || this.isKw("false")) {
      this.next();
      return { kind: "bool", value: tok.value === "true" };
    }
    if (this.isKw("null")) {
      this.next();
      return { kind: "null" };
    }
    if (this.isKw("function")) {
      this.next();
      return { kind: "code", name: this.expectId() };
    }
    if (this.isOp("(")) {
      this.next();
      const e = this.parseExpr();
      this.expectOp(")");
      return e;
    }
    if (tok.kind === "id") {
      const name = this.next().value;
      if (this.isOp("(")) {
        this.next();
        const args = this.parseArgs();
        this.expectOp(")");
        return { kind: "call", name, args };
      }
      if (this.isOp("[")) {
        this.next();
        const index = this.parseExpr();
        this.expectOp("]");
        return { kind: "index", name, index };
      }
      return { kind: "var", name };
    }
    throw new JassParseError(`unexpected token '${tok.value}'`, tok.line);
  }
}

/** Tokenize + parse JASS source into a JassProgram. Throws JassParseError on a
 *  malformed script (callers that must not crash the game catch it and log). */
export function parseJass(src: string): JassProgram {
  return new Parser(tokenize(src)).parse();
}
