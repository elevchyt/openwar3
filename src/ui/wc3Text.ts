// Warcraft III text markup. Every tooltip string the game ships — a unit's `Tip`
// ("Train |cffffcc00P|reasant"), an ability's `Ubertip` ("… |n|n|cffffcc00Attacks
// land units.|r") — is authored with this markup, and the tooltip's look IS the
// markup. So the data layer keeps the codes and the HUD renders them here rather
// than flattening them to plain text (issue #50).
//
// Codes (verified against Units\*Strings.txt and UI\FrameDef\GlobalStrings.fdf):
//   |cAARRGGBB   open a colour span (alpha byte is ignored, as in-game)
//   |r           close the innermost colour span
//   |n           line break
// `|C`/`|R`/`|N` occur in the data too (GlobalStrings uses both cases).

const CODE = /\|([cC])([0-9a-fA-F]{8})|\|[rR]|\|[nN]/g;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** Render WC3 markup as HTML. Unclosed colour spans are closed at the end, the way
 *  the game's own renderer lets a `|c` run to the end of the string. */
export function wc3ToHtml(raw: string): string {
  let html = "";
  let open = 0;
  let last = 0;
  CODE.lastIndex = 0;
  for (let m = CODE.exec(raw); m; m = CODE.exec(raw)) {
    html += escapeHtml(raw.slice(last, m.index));
    last = CODE.lastIndex;
    if (m[1]) {
      html += `<span style="color:#${m[2].slice(2)}">`; // drop the leading alpha byte
      open++;
    } else if (m[0][1] === "r" || m[0][1] === "R") {
      if (open > 0) {
        html += "</span>";
        open--;
      }
    } else {
      html += "<br>";
    }
  }
  html += escapeHtml(raw.slice(last));
  return html + "</span>".repeat(open);
}

/**
 * The colour/line markup gone and NOTHING else touched — in particular, runs of spaces kept.
 *
 * This is the string a TEXT frame actually draws: `paintText` renders with `white-space:
 * pre-wrap`, so every space in the file is a space on screen. It matters for MEASURING one
 * (ui/fdf/render.ts): `Loading.fdf`'s bar caption is the literal "L  O  A  D  I  N  G", and a
 * box measured against its collapsed twin is six spaces too narrow — which wraps the very
 * caption it was measured for onto two lines.
 */
export function wc3StripMarkup(raw: string): string {
  return raw
    .replace(/\|[cC][0-9a-fA-F]{8}/g, "")
    .replace(/\|[rR]/g, "")
    .replace(/\|[nN]/g, " ");
}

/** Strip the markup down to a single plain line (for `title=` attributes and any
 *  surface that can't take HTML). */
export function wc3ToPlain(raw: string): string {
  return wc3StripMarkup(raw).replace(/\s+/g, " ").trim();
}
