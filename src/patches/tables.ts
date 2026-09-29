// Rewriting one of the game's tables with a patch's rows (docs/patches.md, issue #160).
//
// A patch is stated in the game's OWN terms — a file, a row id, a column or key, a value — so
// applying one is a matter of editing the file the way the World Editor's own exporter would
// have written it, and handing the result to every reader unchanged. Two formats cover every
// table a balance patch has touched:
//
//   • SLK (`Units\UnitBalance.slk`, `AbilityData.slk`, `ItemData.slk`, …): a sparse grid of
//     `C;X<col>;Y<row>;K<value>` records whose FIRST row names the columns and whose FIRST
//     column is the row id. A column is addressed by its header, case-insensitively, because the
//     readers fold case too (MappedData lower-cases every key).
//   • INI-shaped TXT (`*UnitFunc.txt`, `*Strings.txt`, `MiscGame.txt`): `[id]` sections of
//     `Key=Value` lines.
//
// Everything here is pure text work on the file's bytes, read as windows-1252 — the encoding the
// whole data layer decodes these files with (data/units.ts `TextDecoder("windows-1252")`).

/** A value a patch writes: a number or a string, exactly as the file would spell it (a string
 *  keeps its own quotes in a TXT, e.g. an Ubertip with a comma in it), `null` to REMOVE the cell
 *  or key, or a list of text REPLACEMENTS made in the value the file already has.
 *
 *  The replacements are how a patch corrects a number a tooltip spells out ("Heals 300 hit
 *  points" → 150) without the repository ever holding the sentence: the text is the install's,
 *  and only the two fragments are ours. OpenWar3 ships zero Blizzard text (CLAUDE.md). Each pair
 *  must match at least once, or the edit is reported (the tooltip is not what the patch thinks). */
export type PatchValue = number | string | null | Replace;
export interface Replace {
  replace: [string, string][];
}

export function isReplace(v: unknown): v is Replace {
  return typeof v === "object" && v !== null && Array.isArray((v as Replace).replace);
}

/** `text` with every pair replaced, and the pairs that matched nothing. */
export function applyReplace(text: string, edit: Replace): { text: string; missed: string[] } {
  const missed: string[] = [];
  for (const [from, to] of edit.replace) {
    if (!text.includes(from)) missed.push(from);
    else text = text.split(from).join(to);
  }
  return { text, missed };
}

/** One row's edit. `$base` names a row IN THE SAME FILE to copy before the edit is laid on —
 *  how a patch ADDS a row (Blizzard adds new ids rather than editing old ones, docs/patches.md). */
export type RowEdit = { $base?: string } & { [column: string]: PatchValue | undefined };

/** A file's edits: row id → edit, or `null` to remove the row. */
export type FileEdits = Record<string, RowEdit | null>;

/** Something the rewrite could not do — an unknown column, a `$base` that is not in the file.
 *  Collected rather than thrown, so a running game still gets every edit that DID apply, and
 *  tools/patch-check.cjs turns each one into a failure. */
export interface PatchProblem {
  file: string;
  row: string;
  message: string;
}

// ---------------------------------------------------------------------------------------------
// windows-1252 ↔ bytes. A file is decoded byte-for-char (latin1-style) so the round trip is
// LOSSLESS whatever it holds; only the text a patch writes is encoded, through the real
// windows-1252 table for the 27 characters it moves out of 0x80–0x9F.

const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

function binaryToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** A patch's own text, as the byte-per-char string the file was decoded into. */
function encodeValue(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c < 0x100)) out += ch;
    else out += String.fromCharCode(CP1252_HIGH[c] ?? 0x3f); // "?" — the file cannot hold it
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// SLK

/** A sparse grid: row index → column index → the RAW `K` token (`"text"` keeps its quotes). */
type Grid = Map<number, Map<number, string>>;

/** Parse the way mdx-m3-viewer's SlkFile does (parsers/slk/file.js): every line but `B` may
 *  move the cursor with `X`/`Y`, and a `K` writes the cell under it. The raw token is kept, so
 *  a cell nobody edits is written back byte-identical. */
function parseSlk(text: string): { head: string; grid: Grid } {
  const grid: Grid = new Map();
  let head = "ID;PWXL;N;E";
  let x = 0;
  let y = 0;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("ID")) {
      head = line;
      continue;
    }
    if (line[0] === "B") continue;
    for (const token of line.split(";")) {
      const op = token[0];
      const value = token.substring(1).trim();
      if (op === "X") x = parseInt(value, 10) - 1;
      else if (op === "Y") y = parseInt(value, 10) - 1;
      else if (op === "K") {
        let row = grid.get(y);
        if (!row) grid.set(y, (row = new Map()));
        row.set(x, value);
      }
    }
  }
  return { head, grid };
}

function unquote(raw: string | undefined): string {
  if (raw === undefined) return "";
  return raw[0] === '"' ? raw.slice(1, -1) : raw;
}

function slkToken(value: number | string): string {
  return typeof value === "number" ? String(value) : `"${encodeValue(value)}"`;
}

function writeSlk(head: string, grid: Grid): string {
  const rows = [...grid.keys()].sort((a, b) => a - b);
  let width = 0;
  for (const r of rows) for (const c of grid.get(r)!.keys()) width = Math.max(width, c + 1);
  const height = rows.length ? rows[rows.length - 1] + 1 : 0;
  const lines = [head, `B;X${width};Y${height};D0`];
  for (const r of rows) {
    const cells = grid.get(r)!;
    let first = true;
    for (const c of [...cells.keys()].sort((a, b) => a - b)) {
      lines.push(first ? `C;X${c + 1};Y${r + 1};K${cells.get(c)}` : `C;X${c + 1};K${cells.get(c)}`);
      first = false;
    }
  }
  lines.push("E");
  return lines.join("\r\n") + "\r\n";
}

function patchSlk(file: string, text: string, edits: FileEdits, problems: PatchProblem[]): string {
  const { head, grid } = parseSlk(text);
  const header = grid.get(0) ?? new Map<number, string>();
  const columns = new Map<string, number>();
  for (const [c, raw] of header) columns.set(unquote(raw).toLowerCase(), c);
  const rowOf = new Map<string, number>();
  let last = 0;
  for (const [r, cells] of grid) {
    last = Math.max(last, r);
    if (r === 0) continue;
    const id = unquote(cells.get(0));
    if (id) rowOf.set(id, r); // a later duplicate wins, as MappedData lets it
  }

  for (const [id, edit] of Object.entries(edits)) {
    let r = rowOf.get(id);
    if (edit === null) {
      if (r !== undefined) grid.delete(r);
      else problems.push({ file, row: id, message: "removes a row the file does not have" });
      continue;
    }
    if (r === undefined) {
      r = ++last;
      const base = edit.$base !== undefined ? rowOf.get(edit.$base) : undefined;
      if (edit.$base !== undefined && base === undefined) problems.push({ file, row: id, message: `$base "${edit.$base}" is not a row of this file` });
      const cells = new Map(base !== undefined ? grid.get(base)! : []);
      cells.set(0, slkToken(id));
      grid.set(r, cells);
      rowOf.set(id, r);
    } else if (edit.$base !== undefined) {
      problems.push({ file, row: id, message: `$base on a row the file already has` });
    }
    const cells = grid.get(r)!;
    for (const [key, value] of Object.entries(edit)) {
      if (key === "$base" || value === undefined) continue;
      const c = columns.get(key.toLowerCase());
      if (c === undefined) {
        problems.push({ file, row: id, message: `no column "${key}"` });
        continue;
      }
      if (c === 0) {
        problems.push({ file, row: id, message: "the id column is the row's key, not an edit" });
        continue;
      }
      if (value === null) cells.delete(c);
      else if (isReplace(value)) {
        const raw = cells.get(c);
        const { text, missed } = applyReplace(unquote(raw), value);
        for (const m of missed) problems.push({ file, row: id, message: `"${key}" has no "${m}" to replace` });
        cells.set(c, raw !== undefined && raw[0] !== '"' && /^-?[\d.]+$/.test(text) ? text : slkToken(text));
      } else cells.set(c, slkToken(value as number | string));
    }
  }
  return writeSlk(head, grid);
}

// ---------------------------------------------------------------------------------------------
// TXT

interface Section {
  id: string;
  /** Index of the `[id]` line; the section's keys run to the next header. */
  at: number;
}

function patchTxt(file: string, text: string, edits: FileEdits, problems: PatchProblem[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const header = /^\s*\[([^\]]*)\]/;

  const sections = (): Section[] => {
    const out: Section[] = [];
    lines.forEach((line, at) => {
      const m = header.exec(line);
      if (m) out.push({ id: m[1], at });
    });
    return out;
  };
  const end = (all: Section[], s: Section): number => {
    const next = all.find((o) => o.at > s.at);
    let stop = next ? next.at : lines.length;
    while (stop > s.at + 1 && lines[stop - 1].trim() === "") stop--; // keep the blank line between sections
    return stop;
  };
  /** Every key line of `[id]`, across every occurrence of the section, as the INI reader would
   *  merge them (a later line wins). */
  const keyLines = (all: Section[], id: string): Map<string, number[]> => {
    const out = new Map<string, number[]>();
    for (const s of all.filter((o) => o.id === id)) {
      for (let i = s.at + 1; i < end(all, s); i++) {
        const eq = lines[i].indexOf("=");
        if (eq <= 0 || lines[i].trimStart().startsWith("//")) continue;
        const key = lines[i].slice(0, eq).trim().toLowerCase();
        out.set(key, [...(out.get(key) ?? []), i]);
      }
    }
    return out;
  };

  for (const [id, edit] of Object.entries(edits)) {
    let all = sections();
    const own = all.filter((s) => s.id === id);
    if (edit === null) {
      if (!own.length) problems.push({ file, row: id, message: "removes a section the file does not have" });
      for (const s of own.reverse()) lines.splice(s.at, end(all, s) - s.at);
      continue;
    }
    if (!own.length) {
      const copied: string[] = [];
      if (edit.$base !== undefined) {
        const base = keyLines(all, edit.$base);
        if (!all.some((s) => s.id === edit.$base)) problems.push({ file, row: id, message: `$base "${edit.$base}" is not a section of this file` });
        for (const at of [...base.values()].map((v) => v[v.length - 1]).sort((a, b) => a - b)) copied.push(lines[at]);
      }
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push("", `[${encodeValue(id)}]`, ...copied, "");
      all = sections();
    } else if (edit.$base !== undefined) {
      problems.push({ file, row: id, message: "$base on a section the file already has" });
    }
    for (const [key, value] of Object.entries(edit)) {
      if (key === "$base" || value === undefined) continue;
      const have = keyLines(all, id).get(key.toLowerCase()) ?? [];
      if (value === null) {
        if (!have.length) problems.push({ file, row: id, message: `removes a key "${key}" the section does not have` });
        for (const at of have.reverse()) lines.splice(at, 1);
      } else if (isReplace(value)) {
        if (!have.length) {
          problems.push({ file, row: id, message: `no key "${key}" to replace in` });
          continue;
        }
        const at = have[have.length - 1];
        const eq = lines[at].indexOf("=");
        // The replacement text is ours and ASCII; the line around it is the file's, untouched.
        const { text, missed } = applyReplace(lines[at].slice(eq + 1), { replace: value.replace.map(([a, b]) => [encodeValue(a), encodeValue(b)]) });
        for (const m of missed) problems.push({ file, row: id, message: `"${key}" has no "${m}" to replace` });
        lines[at] = `${lines[at].slice(0, eq)}=${text}`;
      } else if (have.length) {
        const at = have[have.length - 1];
        const name = lines[at].slice(0, lines[at].indexOf("="));
        lines[at] = `${name}=${encodeValue(String(value))}`;
      } else {
        const last = all.filter((s) => s.id === id).pop()!;
        lines.splice(end(all, last), 0, `${encodeValue(key)}=${encodeValue(String(value))}`);
      }
      all = sections();
    }
  }
  return lines.join(eol);
}

/** Is this a table the rewrite knows how to edit? */
export function patchableFile(path: string): boolean {
  return /\.(slk|txt)$/i.test(path);
}

/**
 * Apply a file's edits to its bytes. `problems` collects everything that did not apply.
 *
 * `folded` is for the chain's COMPOSED edit (src/patches/index.ts): a key one release sets and a
 * later one removes folds to a removal of something the install never had, which is the right
 * answer, not a problem. Each release on its own is still checked strictly
 * (tools/patch-check.cjs), and that the folded chain reads the same as the step-by-step one.
 */
export function patchTable(path: string, bytes: Uint8Array, edits: FileEdits, problems: PatchProblem[] = [], folded = false): Uint8Array {
  const text = bytesToBinary(bytes);
  const found: PatchProblem[] = [];
  const out = /\.slk$/i.test(path) ? patchSlk(path, text, edits, found) : patchTxt(path, text, edits, found);
  problems.push(...(folded ? found.filter((p) => !p.message.startsWith("removes ")) : found));
  return binaryToBytes(out);
}
