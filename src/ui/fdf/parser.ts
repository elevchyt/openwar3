// WC3 FrameDef (.fdf) parser — issue #54. The game's whole glue/UI layer is a set
// of .fdf files under `UI\FrameDef\` (indexed by `FrameDef.toc`): a declarative,
// C-ish frame language. `Game.dll` calls this the `frame`/`framedef`/`fdfile` system
// (see docs/reverse-engineering/game-dll-thread.md), so we mirror the names.
//
// Grammar (verified by sweeping all 86 shipped .fdf files in the 1.27a MPQs):
//   IncludeFile "path",
//   StringList { KEY "value", ... }
//   Frame "TYPE" "Name" [INHERITS [WITHCHILDREN] "Template"] { ...body... }
//   Texture ["Name"] [INHERITS "Template"] { ...body... }   // name optional
//   String  "Name"  [INHERITS "Template"] { ...body... }
//   Layer   "NAME" { ...body... }
//   <PropertyKeyword> <arg> <arg> ... ,                     // args space/comma separated
//
// The one parse ambiguity is that commas separate BOTH arguments and statements
// (`SetPoint TOPLEFT, "P", TOPLEFT, 0.1, 0.2,`). We resolve it with a fact proven
// against the corpus: the ONLY bare identifiers that ever appear in argument
// position are a closed set (frame points + text justifications + INHERITS/
// WITHCHILDREN). So a statement's arguments run until the next `}` or the next
// identifier that is NOT one of those — that identifier starts the next statement.

/** A parsed argument value: quoted string, number, or a bareword enum. */
export interface Arg {
  /** Raw text (unquoted for strings, the identifier for enums, the digits for numbers). */
  readonly s: string;
  /** Numeric value when the token was a number, else null. */
  readonly n: number | null;
  /** True when the token was a quoted string. */
  readonly str: boolean;
}

/** One property line: a keyword and its arguments (a keyword may repeat, e.g. SetPoint). */
export interface FdfProp {
  readonly key: string;
  readonly args: Arg[];
}

/** A frame definition (also used for Texture/String/Layer, distinguished by `type`). */
export interface FdfFrame {
  /** Frame type: FRAME, BACKDROP, TEXT, GLUETEXTBUTTON, TEXTURE, STRING, LAYER, … (upper-cased). */
  type: string;
  /** Frame name; "" for anonymous Texture/Layer blocks. */
  name: string;
  /** Template this frame INHERITS, or null. */
  inherits: string | null;
  /** INHERITS WITHCHILDREN — also clone the template's child frames. */
  withChildren: boolean;
  props: FdfProp[];
  children: FdfFrame[];
}

/** The result of parsing one .fdf file (before includes are merged). */
export interface FdfFile {
  frames: FdfFrame[];
  strings: Map<string, string>;
  includes: string[];
}

// The closed set of barewords that may appear as arguments (proven complete across
// the shipped corpus). Anything else in a value slot is the next statement keyword.
const ARG_WORDS = new Set([
  "TOPLEFT", "TOP", "TOPRIGHT", "LEFT", "CENTER", "RIGHT", "BOTTOMLEFT", "BOTTOM", "BOTTOMRIGHT",
  "JUSTIFYLEFT", "JUSTIFYCENTER", "JUSTIFYRIGHT", "JUSTIFYTOP", "JUSTIFYMIDDLE", "JUSTIFYBOTTOM",
  "INHERITS", "WITHCHILDREN",
]);

const BLOCK_KEYWORDS = new Set(["Frame", "Texture", "String", "Layer"]);

type TokKind = "str" | "id" | "num" | "punct";
interface Token { kind: TokKind; value: string; num: number }

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // whitespace
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    // comments
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    // string
    if (c === '"') {
      i++;
      let s = "";
      while (i < n && src[i] !== '"') { s += src[i]; i++; }
      i++; // closing quote
      out.push({ kind: "str", value: s, num: 0 });
      continue;
    }
    // punctuation
    if (c === "{" || c === "}" || c === ",") { out.push({ kind: "punct", value: c, num: 0 }); i++; continue; }
    // number: digit, or leading '.' , or '-' followed by digit/dot
    const isNumStart = (ch: string) => ch >= "0" && ch <= "9";
    if (isNumStart(c) || c === "." || (c === "-" && (isNumStart(src[i + 1]) || src[i + 1] === "."))) {
      let s = c; i++;
      while (i < n && /[0-9.eE+\-]/.test(src[i])) { s += src[i]; i++; }
      if (src[i] === "f" || src[i] === "F") i++; // 0.002f suffix
      out.push({ kind: "num", value: s, num: parseFloat(s) });
      continue;
    }
    // identifier / keyword
    if (/[A-Za-z_]/.test(c)) {
      let s = c; i++;
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) { s += src[i]; i++; }
      out.push({ kind: "id", value: s, num: 0 });
      continue;
    }
    i++; // skip anything unexpected
  }
  return out;
}

/** Parse one .fdf source into frames, a StringList table, and IncludeFile paths. */
export function parseFdf(src: string): FdfFile {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Token | undefined => toks[p];

  const toArg = (t: Token): Arg =>
    t.kind === "str" ? { s: t.value, n: null, str: true }
      : t.kind === "num" ? { s: t.value, n: t.num, str: false }
        : { s: t.value, n: null, str: false };

  // Collect arguments until the next `}`/EOF or a non-arg identifier (next keyword).
  function readArgs(): Arg[] {
    const args: Arg[] = [];
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.kind === "punct") {
        if (t.value === ",") { p++; continue; } // comma is just a separator here
        break; // '{' or '}'
      }
      if (t.kind === "id" && !ARG_WORDS.has(t.value)) break; // next statement keyword
      args.push(toArg(t));
      p++;
    }
    return args;
  }

  const file: FdfFile = { frames: [], strings: new Map(), includes: [] };

  // Parse a `{ ... }` body into props + child frames.
  function parseBody(into: FdfFrame): void {
    if (peek()?.value !== "{") return;
    p++; // consume '{'
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.kind === "punct" && t.value === "}") { p++; break; }
      if (t.kind === "punct" && t.value === ",") { p++; continue; }
      if (t.kind === "id" && BLOCK_KEYWORDS.has(t.value)) {
        into.children.push(parseBlock());
        continue;
      }
      // property statement
      if (t.kind === "id") {
        const key = t.value; p++;
        const args = readArgs();
        into.props.push({ key, args });
        continue;
      }
      p++; // stray token — skip
    }
  }

  // Parse `Frame "TYPE" "Name" [INHERITS [WITHCHILDREN] "Tmpl"] { }` and the
  // Texture/String/Layer variants (Texture may be anonymous; Layer has no template).
  function parseBlock(): FdfFrame {
    const kw = peek()!.value; p++; // Frame / Texture / String / Layer
    const frame: FdfFrame = { type: "", name: "", inherits: null, withChildren: false, props: [], children: [] };
    if (kw === "Frame") {
      frame.type = (peek()?.kind === "str" ? peek()!.value : "").toUpperCase(); p++;
      frame.name = peek()?.kind === "str" ? peek()!.value : ""; if (peek()?.kind === "str") p++;
    } else {
      frame.type = kw.toUpperCase(); // TEXTURE / STRING / LAYER
      if (peek()?.kind === "str") { frame.name = peek()!.value; p++; }
    }
    if (peek()?.kind === "id" && peek()!.value === "INHERITS") {
      p++;
      if (peek()?.kind === "id" && peek()!.value === "WITHCHILDREN") { frame.withChildren = true; p++; }
      if (peek()?.kind === "str") { frame.inherits = peek()!.value; p++; }
    }
    parseBody(frame);
    return frame;
  }

  // Top level.
  for (;;) {
    const t = peek();
    if (!t) break;
    if (t.kind === "punct") { p++; continue; }
    if (t.kind === "id" && t.value === "IncludeFile") {
      p++;
      if (peek()?.kind === "str") { file.includes.push(peek()!.value); p++; }
      continue;
    }
    if (t.kind === "id" && t.value === "StringList") {
      p++;
      if (peek()?.value === "{") {
        p++;
        for (;;) {
          const k = peek();
          if (!k || (k.kind === "punct" && k.value === "}")) { if (k) p++; break; }
          if (k.kind === "punct") { p++; continue; }
          if (k.kind === "id") {
            const key = k.value; p++;
            const args = readArgs();
            if (args.length) file.strings.set(key, args[0].s);
          } else p++;
        }
      }
      continue;
    }
    if (t.kind === "id" && BLOCK_KEYWORDS.has(t.value)) { file.frames.push(parseBlock()); continue; }
    p++; // unknown top-level token
  }

  return file;
}
