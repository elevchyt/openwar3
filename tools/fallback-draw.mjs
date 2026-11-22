// Draw OpenWar3's own fallback art as SVG (src/fallback/README.md, docs/versions.md, issue #319).
//
//   node tools/fallback-draw.mjs        → src/fallback/svg/<WC3 path>.svg
//   node tools/fallback-svg.mjs         → src/fallback/art/<WC3 path>.png   (rasterized)
//   node tools/patch-art.mjs            → src/fallback/art.ts               (the BLPs the game reads)
//
// Every picture here is DRAWN — shapes, gradients and seeded noise written out by this file — and
// none is traced from or sampled out of an install: OpenWar3 ships zero Blizzard art (CLAUDE.md).
// What IS measured off the install is where each piece has to MEET the game's own art, because a
// console side panel sits flush against the console's first and last tile and any step in its
// outline or its brightness there is a visible seam. Those measurements are numbers (rows, mean
// colours of a 6-texel band), stated next to the drawing that uses them, the same way
// `TEAM_COLORS` in src/vfs/derivedArt.ts states the swatches it read.
//
// The drawings are seeded, so a re-run writes the same files.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "src", "fallback", "svg");

// ---------------------------------------------------------------------------------------------
// Small tools

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f = (n) => (Math.round(n * 100) / 100).toString();
const hex = (c) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
const shade = (h, k) => hex(rgb(h).map((v) => v * k));

/** Fine grain that scales what it is applied to by 1 ± `amount`, keeping its alpha. */
function gritFilter(id, { freq = 0.8, octaves = 3, seed = 1, amount = 0.3 } = {}) {
  // fractalNoise sits around 0.5 with a spread of about ±0.2, so k1 = amount × 2.5 maps it onto
  // roughly 1 ± amount once k2 takes the mean back off.
  const k1 = amount * 2.5;
  return `<filter id="${id}" color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}" seed="${seed}" result="n"/>
  <feColorMatrix in="n" type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1" result="g"/>
  <feComposite in="SourceGraphic" in2="g" operator="arithmetic" k1="${f(k1)}" k2="${f(1 - k1 * 0.5)}" k3="0" k4="0" result="m"/>
  <feComposite in="m" in2="SourceGraphic" operator="in"/>
</filter>`;
}

/**
 * The look every raised piece shares — stone, timber, bone, a leaf: its own outline blurred into a
 * height map, roughened by seeded noise, and lit from the top left the way the console's art is.
 * `freq` may be two numbers ("0.02 0.4") to stretch the roughness into grain.
 */
function bevelFilter(id, { blur = 2, scale = 3, freq = "0.06", octaves = 4, rough = 0.35, seed = 1, kd = 1.3, ks = 0.55, exp = 14, el = 48 } = {}) {
  return `<filter id="${id}" color-interpolation-filters="sRGB" x="-5%" y="-5%" width="110%" height="110%">
  <feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}" seed="${seed}" result="noise"/>
  <feGaussianBlur in="SourceAlpha" stdDeviation="${blur}" result="soft"/>
  <feComposite in="noise" in2="soft" operator="arithmetic" k2="${f(rough)}" k3="${f(1 - rough)}" result="bump"/>
  <feDiffuseLighting in="bump" surfaceScale="${scale}" diffuseConstant="1" lighting-color="#fff" result="diff"><feDistantLight azimuth="225" elevation="${el}"/></feDiffuseLighting>
  <feSpecularLighting in="bump" surfaceScale="${scale}" specularConstant="${ks}" specularExponent="${exp}" lighting-color="#fff" result="spec"><feDistantLight azimuth="225" elevation="${el + 8}"/></feSpecularLighting>
  <feComposite in="SourceGraphic" in2="diff" operator="arithmetic" k1="${f(kd)}" result="lit"/>
  <feComposite in="spec" in2="SourceAlpha" operator="in" result="shine"/>
  <feComposite in="lit" in2="shine" operator="arithmetic" k2="1" k3="0.45" result="out"/>
  <feComposite in="out" in2="SourceGraphic" operator="in"/>
</filter>`;
}

/** A soft dark halo under a raised piece, so it sits ON what is behind it. */
function shadowFilter(id, { dx = 2, dy = 3, blur = 2.5, opacity = 0.7 } = {}) {
  return `<filter id="${id}" x="-10%" y="-10%" width="125%" height="130%"><feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${blur}" flood-color="#000" flood-opacity="${opacity}"/></filter>`;
}

/** A blotchy, low-frequency stain — the grime on a dark panel. */
function stainFilter(id, seed, strength = 0.35) {
  return `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="0.018 0.03" numOctaves="4" seed="${seed}" result="n"/>
  <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${f(strength * 3)} 0 0 0 ${f(-strength)}" result="a"/>
  <feFlood flood-color="#000"/><feComposite in2="a" operator="in" result="s"/>
  <feComposite in="s" in2="SourceGraphic" operator="in" result="s2"/>
  <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="s2"/></feMerge>
</filter>`;
}

/** Thin cracks wandering across a box. */
function cracks(r, x0, y0, w, h, n, color = "#0b0a09", width = 1.1, opacity = 0.7) {
  let out = "";
  for (let i = 0; i < n; i++) {
    let x = x0 + r() * w, y = y0 + r() * h;
    let d = `M${f(x)} ${f(y)}`;
    const ang = r() * Math.PI * 2;
    const steps = 3 + Math.floor(r() * 5);
    for (let s = 0; s < steps; s++) {
      const a = ang + (r() - 0.5) * 1.4;
      const len = 4 + r() * 12;
      x = Math.max(x0, Math.min(x0 + w, x + Math.cos(a) * len));
      y = Math.max(y0, Math.min(y0 + h, y + Math.sin(a) * len));
      d += ` L${f(x)} ${f(y)}`;
    }
    out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${f(width * (0.6 + r() * 0.8))}" stroke-linecap="round" opacity="${f(opacity * (0.5 + r() * 0.5))}"/>`;
  }
  return out;
}

/**
 * Where the panel meets the game's own tile, its last few columns are eased toward the colour
 * that tile has along its edge. `bands` is that tile's edge, measured: the mean colour of its
 * six edge columns in 24-row bands from the top (null where it is transparent) — read off the
 * 1.30.4 install's `<Race>UITile01` (left edge) and `<Race>UITile04` (right edge), which every
 * classic build ships byte for byte the same (docs/versions.md). It is a fade, not a copy: a
 * flat average laid over the drawing's own last 10 texels.
 */
function seamEase(id, bands, rows, x, width, towardRight, opacity = 0.55) {
  const stops = [];
  bands.forEach((c, i) => {
    if (!c) return;
    const y = i * 24 + 12;
    if (y < rows[0] || y > rows[1]) return;
    stops.push(`<stop offset="${f((y - rows[0]) / (rows[1] - rows[0]))}" stop-color="${c}"/>`);
  });
  if (!stops.length) return { defs: "", body: "" };
  const defs = `<linearGradient id="${id}v" x1="0" y1="0" x2="0" y2="1">${stops.join("")}</linearGradient>
<linearGradient id="${id}h" x1="${towardRight ? 0 : 1}" y1="0" x2="${towardRight ? 1 : 0}" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="${opacity}"/></linearGradient>
<mask id="${id}m" maskUnits="userSpaceOnUse" x="${x}" y="${rows[0]}" width="${width}" height="${rows[1] - rows[0]}"><rect x="${x}" y="${rows[0]}" width="${width}" height="${rows[1] - rows[0]}" fill="url(#${id}h)"/></mask>`;
  const body = `<rect x="${x}" y="${rows[0]}" width="${width}" height="${rows[1] - rows[0]}" fill="url(#${id}v)" mask="url(#${id}m)"/>`;
  return { defs, body };
}

function svg(w, h, defs, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<!-- OpenWar3's own drawing, made by tools/fallback-draw.mjs. Not Blizzard art. -->
<defs>
${defs}
</defs>
${body}
</svg>
`;
}

// ---------------------------------------------------------------------------------------------
// The wide console's side panels (`<Race>UITile05` / `06`, 512×512).
//
// ConsoleUI.fdf draws only two slices of each: rows 0…64 for the top strip (TexCoord 0…0.125)
// and rows 160…512 for the bottom band (0.3125…1); rows in between are never seen and left
// clear. 05 hangs off the console's LEFT edge, so its RIGHT side meets `UITile01`; 06 hangs off
// the RIGHT, its LEFT side meeting `UITile04`. At the widest stage the game draws (16:9) only the
// half nearest the console is on screen, so that half carries the detail.
//
// Each race is drawn once with the join on the right; 06 is the same drawing mirrored, with its
// own measured outline and edge.

/** The neighbour tiles' edges (see seamEase): [top strip bottom row, band top row, 21 bands]. */
const EDGES = {
  Human: {
    "05": { strip: 47, band: 187, bands: ["#363837", "#4a4d4c", null, null, null, null, null, "#5b5b58", "#2a2a29", "#262626", "#272727", "#161716", "#1d1d1d", "#181514", "#1e140f", "#1d1713", "#230c04", "#3d1c0f", "#2e1208", "#3e0f03", "#3b0e04"] },
    "06": { strip: 48, band: 194, bands: ["#222426", "#464849", "#484a49", null, null, null, null, null, "#373939", "#282929", "#272827", "#161716", "#181919", "#191716", "#1e130f", "#1e1816", "#210b04", "#491d0e", "#401407", "#390f03", "#350e04"] },
  },
  Orc: {
    "05": { strip: 48, band: 189, bands: ["#2a190e", "#392315", "#533621", null, null, null, null, "#462b1a", "#3c2719", "#24160d", "#33190e", "#2f0c05", "#452c1b", "#350c04", "#32150c", "#322013", "#380c04", "#2d130a", "#412a1a", "#342114", "#2b1b11"] },
    "06": { strip: 48, band: 210, bands: ["#28170d", "#382315", "#573924", null, null, null, null, null, "#1d130c", "#21150c", "#1b1008", "#2d1b11", "#332013", "#342013", "#362215", "#382215", "#382416", "#321f12", "#2f1d12", "#2f1d11", "#24160d"] },
  },
  Undead: {
    "05": { strip: 46, band: 172, bands: ["#493f2d", "#584e3a", null, null, null, null, null, "#7e7056", "#50432c", "#181206", "#281f0c", "#2a210f", "#2d2410", "#2c230f", "#271f0d", "#20190b", "#29200d", "#261e0c", "#241c0b", "#221a0a", "#231b0b"] },
    "06": { strip: 47, band: 175, bands: ["#342d20", "#4d4535", null, null, null, null, null, "#85765c", "#7b6e57", "#504631", "#3d3521", "#3a321e", "#3a321e", "#38311d", "#342c1a", "#362e1d", "#332b1b", "#332b19", "#362e1c", "#37301c", "#362e1c"] },
  },
  NightElf: {
    "05": { strip: 47, band: 173, bands: ["#2b3322", "#2d3624", null, null, null, null, null, "#486e17", "#304c0e", "#142705", "#162f04", "#324211", "#192906", "#233a0a", "#162505", "#223c07", "#163305", "#0e1a04", "#192307", "#29480f", "#102005"] },
    "06": { strip: 47, band: 201, bands: ["#2b2d23", "#2f3627", null, null, null, null, null, null, "#4c7814", "#2f4b0c", "#0c1b02", "#101c03", "#0c1502", "#132304", "#141f04", "#0f1a03", "#070c01", "#162505", "#070c01", "#18100c", "#151508"] },
  },
};

/** A dark, grimy panel — what every race but the human sets into its frame. Fine grain over a
 *  faint large-scale stain, a few hairline cracks, and an inner shadow where the frame overhangs. */
function darkPanel(id, r, x, y, w, h, base, seed) {
  const defs = `<linearGradient id="${id}g" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="${shade(base, 1.12)}"/><stop offset="1" stop-color="${shade(base, 0.86)}"/></linearGradient>
${gritFilter(`${id}n`, { freq: 1.3, octaves: 2, seed, amount: 0.22 })}${gritFilter(`${id}m`, { freq: "0.035 0.05", octaves: 4, seed: seed + 5, amount: 0.16 })}
<filter id="${id}i" x="0" y="0" width="100%" height="100%"><feFlood flood-color="#000" flood-opacity="0.85"/><feComposite in2="SourceAlpha" operator="out"/><feGaussianBlur stdDeviation="5"/><feComposite in2="SourceAlpha" operator="in"/></filter>`;
  const body = `<g filter="url(#${id}n)"><g filter="url(#${id}m)"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id}g)"/>${cracks(r, x + 4, y + 4, w - 8, h - 8, Math.round((w * h) / 3200), "#090807", 0.9, 0.45)}</g></g>
<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000" filter="url(#${id}i)"/>`;
  return { defs, body };
}

/** An irregular block: a rectangle with its corners knocked off by a few texels each. */
function block(r, x, y, w, h, chip = 4) {
  const c = () => 1 + r() * chip;
  const j = () => (r() - 0.5) * 1.6;
  const [a, b, d, e] = [c(), c(), c(), c()];
  return `M${f(x + a)} ${f(y + j())} L${f(x + w - b)} ${f(y + j())} L${f(x + w + j())} ${f(y + b)} L${f(x + w + j())} ${f(y + h - d)} L${f(x + w - d)} ${f(y + h + j())} L${f(x + e)} ${f(y + h + j())} L${f(x + j())} ${f(y + h - e)} L${f(x + j())} ${f(y + a)} Z`;
}

// --- Human: a castle wall — crenellated grey stone, warming to ember-lit brick at its foot ----

function human(edge, seed) {
  const r = rng(seed);
  const T = edge.band;
  let defs = bevelFilter("hst", { blur: 2.2, scale: 5.5, freq: "0.05", rough: 0.3, seed, kd: 1.15, ks: 0.3, exp: 9, el: 40 })
    + bevelFilter("hcap", { blur: 2.6, scale: 6, freq: "0.045", rough: 0.28, seed: seed + 1, kd: 1.2, ks: 0.45, exp: 10, el: 42 })
    + gritFilter("hgr", { freq: 1.2, seed: seed + 2, amount: 0.18 });
  let body = "";
  const stone = (x, y, w, h, color, filter = "hst", chip = 4) => `<path d="${block(r, x, y, w, h, chip)}" fill="${color}" filter="url(#${filter})"/>`;
  // Brick colour by height: cold charcoal above, scorched brown-red at the foot, where the
  // console's ember glow runs along the whole bottom of the human HUD.
  const tint = (y) =>
    y < 290 ? mix("#343536", "#2b2a29", Math.max(0, (y - 210) / 80))
    : y < 400 ? mix("#2b2a29", "#331d15", (y - 290) / 110)
    : mix("#331d15", "#45170a", Math.min(1, (y - 400) / 100));
  const jitter = (c) => mix(c, shade(c, 0.8 + r() * 0.4), 0.6);
  // The lower courses catch the glow on their bottom edges, as the console's own bricks do.
  const emberRim = (x, y, w, h) => {
    const k = Math.max(0, Math.min(1, (y - 330) / 150));
    return k <= 0 ? "" : `<path d="M${f(x + 4)} ${f(y + h - 1.5)} H${f(x + w - 4)}" stroke="#ff6a1e" stroke-width="2" stroke-opacity="${f(0.15 + k * 0.55)}" stroke-linecap="round"/><path d="M${f(x + w - 1.5)} ${f(y + h * 0.4)} V${f(y + h - 4)}" stroke="#ff5a14" stroke-width="1.4" stroke-opacity="${f(k * 0.35)}"/>`;
  };

  // Top strip: mortar, two courses of wall, and the capstones hanging below them.
  let top = `<rect x="0" y="0" width="512" height="44" fill="#0f0f0f"/>`;
  for (const [y, h] of [[-8, 24], [17, 22]]) {
    for (let x = -12 - r() * 30; x < 512; ) {
      const w = 40 + r() * 46;
      top += stone(x + 1.5, y + 1.5, w - 3, h - 3, jitter("#2d2f30"));
      x += w;
    }
  }
  for (let x = -6, k = 0; x < 512; k++) {
    const w = 24 + r() * 9;
    const low = k % 2 === 0;
    top += stone(x, 33, w, low ? 22 : 12, jitter("#575855"), "hcap", 3);
    x += w + 3 + r() * 6;
  }
  body += `<g filter="url(#hgr)">${top}</g>`;

  // Bottom band: mortar behind everything, merlons, then the courses.
  let wall = `<rect x="0" y="${T + 22}" width="512" height="${512 - T - 22}" fill="#0d0c0c"/>`;
  const courses = [];
  for (let y = T + 30; y < 512; y += 36 + r() * 3) courses.push(y);
  courses.forEach((y, i) => {
    for (let x = i % 2 ? -44 : -14 - r() * 20; x < 452; ) {
      const w = 56 + r() * 54;
      wall += stone(x + 2, y + 2, w - 4, 33, jitter(tint(y + 18)));
      wall += emberRim(x + 2, y + 2, w - 4, 33);
      x += w;
    }
  });
  for (let x = -8; x < 456; ) {
    const w = 28 + r() * 16;
    const up = r() < 0.62;
    const y = up ? T - 1 + r() * 3 : T + 10;
    wall += stone(x, y, w, T + 34 - y, jitter("#555653"), "hcap", 5);
    x += w + 2 + r() * 5;
  }
  // The pilaster the panel ends on, and the channel that bends round the wall's corner to it.
  const px = 462;
  wall += `<path d="M${px - 34} 520 V${T + 82} Q${px - 34} ${T + 46} ${px - 2} ${T + 44}" fill="none" stroke="#090909" stroke-width="20"/>
<path d="M${px - 34} 520 V${T + 82} Q${px - 34} ${T + 46} ${px - 2} ${T + 44}" fill="none" stroke="#4b4b49" stroke-width="9" filter="url(#hcap)"/>`;
  for (let y = T + 30; y < 512; ) {
    const h = 38 + r() * 12;
    wall += stone(px, y, 52, h - 2, jitter(mix(tint(y + h / 2), "#454643", 0.3)), "hcap", 4);
    y += h;
  }
  wall += stone(px - 8, T - 1, 62, 34, jitter("#52534f"), "hcap", 5);
  wall += cracks(r, 0, T + 30, 452, 512 - T - 30, 70, "#060606", 1.2, 0.65);
  body += `<g filter="url(#hgr)">${wall}</g>`;
  // Ember light from below: a warm wash, strongest on the bottom courses.
  defs += `<linearGradient id="hglow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff3c00" stop-opacity="0"/><stop offset="0.6" stop-color="#ff3c00" stop-opacity="0.05"/><stop offset="1" stop-color="#ff4a0c" stop-opacity="0.2"/></linearGradient>`;
  body += `<rect x="0" y="340" width="512" height="172" fill="url(#hglow)" style="mix-blend-mode:screen"/>`;
  return { defs, body };
}

// --- Orc: a rough timber frame, iron brackets and fur, round a grimy dark board ----------------

function orc(edge, seed) {
  const r = rng(seed);
  const T = edge.band;
  let defs = bevelFilter("owh", { blur: 1.5, scale: 4, freq: "0.01 0.38", octaves: 3, rough: 0.7, seed, kd: 1.3, ks: 0.3, exp: 8, el: 42 })
    + bevelFilter("owv", { blur: 1.5, scale: 4, freq: "0.38 0.01", octaves: 3, rough: 0.7, seed: seed + 1, kd: 1.3, ks: 0.3, exp: 8, el: 42 })
    + bevelFilter("oir", { blur: 1.6, scale: 3.5, freq: "0.05", octaves: 2, rough: 0.06, seed: seed + 2, kd: 1.25, ks: 0.9, exp: 24 })
    + bevelFilter("oft", { blur: 0.8, scale: 2, freq: "0.5", octaves: 2, rough: 0.3, seed: seed + 3, kd: 1.3, ks: 0.4, exp: 10 })
    + shadowFilter("osh", { dx: 2, dy: 3, blur: 2.2, opacity: 0.8 });
  const wood = (x, y, w, h, vertical, base = "#52321c") => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="1.5" fill="${base}" filter="url(#${vertical ? "owv" : "owh"})"/>`;
  const rivet = (x, y, s = 3) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(s)}" fill="#2c2c2f" filter="url(#oir)"/>`;
  const bracket = (x, y, w, h) => `<g filter="url(#osh)"><path d="M${f(x)} ${f(y + h)} L${f(x + 4)} ${f(y)} H${f(x + w - 4)} L${f(x + w)} ${f(y + h)} Z" fill="#252528" filter="url(#oir)"/>${rivet(x + w / 2, y + h * 0.42, 4.2)}</g>`;
  // A roll of grey fur lying along the beam: a shaggy mass, then hair combed sideways over it
  // with pale tips, then a few stray guard hairs standing off it.
  const fur = (cx, cy, w) => {
    let s = `<ellipse cx="${f(cx)}" cy="${f(cy + 6)}" rx="${f(w / 2)}" ry="11" fill="#4a443c" filter="url(#oft)"/>`;
    for (let i = 0; i < 170; i++) {
      const x = cx + (r() - 0.5) * w;
      const y = cy + (r() - 0.5) * 16;
      const dir = r() < 0.5 ? -1 : 1;
      const a = (dir < 0 ? Math.PI : 0) + (r() - 0.5) * 1.2 - 0.35 * dir;
      const l = 7 + r() * 11;
      const c = mix("#d9d2c0", "#4c463d", r() * 0.8);
      s += `<path d="M${f(x)} ${f(y)} q${f(Math.cos(a) * l * 0.5)} ${f(Math.sin(a) * l * 0.5 - 2)} ${f(Math.cos(a) * l)} ${f(Math.sin(a) * l)}" stroke="${c}" stroke-width="${f(0.8 + r() * 1.4)}" stroke-linecap="round" fill="none" opacity="${f(0.6 + r() * 0.4)}"/>`;
    }
    for (let i = 0; i < 14; i++) {
      const x = cx + (r() - 0.5) * w * 0.9;
      s += `<path d="M${f(x)} ${f(cy - 2)} q${f((r() - 0.5) * 6)} -6 ${f((r() - 0.5) * 10)} ${f(-8 - r() * 6)}" stroke="#e6dfcc" stroke-width="1" fill="none" opacity="0.7"/>`;
    }
    return s;
  };
  let body = "";
  // Top strip: dark board, timber rail along its foot, a post at the join.
  const tp = darkPanel("otp", r, 0, 0, 512, 42, "#221d1a", seed + 11);
  defs += tp.defs;
  body += tp.body + `<g filter="url(#osh)">${wood(-4, 40, 520, 9, false, "#5a3820")}</g>${wood(495, -2, 19, 51, true, "#4f311c")}`;
  // Bottom band.
  const panel = darkPanel("op", r, 18, T + 28, 392, 512 - T - 40, "#24201e", seed + 12);
  const gap = darkPanel("og2", r, 420, T + 28, 42, 512 - T - 40, "#221e1c", seed + 13);
  defs += panel.defs + gap.defs;
  let fr = "";
  fr += `<g filter="url(#osh)">${wood(404, T + 24, 17, 512 - T - 24, true, "#5e3b22")}${wood(460, T + 24, 18, 512 - T - 24, true, "#5a3820")}</g>`;
  // The iron-banded post at the join, with its slot.
  fr += `<g filter="url(#osh)"><rect x="476" y="${T + 24}" width="31" height="${512 - T - 24}" fill="#202023" filter="url(#oir)"/></g>
<rect x="484" y="${T + 40}" width="15" height="${512 - T - 70}" fill="#100e0d"/><rect x="484" y="${T + 40}" width="15" height="${512 - T - 70}" fill="none" stroke="#6a6a70" stroke-opacity="0.5" stroke-width="1.2"/>`;
  fr += wood(506, T + 24, 8, 512 - T - 24, true, "#4b2f1b");
  fr += `<g filter="url(#osh)">${wood(-2, T + 24, 20, 512 - T - 24, true, "#5a3820")}</g>`;
  for (const y of [T + 66, T + 132, T + 200, T + 266]) {
    for (let k = 0; k < 3; k++) fr += `<path d="M-2 ${y + k * 8} L20 ${y + k * 8 - 7}" stroke="#7d1810" stroke-width="5.5" stroke-linecap="round" filter="url(#oft)"/>`;
  }
  for (const y of [T + 70, T + 150, T + 240, T + 300]) fr += rivet(412.5, y, 2.4);
  fr += `<g filter="url(#osh)">${wood(-4, 497, 520, 17, false, "#4e321e")}</g>`;
  for (let x = 30; x < 512; x += 56 + r() * 12) fr += rivet(x, 505, 2.6);
  // The beam, its brackets, and a roll of fur bound with leather at the outer end.
  fr += `<g filter="url(#osh)">${wood(-4, T, 520, 30, false, "#66412a")}</g>`;
  for (let x = 28; x < 500; x += 40 + r() * 14) fr += `<path d="M${f(x)} ${T + 8} q5 6 -1 14" stroke="#1a0e06" stroke-width="2" fill="none" opacity="0.65"/>` + rivet(x + 16, T + 15, 2.3);
  fr += `<g filter="url(#osh)">${fur(44, T + 4, 84)}</g>`;
  for (const x of [12, 60]) fr += `<rect x="${x}" y="${T - 6}" width="10" height="36" rx="2" fill="#7d5b2b" filter="url(#oft)"/>`;
  fr += bracket(124, T - 7, 60, 36) + bracket(446, T - 7, 62, 36);
  body += panel.body + gap.body + fr;
  return { defs, body };
}

// --- Undead: a ridge of knotted bone and thorns over a dark slab, a carved pillar at each side -

function undead(edge, seed) {
  const r = rng(seed);
  const T = edge.band;
  let defs = bevelFilter("ubn", { blur: 3.2, scale: 7, freq: "0.03 0.05", octaves: 3, rough: 0.2, seed, kd: 1.25, ks: 0.7, exp: 16, el: 40 })
    + bevelFilter("ubs", { blur: 2, scale: 5, freq: "0.035", octaves: 3, rough: 0.14, seed: seed + 1, kd: 1.2, ks: 0.55, exp: 14, el: 42 })
    + bevelFilter("usp", { blur: 1.2, scale: 3, freq: "0.1", octaves: 2, rough: 0.2, seed: seed + 2, kd: 1.4, ks: 0.8, exp: 16 })
    + shadowFilter("ush", { dx: 2, dy: 3, blur: 2.5, opacity: 0.8 });
  defs += `<radialGradient id="ugem" cx="0.35" cy="0.35" r="0.7"><stop offset="0" stop-color="#e8b8ff"/><stop offset="0.35" stop-color="#8a2ab8"/><stop offset="1" stop-color="#1e0630"/></radialGradient>`;
  const BONE = "#6b6249";
  const gem = (x, y, s) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(s + 3)}" fill="#5c5340" filter="url(#ubs)"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(s)}" fill="url(#ugem)"/><circle cx="${f(x - s * 0.35)}" cy="${f(y - s * 0.35)}" r="${f(s * 0.25)}" fill="#fff" opacity="0.75"/>`;
  const spike = (x, y, h, lean) => {
    const w = h * 0.44;
    return `<path d="M${f(x - w / 2)} ${f(y)} Q${f(x - w * 0.2 + lean * 0.4)} ${f(y - h * 0.55)} ${f(x + lean)} ${f(y - h)} Q${f(x + w * 0.25 + lean * 0.3)} ${f(y - h * 0.45)} ${f(x + w / 2)} ${f(y)} Z" fill="#857a5c" filter="url(#usp)"/>`;
  };
  const pillar = (x, w, y0, gems) => {
    let s = `<g filter="url(#ush)"><rect x="${f(x)}" y="${f(y0)}" width="${f(w)}" height="${f(520 - y0)}" rx="3" fill="${shade(BONE, 0.72)}" filter="url(#ubs)"/></g>`;
    s += `<rect x="${f(x + w * 0.3)}" y="${f(y0 + 16)}" width="${f(w * 0.4)}" height="${f(500 - y0 - 30)}" rx="4" fill="#2c271d"/>`;
    s += `<rect x="${f(x + w * 0.3 + 2)}" y="${f(y0 + 18)}" width="${f(w * 0.4 - 4)}" height="${f(500 - y0 - 34)}" rx="3" fill="${shade(BONE, 0.62)}" filter="url(#ubs)"/>`;
    for (const y of gems) s += gem(x + w / 2, y, Math.min(6, w * 0.14));
    return s;
  };
  let body = "";
  // Top strip.
  const tp = darkPanel("utp", r, 0, 0, 512, 38, "#221f1a", seed + 21);
  defs += tp.defs;
  body += tp.body + `<g filter="url(#ush)"><rect x="-4" y="36" width="520" height="11" rx="2" fill="${BONE}" filter="url(#ubs)"/><rect x="492" y="-3" width="23" height="50" rx="2" fill="${shade(BONE, 0.85)}" filter="url(#ubs)"/></g>${gem(462, 19, 6)}`;
  // Bottom band: slab, its rim, the pillars.
  const panel = darkPanel("up", r, 48, T + 62, 440, 512 - T - 74, "#23201c", seed + 22);
  defs += panel.defs;
  let fr = `<rect x="46" y="${T + 60}" width="444" height="${512 - T - 70}" fill="none" stroke="${shade(BONE, 0.7)}" stroke-width="5" filter="url(#ubs)"/>`;
  fr += pillar(0, 48, T + 26, [T + 110, T + 180, T + 292]) + pillar(488, 26, T + 46, []);
  fr += `<g filter="url(#ush)"><rect x="-4" y="499" width="520" height="16" fill="${shade(BONE, 0.8)}" filter="url(#ubs)"/></g>`;
  // The ridge: knotted lengths of bone, overlapping, swelling where they meet each pillar.
  const ridgeY = (x) => T + 38 - 10 * Math.exp(-(((x - 498) / 36) ** 2)) - 16 * Math.exp(-(((x - 14) / 40) ** 2));
  // A length of bone: a shaft swelling into a knuckle at each end, laid end to end over a dark
  // sinew so every joint reads as a gap.
  let ridge = "";
  let sinew = "M-20 " + f(ridgeY(-20) + 12);
  for (let x = -20; x <= 532; x += 8) sinew += ` L${f(x)} ${f(ridgeY(x) + 12)}`;
  ridge += `<path d="${sinew}" stroke="#18140c" stroke-width="22" fill="none" stroke-linecap="round"/>`;
  for (let x = -22; x < 530; ) {
    const len = 34 + r() * 24;
    const cx = x + len / 2;
    const cy = ridgeY(cx) + 12;
    const t = 12 + r() * 3 + (cy < T + 40 ? 3 : 0);
    const a = Math.atan2(ridgeY(x + len) - ridgeY(x), len) * 57.3 + (r() - 0.5) * 10;
    ridge += `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(len / 2 + 7)}" ry="${f(t)}" transform="rotate(${f(a)} ${f(cx)} ${f(cy)})" fill="${mix(BONE, "#958a6a", 0.3 + r() * 0.5)}" filter="url(#ubn)"/>`;
    // The crease where this length meets the next.
    ridge += `<path d="M${f(x + len + 2)} ${f(cy - t * 0.85)} q${f(-5 - r() * 3)} ${f(t * 0.85)} 0 ${f(t * 1.7)}" stroke="#15110a" stroke-width="2.4" fill="none" opacity="0.75"/>`;
    x += len;
  }
  let spikes = "";
  for (let i = 0; i < 8; i++) {
    const x = 432 + i * 11 + r() * 6;
    spikes += spike(x, ridgeY(x) + 6, 15 + r() * 15, (x - 470) * 0.22);
  }
  for (let i = 0; i < 6; i++) {
    const x = 2 + i * 12 + r() * 5;
    spikes += spike(x, ridgeY(x) + 6, 13 + r() * 12, (x - 32) * 0.26);
  }
  body += panel.body + fr + `<g filter="url(#ush)">${spikes}${ridge}</g>`;
  return { defs, body };
}

// --- Night elf: an ivy canopy over a dark panel, carved living wood at each side ---------------

function nightElf(edge, seed) {
  const r = rng(seed);
  const T = edge.band;
  let defs = bevelFilter("nbk", { blur: 1.6, scale: 5, freq: "0.3 0.014", octaves: 4, rough: 0.7, seed, kd: 1.25, ks: 0.3, exp: 8, el: 42 })
    + bevelFilter("nlf", { blur: 1.1, scale: 2.6, freq: "0.12", octaves: 2, rough: 0.12, seed: seed + 1, kd: 1.05, ks: 0.45, exp: 18, el: 44 })
    + bevelFilter("nwd", { blur: 1.4, scale: 3, freq: "0.02 0.3", octaves: 3, rough: 0.5, seed: seed + 2, kd: 1.4, ks: 0.35, exp: 10 })
    + bevelFilter("nst", { blur: 1.2, scale: 2.5, freq: "0.1", octaves: 3, rough: 0.3, seed: seed + 3, kd: 1.35, ks: 0.3, exp: 10 })
    + shadowFilter("nsh", { dx: 2, dy: 3, blur: 2.4, opacity: 0.75 });
  const LEAF = ["#2a580c", "#336a10", "#3f7a12", "#4c8816", "#224a08", "#386f10", "#62921c", "#7d9e22"];
  // An ivy leaf: three pointed lobes round a heart-shaped base; a midrib drawn over it.
  const LEAF_D = "M0 3 C-4 0 -8 2 -12 0 C-14 -2 -17 -4 -18 -8 C-15 -8 -13 -10 -13 -13 C-10 -13 -7 -16 -6 -20 C-4 -19 -2 -22 0 -28 C2 -22 4 -19 6 -20 C7 -16 10 -13 13 -13 C13 -10 15 -8 18 -8 C17 -4 14 -2 12 0 C8 2 4 0 0 3 Z";
  const leaf = (x, y, s, a, dark) => {
    const c = LEAF[Math.floor(r() * LEAF.length)];
    return `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(a)}) scale(${f(s * 0.85)})"><path d="${LEAF_D}" fill="${dark ? shade(c, 0.4) : c}" filter="url(#nlf)"/><path d="M0 1 V-23 M0 -8 L-10 -13 M0 -8 L10 -13 M0 -4 L-9 -3 M0 -4 L9 -3" stroke="${dark ? "#0e1a05" : "#cfe58a"}" stroke-opacity="${dark ? 0.35 : 0.3}" stroke-width="${f(0.9 / s)}" fill="none"/></g>`;
  };
  const trunk = (x, w, y0) => {
    let s = `<g filter="url(#nsh)"><rect x="${f(x)}" y="${f(y0)}" width="${f(w)}" height="${f(520 - y0)}" fill="#3e2b1c" filter="url(#nbk)"/></g>`;
    // Deep grooves running down the bark, plates between them, a carved rune, roots at the foot.
    for (let gx = x + 6 + r() * 6; gx < x + w - 4; gx += 9 + r() * 8) {
      s += `<path d="M${f(gx)} ${f(y0)} C${f(gx + (r() - 0.5) * 8)} ${f(y0 + 120)} ${f(gx + (r() - 0.5) * 8)} ${f(y0 + 220)} ${f(gx + (r() - 0.5) * 6)} 512" stroke="#140c07" stroke-width="${f(1.6 + r() * 1.8)}" fill="none" opacity="0.8"/>`;
    }
    for (let i = 0; i < Math.round(w / 12); i++) {
      const bx = x + 4 + r() * (w - 16);
      const by = y0 + 20 + r() * (512 - y0 - 120);
      s += `<rect x="${f(bx)}" y="${f(by)}" width="${f(7 + r() * 8)}" height="${f(40 + r() * 70)}" rx="3" fill="${mix("#5c4029", "#33231a", r())}" filter="url(#nbk)"/>`;
    }
    const cx = x + w / 2;
    s += `<path d="M${f(cx)} ${f(y0 + 66)} l-7 16 l7 24 l7 -24 Z M${f(cx - 2.5)} ${f(y0 + 108)} h5 v34 h-5 Z" fill="#1c120b"/><path d="M${f(cx)} ${f(y0 + 70)} l-4 12 l4 18" stroke="#8a6a4e" stroke-opacity="0.5" stroke-width="1.2" fill="none"/>`;
    s += `<path d="M${f(x + 2)} 512 c2 -30 22 -36 30 -18 c5 12 -8 18 -12 9 M${f(x + w - 2)} 512 c-2 -30 -22 -36 -30 -18 c-5 12 8 18 12 9" stroke="#4a3222" stroke-width="7" fill="none" stroke-linecap="round" filter="url(#nwd)"/>`;
    return s;
  };
  const vine = (x0, y0, x1, y1) => {
    const mx = (x0 + x1) / 2 + (r() - 0.5) * 30;
    const my = (y0 + y1) / 2 + (r() - 0.5) * 30;
    let s = `<path d="M${f(x0)} ${f(y0)} Q${f(mx)} ${f(my)} ${f(x1)} ${f(y1)}" stroke="#2c4a0e" stroke-width="3.5" fill="none" stroke-linecap="round" filter="url(#nlf)"/>`;
    for (let t = 0.15; t < 1; t += 0.22) {
      const px = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * mx + t * t * x1;
      const py = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * my + t * t * y1;
      s += leaf(px, py, 0.5 + r() * 0.25, r() * 360, r() < 0.4);
    }
    return s;
  };
  let body = "";
  // Top strip: dark board, a carved rail along its foot, a mossy post at the join.
  const tp = darkPanel("ntp", r, 0, 0, 512, 38, "#25261d", seed + 31);
  defs += tp.defs;
  let rail = `<g filter="url(#nsh)"><rect x="-4" y="37" width="520" height="11" fill="#4f3826" filter="url(#nwd)"/></g>`;
  for (let x = 6; x < 492; x += 22) rail += `<path d="M${x} 46 c0 -7 9 -7 9 -2 c0 3 -4 3 -4 1" stroke="#1a110a" stroke-width="1.6" fill="none" opacity="0.8"/>`;
  rail += `<rect x="493" y="-3" width="22" height="51" fill="#4a3424" filter="url(#nbk)"/><path d="M497 0 C503 12 499 26 505 46" stroke="#557f18" stroke-width="3.5" fill="none" filter="url(#nlf)"/>`;
  body += tp.body + rail;
  // Bottom band: the panel in its thin stone frame, the trunks, vines.
  const panel = darkPanel("np", r, 64, T + 40, 356, 512 - T - 52, "#24221d", seed + 32);
  defs += panel.defs;
  let fr = `<rect x="61" y="${T + 37}" width="362" height="${512 - T - 46}" fill="none" stroke="#55544c" stroke-width="5" filter="url(#nst)"/>`;
  fr += trunk(-2, 60, T + 20) + trunk(426, 90, T + 20);
  fr += `<g filter="url(#nsh)"><rect x="-4" y="500" width="520" height="15" fill="#4a3424" filter="url(#nwd)"/></g>`;
  fr += vine(446, T + 70, 476, T + 236) + vine(500, T + 96, 452, T + 300) + vine(442, T + 236, 506, T + 322) + vine(10, T + 64, 40, T + 262);
  // The canopy: a shadowed back layer, then the lit leaves, thickest over each trunk.
  let back = "", front = "";
  const top = (x) => T + 6 + 3 * Math.sin(x / 23);
  for (let i = 0; i < 170; i++) {
    const x = -14 + r() * 540;
    const deep = x > 420 ? 110 : x < 60 ? 70 : 24;
    back += leaf(x, top(x) + 24 + r() * deep, 1.2 + r() * 0.6, (r() - 0.5) * 150, true);
  }
  for (let i = 0; i < 190; i++) {
    const x = -14 + r() * 540;
    const deep = x > 420 ? 96 : x < 60 ? 56 : 16;
    front += leaf(x, top(x) + 22 + r() * deep, 1.1 + r() * 0.7, (r() - 0.5) * 120, false);
  }
  body += panel.body + fr + back + `<g filter="url(#nsh)">${front}</g>`;
  return { defs, body };
}

const RACES = { Human: human, Orc: orc, Undead: undead, NightElf: nightElf };

/**
 * One side panel. `which` is "05" (join on the right) or "06" (join on the left).
 *
 * Both are DRAWN with the join on the right, against their own measured edge. 06 is then turned
 * round as a PICTURE, after it is drawn: Chrome draws every lighting filter black under a
 * mirroring transform (a mirrored group, a mirrored embedded image and a mirrored root all
 * do it), so 06's SVG carries `data-ow3-mirror="x"` and tools/fallback-svg.mjs flips the pixels.
 */
function sidePanel(race, which) {
  const edge = EDGES[race][which];
  const seed = { Human: 101, Orc: 202, Undead: 303, NightElf: 404 }[race] + (which === "06" ? 1 : 0);
  const { defs, body } = RACES[race](edge, seed);
  // Only the two slices ConsoleUI draws are kept; the rows between are never on screen.
  const clip = `<clipPath id="slices"><rect x="0" y="0" width="512" height="${edge.strip}"/><rect x="0" y="${edge.band - 40}" width="512" height="${552 - edge.band}"/></clipPath>`;
  const seamTop = seamEase("st", edge.bands, [0, edge.strip], 502, 10, true);
  const seamBand = seamEase("sb", edge.bands, [edge.band, 512], 502, 10, true);
  const drawing = svg(512, 512, defs + clip + seamTop.defs + seamBand.defs, `<g clip-path="url(#slices)"><g>${body}</g>${seamTop.body}${seamBand.body}</g>`);
  return which === "05" ? drawing : drawing.replace("<svg ", '<svg data-ow3-mirror="x" ');
}

// ---------------------------------------------------------------------------------------------
// The main menu's edition switch (`GlueScreen-ROC|TFT-EditionButton-up|down|disabled`).
//
// A square badge beside Single Player that wears the emblem of the edition it takes you TO:
// an orc warrior's face for Reign of Chaos, the developer's portrait of a white-haired death
// knight for The Frozen Throne, both in the same gilded, gem-studded frame. `up` and `disabled` are 64×64, `down`
// 32×32 (the game's own sizes); disabled is the same picture with its colour drained.

// Both badges wear ONE frame: gilded, bevelled, a row of six violet gems down each side, around
// a 208² window. `defs` must go into the badge's <defs> once.
const BADGE_FRAME = {
  defs: bevelFilter("bg", { blur: 3, scale: 6, freq: "0.05", octaves: 3, rough: 0.3, seed: 8, kd: 1.3, ks: 1.1, exp: 18, el: 45 })
    + `<radialGradient id="gem" cx="0.35" cy="0.35" r="0.7"><stop offset="0" stop-color="#e2b0ff"/><stop offset="0.4" stop-color="#7a22a8"/><stop offset="1" stop-color="#22062e"/></radialGradient>
<radialGradient id="vig" cx="0.5" cy="0.5" r="0.72"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></radialGradient>`,
  // `inside` is drawn in the window, clipped to it; the vignette and the black rule go over it.
  body(inside) {
    let studs = "";
    for (let i = 0; i < 6; i++) {
      const t = 32 + i * 38.4;
      for (const [x, y] of [[t, 13], [t, 243], [13, t], [243, t]]) studs += `<circle cx="${f(x)}" cy="${f(y)}" r="4.5" fill="url(#gem)"/>`;
    }
    return `<rect x="4" y="4" width="248" height="248" rx="8" fill="#5a4822" filter="url(#bg)"/>
${studs}
<rect x="24" y="24" width="208" height="208" fill="#0d0b0a"/>
<clipPath id="win"><rect x="24" y="24" width="208" height="208"/></clipPath>
<g clip-path="url(#win)">${inside}</g>
<rect x="24" y="24" width="208" height="208" fill="url(#vig)"/>
<rect x="24" y="24" width="208" height="208" fill="none" stroke="#000" stroke-width="5"/>`;
  },
};

function orcBadge() {
  const r = rng(7);
  const defs = BADGE_FRAME.defs
    + bevelFilter("bs", { blur: 7, scale: 9, freq: "0.04", octaves: 3, rough: 0.25, seed: 5, kd: 1.35, ks: 0.5, exp: 12, el: 38 })
    + bevelFilter("bt", { blur: 3, scale: 6, freq: "0.06", octaves: 2, rough: 0.1, seed: 6, kd: 1.3, ks: 0.9, exp: 20, el: 45 })
    + shadowFilter("bsh", { dx: 3, dy: 5, blur: 5, opacity: 0.85 })
    + `<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff4a8"/><stop offset="0.45" stop-color="#f2b81c"/><stop offset="1" stop-color="#5a3404" stop-opacity="0"/></radialGradient>
<filter id="soft"><feGaussianBlur stdDeviation="5"/></filter>`;
  let hair = "";
  for (let i = 0; i < 26; i++) {
    const x = 104 + r() * 48;
    hair += `<path d="M${f(x)} ${f(64 + r() * 8)} Q${f(x + (r() - 0.5) * 16)} ${f(44)} ${f(122 + r() * 12)} ${f(26 + r() * 8)}" stroke="${mix("#0e0d0c", "#2a2622", r())}" stroke-width="${f(2 + r() * 3)}" fill="none" stroke-linecap="round"/>`;
  }
  const body = BADGE_FRAME.body(`<g transform="translate(128 132) scale(1.22) translate(-128 -132)">
<g filter="url(#bsh)">
  <path d="M60 104 C46 92 40 78 36 64 C52 74 60 84 70 94 Z M196 104 C210 92 216 78 220 64 C204 74 196 84 186 94 Z" fill="#36621a" filter="url(#bs)"/>
  <path d="M128 52 C96 52 72 70 66 100 C62 118 56 128 54 142 C66 140 64 156 72 172 C82 198 102 216 128 218 C154 216 174 198 184 172 C192 156 190 140 202 142 C200 128 194 118 190 100 C184 70 160 52 128 52 Z" fill="#3f7218" filter="url(#bs)"/>
</g>
${hair}
<path d="M70 98 C88 84 112 88 124 104 C108 102 88 104 70 98 Z M186 98 C168 84 144 88 132 104 C148 102 168 104 186 98 Z" fill="#2e5410" filter="url(#bs)"/>
<ellipse cx="102" cy="116" rx="17" ry="8" fill="#0e1404"/><ellipse cx="154" cy="116" rx="17" ry="8" fill="#0e1404"/>
<ellipse cx="103" cy="117" rx="11" ry="5" fill="url(#glow)"/><ellipse cx="153" cy="117" rx="11" ry="5" fill="url(#glow)"/>
<path d="M70 96 C88 96 110 104 124 114 M186 96 C168 96 146 104 132 114" stroke="#1a3008" stroke-width="11" stroke-linecap="round" fill="none"/>
<path d="M72 92 C90 92 110 100 122 108 M184 92 C166 92 146 100 134 108" stroke="#7aa832" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.6"/>
<path d="M100 80 C116 76 140 76 156 80 M106 70 C118 66 138 66 150 70" stroke="#1e380a" stroke-width="2.5" fill="none" opacity="0.6"/>
<circle cx="105" cy="117" r="2.4" fill="#1a0e02"/><circle cx="151" cy="117" r="2.4" fill="#1a0e02"/>
<path d="M114 118 C116 136 108 146 104 152 C116 160 140 160 152 152 C148 146 140 136 142 118 C134 126 122 126 114 118 Z" fill="#4a8018" filter="url(#bs)"/>
<ellipse cx="118" cy="152" rx="5" ry="3" fill="#122006"/><ellipse cx="138" cy="152" rx="5" ry="3" fill="#122006"/>
<path d="M88 172 C104 184 152 184 168 172 C160 196 96 196 88 172 Z" fill="#101806"/>
<path d="M92 186 C108 194 148 194 164 186" stroke="#3e6e14" stroke-width="5" fill="none"/>
<path d="M96 176 C92 160 92 146 98 134 C102 150 106 164 108 176 Z" fill="#e8dfc0" filter="url(#bt)"/>
<path d="M160 176 C164 160 164 146 158 134 C154 150 150 164 148 176 Z" fill="#e8dfc0" filter="url(#bt)"/>
<path d="M76 136 C84 146 86 158 84 168 M180 136 C172 146 170 158 172 168 M108 70 C116 66 140 66 148 70" stroke="#1e380a" stroke-width="3" fill="none" opacity="0.7"/>
</g>
`);
  return { defs, body };
}

// The Frozen Throne's badge: a gilded, gem-studded frame around a PORTRAIT rather than a drawing —
// `src/fallback/portraits/DeathKnight.png`, the developer's picture, cropped to the head (416²,
// enough for the ×8 the rasterizer draws a 64-texel badge at). It is embedded into the SVG so the
// disabled/down states drain and darken it exactly as they do the drawn orc.
function knightBadge() {
  const portrait = readFileSync(join(REPO, "src", "fallback", "portraits", "DeathKnight.png")).toString("base64");
  const defs = BADGE_FRAME.defs;
  const body = BADGE_FRAME.body(`<image href="data:image/png;base64,${portrait}" x="24" y="24" width="208" height="208" preserveAspectRatio="xMidYMid slice"/>`);
  return { defs, body };
}

function badge(kind, state) {
  const { defs, body } = kind === "ROC" ? orcBadge() : knightBadge();
  const size = state === "down" ? 32 : 64;
  // Drawn on a 256 canvas and scaled; `down` is pressed: the same picture, a touch darker.
  const filter = state === "disabled"
    ? `<filter id="state" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="linear" slope="0.82"/><feFuncG type="linear" slope="0.82"/><feFuncB type="linear" slope="0.82"/></feComponentTransfer></filter>`
    : state === "down"
      ? `<filter id="state" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="linear" slope="0.85"/><feFuncG type="linear" slope="0.85"/><feFuncB type="linear" slope="0.85"/></feComponentTransfer></filter>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
<!-- OpenWar3's own drawing, made by tools/fallback-draw.mjs. Not Blizzard art. -->
<defs>
${defs}
${filter}
</defs>
<g${filter ? ` filter="url(#state)"` : ""}>${body}</g>
</svg>
`;
}

// ---------------------------------------------------------------------------------------------

const written = [];
const put = (path, text) => {
  const file = join(OUT, ...path.split("\\")) + ".svg";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  written.push(path);
};
for (const race of Object.keys(RACES)) for (const which of ["05", "06"]) put(`UI\\Console\\${race}\\${race}UITile${which}`, sidePanel(race, which));
for (const kind of ["ROC", "TFT"]) for (const state of ["up", "down", "disabled"]) put(`UI\\Widgets\\Glues\\GlueScreen-${kind}-EditionButton-${state}`, badge(kind, state));
console.log(`wrote ${written.length} SVGs to src/fallback/svg/`);
