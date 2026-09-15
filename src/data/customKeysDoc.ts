// The hotkey editor's DOCUMENT — a `CustomKeys.txt` being edited, and the tables it is edited
// against (issue #156).
//
// `customKeys.ts` is the READ half: it parses the player's file once and lays it over the game's
// tables at the start of a match. This is the WRITE half, and it cannot share that parser. Two
// things the read half is right to throw away, the write half has to keep:
//
//   · **The file as the player wrote it.** Their comments, their blank lines, the order of their
//     sections, any section the editor has no button for. A CustomKeys.txt is usually written by
//     one of the generators everybody uses and then hand-tuned, so an editor that regenerates the
//     whole file from its own model deletes an evening's work the first time it saves. The
//     document therefore edits the file IN PLACE: a changed field rewrites its own line, a new
//     one goes at the end of its section, and a new section at the end of the file.
//   · **A value's QUOTES.** A per-level list is `Tip=a,b,c`, and a level whose text has a comma
//     of its own is quoted: `Tip="Frost Nova, Level 1","…"`. mdx-m3-viewer's `IniFile` strips a
//     value's first and last character when it starts with a quote — right for a single quoted
//     tip, and it turns a quoted LIST into `a","b","c`. So this reads INI itself, keeps the raw
//     value, and splits a list with `splitList`, which knows what a quote is.
//
// Field names are the eleven `CustomKeyInfo.txt` documents (customKeys.ts `OVERRIDABLE`) and are
// matched lower-cased; SECTION names are matched case-insensitively for the same reason the
// overlay does — the game says `[CmdRally]` and a real file says `[cmdrally]` (docs/hotkeys.md).

/** One `[Section]`: its name as first written, and its fields, lower-cased key → RAW value. */
export interface IniSection {
  name: string;
  fields: Map<string, string>;
}

/** `[Section] Key=Value` text → section (lower-cased) → its fields. Later files and later lines
 *  win, as they do for `MappedData.load`. `//` and `;` are comments, as in the game's own files. */
export function readIni(text: string, into = new Map<string, IniSection>()): Map<string, IniSection> {
  let section: IniSection | null = null;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith(";")) continue;
    const head = /^\[(.+?)\]/.exec(line);
    if (head) {
      const name = head[1].trim();
      const key = name.toLowerCase();
      section = into.get(key) ?? { name, fields: new Map() };
      into.set(key, section);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0 && section) section.fields.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  return into;
}

/**
 * A raw comma list → its entries, quotes removed. `Hotkey=S,S,S` is three; `Tip="a, b","c"` is
 * two. A value with no comma outside quotes is one entry, which is every non-levelled field.
 */
export function splitList(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The other way round. An entry is quoted only when it carries a comma of its own, since that is
 *  the only thing a quote is for — and an unquoted entry is exactly what the game's files write. */
export function joinList(items: readonly string[]): string {
  return items.map((s) => (s.includes(",") ? `"${s}"` : s)).join(",");
}

/**
 * A `CustomKeys.txt` being edited.
 *
 * `get` answers what the player's FILE says (or undefined), `set` records an edit — a string to
 * write, or `null` to take the field back OUT of the file so the game's own value shows through
 * again, which is what "reset to default" means for a file that only overrides. Nothing touches
 * the text until `serialize`.
 */
export class CustomKeysDoc {
  private readonly lines: string[];
  private readonly file: Map<string, IniSection>;
  /** section (lower-cased) → field → the edit. `null` deletes the line. */
  private readonly edits = new Map<string, { name: string; fields: Map<string, string | null> }>();

  constructor(text: string | null) {
    const src = (text ?? "").replace(/^﻿/, "");
    this.lines = src ? src.split(/\r?\n/) : [];
    this.file = readIni(src);
  }

  /** The value the document holds now — an edit if there is one, else the file's. */
  get(section: string, field: string): string | undefined {
    const key = section.toLowerCase();
    const edit = this.edits.get(key)?.fields;
    if (edit?.has(field)) return edit.get(field) ?? undefined;
    return this.file.get(key)?.fields.get(field);
  }

  set(section: string, field: string, value: string | null): void {
    const key = section.toLowerCase();
    let entry = this.edits.get(key);
    if (!entry) {
      entry = { name: this.file.get(key)?.name ?? section, fields: new Map() };
      this.edits.set(key, entry);
    }
    // Setting a field back to exactly what the file already says is not an edit.
    if (value === (this.file.get(key)?.fields.get(field) ?? null)) entry.fields.delete(field);
    else entry.fields.set(field, value);
  }

  /** True once anything would change on save. */
  get dirty(): boolean {
    for (const e of this.edits.values()) if (e.fields.size) return true;
    return false;
  }

  /**
   * The file with every edit applied, CRLF-terminated like every other file in the install.
   *
   * One pass over the original lines: a field line an edit names is rewritten (or dropped), and
   * the edits still unwritten when a section ENDS go in at its end — above the blank lines that
   * separate it from the next section, so the file keeps its shape. Sections the file never had
   * are appended, one blank line apart.
   */
  serialize(): string {
    const out: string[] = [];
    /** Sections whose NEW fields have been written — at their first header, since a field the
     *  file never had cannot be overridden by a later repeat of the section. */
    const added = new Set<string>();
    let current: string | null = null;

    const flush = (): void => {
      if (current === null || added.has(current)) return;
      added.add(current);
      const edits = this.edits.get(current)?.fields;
      const has = this.file.get(current)?.fields;
      if (!edits) return;
      const add = [...edits].filter(([f, v]) => v !== null && !has?.has(f)).map(([f, v]) => `${fieldName(f)}=${v}`);
      // Tuck the new lines in above the section's trailing blank lines — and above any comment
      // that heads the NEXT section ("//attack" over [CmdAttack], as the sample file writes it).
      let at = out.length;
      while (at > 0 && (out[at - 1].trim() === "" || out[at - 1].trim().startsWith("//"))) at--;
      out.splice(at, 0, ...add);
    };

    for (const line of this.lines) {
      const trimmed = line.trim();
      const head = trimmed.startsWith("//") ? null : /^\[(.+?)\]/.exec(trimmed);
      if (head) {
        flush();
        current = head[1].trim().toLowerCase();
        out.push(line);
        continue;
      }
      const eq = trimmed.indexOf("=");
      const edits = current !== null ? this.edits.get(current)?.fields : undefined;
      if (edits && eq > 0 && !trimmed.startsWith("//")) {
        // EVERY line naming the field is rewritten, not only the first: the game reads a
        // repeated key as the later one, so a stale repeat would quietly undo the edit.
        const field = trimmed.slice(0, eq).trim().toLowerCase();
        if (edits.has(field)) {
          const v = edits.get(field);
          if (v !== null && v !== undefined) out.push(`${trimmed.slice(0, eq).trim()}=${v}`);
          continue;
        }
      }
      out.push(line);
    }
    flush();

    const appended = [...this.edits].filter(([key, e]) => !this.file.has(key) && [...e.fields.values()].some((v) => v !== null));
    // Nothing new to append: the file keeps its own ending, blank lines and final newline alike
    // (the split left an empty last line for a file that ended with one).
    if (!appended.length) return out.join("\r\n");
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    for (const [, entry] of appended) {
      if (out.length) out.push("");
      out.push(`[${entry.name}]`);
      for (const [f, v] of entry.fields) if (v !== null) out.push(`${fieldName(f)}=${v}`);
    }
    return `${out.join("\r\n")}\r\n`;
  }
}

/** A lower-cased field back to the spelling `CustomKeyInfo.txt` uses (`Researchhotkey`). */
const fieldName = (f: string): string => f.charAt(0).toUpperCase() + f.slice(1);

/**
 * Text → **windows-1252** bytes, the encoding the file is read in (assets/opfs.ts `readAnsi`).
 * `TextEncoder` only speaks UTF-8, and a UTF-8 "é" read back as 1252 is two characters of
 * mojibake on a French player's tooltip. The 0x80–0x9F block is the only part of 1252 that is
 * not Latin-1; anything outside the code page becomes "?".
 */
export function encodeAnsi(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i] = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : CP1252[c] ?? 0x3f;
  }
  return out;
}

const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** The gold every stock Tip gilds its hotkey letter in (`|cffffcc00M|rove`). */
const GILD = "|cffffcc00";

/**
 * Move the gilding in one tooltip onto a new key.
 *
 * The stock tips gild ONE letter of the name — `|cffffcc00M|rove`, `Holy Ligh|cffffcc00t|r` — and
 * gild longer runs for other reasons (`[|cffffcc00Level 1|r]`), so only a single-character run is
 * taken as the old key. The new one is gilded where it first appears outside any colour run,
 * which is how the game's own tips read; a key the text does not contain is appended in
 * parentheses, the way `CustomKeyInfo.txt`'s own example writes "Train Orc Grunt (T)".
 */
export function retip(tip: string, key: string): string {
  // A generator's style first: the key in parentheses — "(|cffffcc00Q|r) Move" or "Move (Q)".
  // The player chose where it goes, so it stays there and only the letter changes.
  const bracketed = /\((\|c[0-9a-f]{8})?[A-Z0-9](\|r)?\)/i;
  if (bracketed.test(tip)) return tip.replace(bracketed, `(${GILD}${key}|r)`);
  const plain = tip.replace(/\|c[0-9a-f]{8}(.)\|r/gi, "$1");
  const lower = key.toLowerCase();
  let depth = 0;
  for (let i = 0; i < plain.length; i++) {
    if (/^\|c[0-9a-f]{8}/i.test(plain.slice(i, i + 10))) { depth++; i += 9; continue; }
    if (/^\|[rn]/i.test(plain.slice(i, i + 2))) { if (/^\|r/i.test(plain.slice(i, i + 2))) depth = Math.max(0, depth - 1); i += 1; continue; }
    if (plain[i] === "%") { i += 1; continue; } // "%d", the level a learn tip prints
    if (depth === 0 && plain[i].toLowerCase() === lower) {
      return `${plain.slice(0, i)}${GILD}${plain[i]}|r${plain.slice(i + 1)}`;
    }
  }
  return `${plain} (${GILD}${key}|r)`;
}
