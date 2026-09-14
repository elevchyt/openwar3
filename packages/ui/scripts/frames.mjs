// Generates the nine-slice frame art in src/frames/ — node scripts/frames.mjs (pnpm frames)
//
// OpenWar3 ships zero Blizzard assets, and this site is no exception: nothing here is a copy of
// a game texture. Each frame is drawn from scratch as concentric rings whose COLOURS were
// sampled texel by texel off the 1.30.4 install's own BLPs (read locally, never committed):
//   glue-button*.svg  UI\Widgets\Glues\GlueScreen-Button1-BackdropBorder(-Disabled).blp
//                     + GlueScreen-Button1-BackdropBackground(-Disabled).blp  (32×32 cells)
//   glue-button-bordered.svg  ...-Button1-BorderedBackdropBorder.blp (the grey outer rim)
//   esc-panel.svg     UI\Widgets\EscMenu\Human\human-options-menu-border.blp  (64×64 cells, drawn at 192 so the tiled edge carries its grain)
//   marble.svg        ...\Human\human-options-menu-background.blp — mean (0,9,26)
//   progress-frame.svg  UI\Glues\Loading\LoadBar\Loading-BarBorder.blp (512×64; the iron rail
//                     and its two end caps — the fill, glass and glow are CSS, see src/ui.css)
// CSS draws them with `border-image-slice: <SLICE> fill`.
import { writeFileSync } from "node:fs";

const out = new URL("../src/frames/", import.meta.url);

/** A 45°-chamfered rectangle inset `d` from a `size` square, chamfer leg `c`. */
function chamfer(size, d, c) {
  const a = d, b = size - d;
  c = Math.max(0, c);
  return `${a + c},${a} ${b - c},${a} ${b},${a + c} ${b},${b - c} ${b - c},${b} ${a + c},${b} ${a},${b - c} ${a},${a + c}`;
}

/** Rings, outermost first: [colour, opacity?]. Each is one texel wide; the last fills. */
function glue(rings, name) {
  const SIZE = 56;
  // The blue rule at inset 8 has a ~4-texel leg where the outer edge at inset 2 has ~9:
  // an inset 45° cut loses (2 − √2) per texel.
  const C0 = 10;
  const polys = rings
    .map(([fill, op], d) => `<polygon points="${chamfer(SIZE, d, C0 - d * 0.586)}" fill="${fill}"${op ? ` fill-opacity="${op}"` : ""}/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges">${polys}</svg>`;
  writeFileSync(new URL(name, out), svg);
}

const blueInner = ["#02041c", "#060a39", "#070c47", "#080e55", "#091164", "#000040", "#000bf0", "#1010af",
  "#00001a", "#00001e", "#000021", "#000025", "#000029", "#00002d", "#000031", "#000031", "#000035", "#000039", "#00003a"].map((c) => [c]);
glue([["#000", 0.55], ["#000"], ...blueInner], "glue-button.svg");
glue([["#000", 0.55], ["#000"], ["#656565"], ["#808080"], ...blueInner], "glue-button-bordered.svg");
glue([["#000", 0.55], ["#000"], ["#0f0f0f"], ["#1f1f1f"], ["#272727"], ["#2f2f2f"], ["#363636"], ["#202020"], ["#787878"], ["#5f5f5f"],
  ["#0d0d0d"], ["#0f0f0f"], ["#111111"], ["#121212"], ["#141414"], ["#161616"], ["#181818"], ["#191919"], ["#1b1b1b"], ["#1c1c1c"], ["#1d1d1d"]],
  "glue-button-disabled.svg");
// Pressed: the lit rule drops a texel inward and dims, the bevel darkens — the Down twin reads
// as the button sinking into the panel.
glue([["#000", 0.55], ["#000"], ["#01020e"], ["#030520"], ["#04072a"], ["#050834"], ["#060a3e"], ["#000030"],
  ["#000030"], ["#0008b8"], ["#0c0c88"], ["#000014"], ["#000018"], ["#00001c"], ["#000020"], ["#000024"], ["#000028"], ["#00002c"], ["#000030"], ["#000034"], ["#000036"]],
  "glue-button-down.svg");

// The Human options-menu border, 64-texel cells. Left edge, outside in (alpha then colour):
// a soft drop shadow, twelve texels of grey stone, a black seam, a four-texel gold rule, and a
// shadow cast INTO the panel.
{
  const S = 192;
  const shadowOut = [0.1, 0.2, 0.32, 0.47, 0.7, 0.92];
  const stone = ["#4d5252", "#626463", "#525658", "#525658", "#525658", "#595c5b", "#555959", "#444648", "#3a3c3c", "#363939", "#3d4141", "#252826"];
  const gold = ["#ab820e", "#6e580f", "#a87f0f", "#3e300f"];
  const shadowIn = [0.57, 0.45, 0.3, 0.18, 0.09, 0.03];
  const parts = [];
  // outer shadow: rounded rects of growing inset
  shadowOut.forEach((a, i) => parts.push(`<rect x="${i}" y="${i}" width="${S - 2 * i}" height="${S - 2 * i}" rx="${12 - i}" fill="#000" fill-opacity="${a / (i + 1.6)}"/>`));
  // stone body with a noise grain, rounded at the corner like the texture's cap
  parts.push(`<rect x="6" y="6" width="${S - 12}" height="${S - 12}" rx="5" fill="${stone[3]}"/>`);
  stone.forEach((c, i) => parts.push(`<rect x="${6 + i}" y="${6 + i}" width="${S - 12 - 2 * i}" height="${S - 12 - 2 * i}" rx="${Math.max(0, 5 - i)}" fill="${c}"/>`));
  parts.push(`<rect x="6" y="6" width="${S - 12}" height="${S - 12}" rx="5" fill="#000" filter="url(#n)"/>`);
  parts.push(`<rect x="18" y="18" width="${S - 36}" height="${S - 36}" fill="#151618"/>`);
  gold.forEach((c, i) => parts.push(`<rect x="${19 + i}" y="${19 + i}" width="${S - 38 - 2 * i}" height="${S - 38 - 2 * i}" fill="${c}"/>`));
  // a light glint along the top-left of the stone, like the texture's lit bevel
  parts.push(`<path d="M7 20 V11 Q7 7 11 7 H20" stroke="#8c908f" stroke-width="1" fill="none" opacity="0.8"/>`);
  // interior: clear it, then the inward shadow over whatever the panel's background is
  parts.push(`<rect x="23" y="23" width="${S - 46}" height="${S - 46}" fill="#000" fill-opacity="0"/>`);
  shadowIn.forEach((a, i) => parts.push(`<rect x="${23 + i}" y="${23 + i}" width="${S - 46 - 2 * i}" height="${S - 46 - 2 * i}" fill="none" stroke="#000" stroke-opacity="${a}" stroke-width="1" transform="translate(0.5 0.5)" />`));
  // grain: dark pits and light flecks in the stone, clipped to its own shape
  const defs = `<defs><filter id="n" x="0" y="0" width="100%" height="100%" filterUnits="userSpaceOnUse"><feTurbulence type="fractalNoise" baseFrequency="0.22" numOctaves="3" seed="7" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0.9 -0.25  0 0 0 0.9 -0.25  0 0 0 0.9 -0.24  0 0 0 0 0.32"/><feComposite in2="SourceGraphic" operator="in"/></filter></defs>`;
  // the interior of the nine-slice must be transparent so the marble shows through
  const mask = `<mask id="m"><rect width="${S}" height="${S}" fill="#fff"/><rect x="${23 + shadowIn.length}" y="${23 + shadowIn.length}" width="${S - 46 - 2 * shadowIn.length}" height="${S - 46 - 2 * shadowIn.length}" fill="#000"/><rect x="23" y="23" width="${S - 46}" height="${S - 46}" fill="#000"/></mask>`;
  const body = parts.slice(0, -shadowIn.length).join("");
  const inner = parts.slice(-shadowIn.length).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${defs}<defs>${mask}</defs><g mask="url(#m)">${body}</g>${inner}</svg>`;
  writeFileSync(new URL("esc-panel.svg", out), svg);
}

// Blue marble, tiled behind every panel. Two turbulence layers: broad cloudy value, then veins.
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<filter id="c" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="5" seed="3" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0.05  0 0 0 0 0.17  0 0 0 0 0.33  0 0 0 -2.2 1.35"/></filter>
<filter id="v" x="0" y="0" width="100%" height="100%"><feTurbulence type="turbulence" baseFrequency="0.035" numOctaves="3" seed="11" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0.01  0 0 0 0 0.03  0 0 0 -7 2.1"/></filter>
<rect width="256" height="256" fill="#000814"/><rect width="256" height="256" filter="url(#c)" opacity="0.34"/><rect width="256" height="256" filter="url(#v)" opacity="0.7"/></svg>`;
  writeFileSync(new URL("marble.svg", out), svg);
}
// The loading bar's frame (Loading-BarBorder.blp), 128×40, sliced 13 / 30 / 12 / 30. The rail is
// the texture's own column profile at x = 256, one texel per row, outside in — so the middle
// slice stretches along x without losing anything. Each cap is two iron posts either side of a
// groove, with a spike pointing out of the bar (the texture's row at y = 24: shadow ramp, a
// six-texel post, a three-texel groove at alpha ~0.65, an eight-texel post, then the hole).
{
  const W = 128, H = 40;
  const top = [["#000", 0.05], ["#000", 0.16], ["#000", 0.3], ["#090909", 0.72], ["#6a625b"], ["#343027"], ["#080501"], ["#525451"],
    ["#6c6b6a"], ["#242322"], ["#211e20", 0.97], ["#080605", 0.88], ["#050505", 0.72]];
  const bottom = [["#020204", 0.69], ["#000", 0.83], ["#393939", 0.93], ["#4c4a49"], ["#242322"], ["#2a1d1a"], ["#1c1b1a"], ["#2c2b2a"],
    ["#392c2a"], ["#090806", 0.72], ["#000", 0.3], ["#000", 0.16]];
  const rect = (x, y, w, h, [fill, op]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${op ? ` fill-opacity="${op}"` : ""}/>`;
  const rail = [
    ...top.map((c, y) => rect(0, y, W, 1, c)),
    ...bottom.map((c, i) => rect(0, H - bottom.length + i, W, 1, c)),
  ].join("");
  const cap = [
    // the spike: a dark iron point with a lit upper edge, like the cap's flourish
    `<polygon points="1,20 8,13 14,9 14,31 8,27" fill="#1c1b1a"/>`,
    `<polyline points="1.5,20 8,13.5 14,9.5" fill="none" stroke="#6e6f70" stroke-width="1"/>`,
    `<polyline points="1.5,20 8,26.5 14,30.5" fill="none" stroke="#000" stroke-opacity="0.8" stroke-width="1"/>`,
    // outer post, a little taller than the rail
    ...["#0c0a0a", "#2f302d", "#4e4d4c", "#393939", "#151412", "#242322"].map((c, i) => rect(13 + i, 1, 1, H - 2, [c])),
    // the groove
    rect(19, 3, 3, H - 6, ["#000", 0.65]),
    // inner post
    ...["#393533", "#454545", "#373738", "#090909", "#211e20", "#11100e", "#6e6f70", "#1c1b1a"].map((c, i) => rect(22 + i, 3, 1, H - 6, [c])),
    // rivets: one light fleck on each post
    rect(15, 19, 2, 2, ["#8c908f"]), rect(25, 19, 2, 2, ["#6a625b"]),
  ].join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">` +
    // the rail runs under the posts but stops where the spikes begin
    `<defs><mask id="m"><rect x="13" y="0" width="${W - 26}" height="${H}" fill="#fff"/></mask></defs>` +
    `<g mask="url(#m)">${rail}</g>${cap}<g transform="translate(${W} 0) scale(-1 1)">${cap}</g></svg>`;
  writeFileSync(new URL("progress-frame.svg", out), svg);
}

console.log("frames written");
