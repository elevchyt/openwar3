// war3map.wts — the map's trigger-string table (Phase 7 — issue #33).
//
// The World Editor doesn't inline authored strings into the compiled war3map.j; it
// emits placeholders like "TRIGSTR_019" and ships the real text in war3map.wts, a
// simple text table the engine resolves at map load. So a "Game - Display text"
// action whose message reads "The gates have been opened..." compiles to
// `DisplayTextToForce(..., "TRIGSTR_019")` — without the wts we'd show the raw key.
//
// Format (one entry per string):
//   STRING 19
//   // optional comment lines
//   {
//   The gates have been opened...   (one or more lines)
//   }

/** Parse a war3map.wts into id → text. Tolerant of comment lines between the
 *  `STRING n` header and its `{`, of a leading BOM, and of CRLF line endings. */
export function parseWts(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const m = /^STRING\s+(\d+)/.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const id = parseInt(m[1], 10);
    i++;
    // Skip comment/blank lines up to the opening brace.
    while (i < lines.length && lines[i].trim() !== "{") i++;
    if (i >= lines.length) break;
    i++; // consume "{"
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== "}") body.push(lines[i++]);
    i++; // consume "}"
    out.set(id, body.join("\n"));
  }
  return out;
}
