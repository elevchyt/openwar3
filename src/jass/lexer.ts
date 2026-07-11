// JASS tokenizer (Phase 7 — issue #33; see docs/triggers.md).
//
// JASS is line-oriented: every statement sits on its own line, so newlines are
// significant tokens (there is no line-continuation in JASS). Comments are `//`
// to end-of-line only — JASS has no block comments. Literals worth calling out:
//   • rawcodes  'hfoo'  — 1–4 chars packed big-endian into a 32-bit integer
//                         ('hfoo' = 0x68666F6F). This is how unit/ability ids are
//                         written; CreateUnit('hfoo', …) is an integer arg.
//   • hex       0xFF  or  $FF   (both integer)
//   • reals     3.14, .5, 3.    — a dot with digits on at least one side
// Verified against the real 1.27a Scripts\common.j / a map's war3map.j.

export type TokenKind =
  | "id" // identifier or keyword (see KEYWORDS)
  | "int"
  | "real"
  | "string"
  | "op" // punctuation / operator: ( ) [ ] , = == != < > <= >= + - * /
  | "newline"
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string; // raw text (for id/op) or decoded value source
  num?: number; // parsed numeric value for int/real
  str?: string; // decoded string contents for string tokens
  line: number;
}

export const KEYWORDS = new Set([
  "globals", "endglobals", "constant", "native", "takes", "returns", "nothing",
  "function", "endfunction", "local", "set", "call", "if", "then", "elseif",
  "else", "endif", "loop", "exitwhen", "endloop", "return", "array", "and", "or",
  "not", "true", "false", "null", "debug", "type", "extends",
]);

const isIdStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/** Pack a 1–4 char rawcode literal into a 32-bit integer, big-endian, exactly as
 *  the WC3 compiler does: 'hfoo' → ('h'<<24)|('f'<<16)|('o'<<8)|'o'. Shorter codes
 *  occupy the low bytes ('A000'…). We keep it unsigned via >>> 0. */
export function rawcodeToInt(code: string): number {
  let n = 0;
  for (let i = 0; i < code.length; i++) n = ((n << 8) | (code.charCodeAt(i) & 0xff)) >>> 0;
  return n;
}

/** Inverse of rawcodeToInt: unpack a 32-bit integer back into its 4-char rawcode
 *  string (e.g. CreateUnit gets 'hfoo' as the int 0x68666F6F; the bridge needs the
 *  string "hfoo" to look up the UnitDef). Trailing NUL bytes are trimmed. */
export function intToRawcode(n: number): string {
  const b = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return b.map((c) => (c === 0 ? "" : String.fromCharCode(c))).join("");
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  const push = (kind: TokenKind, value: string, extra?: Partial<Token>): void => {
    tokens.push({ kind, value, line, ...extra });
  };

  while (i < n) {
    const c = src[i];

    // Newlines (both \n and \r\n collapse to one significant separator).
    if (c === "\n") {
      push("newline", "\n");
      i++;
      line++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    // Horizontal whitespace.
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    // Line comment.
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // String literal.
    if (c === '"') {
      i++;
      let out = "";
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\") {
          const e = src[i + 1];
          out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e ?? "";
          i += 2;
        } else {
          if (src[i] === "\n") line++; // tolerate stray newline in a string
          out += src[i];
          i++;
        }
      }
      i++; // closing quote
      push("string", out, { str: out });
      continue;
    }
    // Rawcode literal 'hfoo' → integer. May contain an escaped char ('\\0' etc.).
    if (c === "'") {
      i++;
      let raw = "";
      while (i < n && src[i] !== "'") {
        if (src[i] === "\\") {
          const e = src[i + 1];
          raw += e === "0" ? "\0" : e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e ?? "";
          i += 2;
        } else {
          raw += src[i];
          i++;
        }
      }
      i++; // closing quote
      push("int", raw, { num: rawcodeToInt(raw) });
      continue;
    }
    // Hex integer: 0x.. or $..
    if ((c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) || c === "$") {
      const start = i;
      i += c === "$" ? 1 : 2;
      let hex = "";
      while (i < n && /[0-9a-fA-F]/.test(src[i])) hex += src[i++];
      push("int", src.slice(start, i), { num: parseInt(hex || "0", 16) >>> 0 });
      continue;
    }
    // Number: integer or real.
    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      const start = i;
      let isReal = false;
      while (i < n && isDigit(src[i])) i++;
      if (src[i] === ".") {
        isReal = true;
        i++;
        while (i < n && isDigit(src[i])) i++;
      }
      const text = src.slice(start, i);
      if (isReal) push("real", text, { num: parseFloat(text) });
      else push("int", text, { num: parseInt(text, 10) });
      continue;
    }
    // Identifier / keyword.
    if (isIdStart(c)) {
      const start = i;
      while (i < n && isIdPart(src[i])) i++;
      push("id", src.slice(start, i));
      continue;
    }
    // Two-char operators.
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
      push("op", two);
      i += 2;
      continue;
    }
    // Single-char operators / punctuation.
    if ("()[],=+-*/<>".includes(c)) {
      push("op", c);
      i++;
      continue;
    }
    // Anything else (rare stray byte) — skip so one odd char can't derail a parse.
    i++;
  }
  push("eof", "");
  return tokens;
}
