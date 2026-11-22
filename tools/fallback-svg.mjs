// Rasterize src/fallback/svg/**/*.svg into src/fallback/art/**/*.png (src/fallback/README.md).
//
//   node tools/fallback-svg.mjs [filter]       (CHROME=/path/to/chrome to choose the browser)
//
// The SVGs use filters (seeded turbulence), gradients and blend modes, and the one renderer on
// hand that draws all of it is a browser — so this drives a headless Chrome over the DevTools
// protocol, the same way the repo's other browser tools do. Each picture is drawn at a multiple
// of its size and halved down to it on a canvas (premultiplied, so no dark fringe at the
// transparent edges), then written as the PNG tools/patch-art.mjs reads.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SVG = process.env.SVG_DIR ?? join(REPO, "src", "fallback", "svg");
const ART = process.env.ART_DIR ?? join(REPO, "src", "fallback", "art");
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const only = process.argv[2] ?? "";

const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : /\.svg$/i.test(n) ? [join(dir, n)] : []));
const files = walk(SVG).filter((f) => f.includes(only)).sort();

const profile = join(tmpdir(), `ow3-fallback-svg-${process.pid}`);
const port = 9600 + (process.pid % 300);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--mute-audio", "--no-first-run", "about:blank"], { detached: true, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
  }
  if (!target) throw new Error(`no Chrome on port ${port} — set CHROME to a Chrome/Chromium binary`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0;
  const pending = new Map();
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const [, w, h] = /<svg[^>]*\swidth="(\d+)"[^>]*\sheight="(\d+)"/.exec(text) ?? [];
    const size = [Number(w), Number(h)];
    // 06 is drawn with its join on the right and turned round here (tools/fallback-draw.mjs says why).
    const mirror = /<svg[^>]*\sdata-ow3-mirror="x"/.test(text);
    const ss = Math.max(1, Math.min(8, Math.floor(1024 / Math.max(...size)))); // 512 → ×2, 64 → ×8 (capped at 1024)
    const expr = `(async () => {
      const text = ${JSON.stringify(text)};
      const [W, H, SS] = [${size[0]}, ${size[1]}, ${ss}];
      const big = text.replace(/(<svg[^>]*\\swidth=")\\d+("[^>]*\\sheight=")\\d+"/, "$1" + W * SS + "$2" + H * SS + '"');
      const url = URL.createObjectURL(new Blob([big], { type: "image/svg+xml" }));
      const img = new Image();
      await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error("svg failed to load")); img.src = url; });
      let c = document.createElement("canvas");
      c.width = W * SS; c.height = H * SS;
      c.getContext("2d").drawImage(img, 0, 0);
      if (${mirror}) {
        // Turned round as PIXELS: drawing the SVG itself through a mirroring transform blacks
        // out its lighting filters, exactly as a mirrored group inside it does.
        const m = document.createElement("canvas");
        m.width = c.width; m.height = c.height;
        const g = m.getContext("2d"); g.translate(m.width, 0); g.scale(-1, 1); g.drawImage(c, 0, 0);
        c = m;
      }
      while (c.width > W) {
        const n = document.createElement("canvas");
        n.width = Math.max(W, c.width / 2); n.height = Math.max(H, c.height / 2);
        const g = n.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(c, 0, 0, n.width, n.height);
        c = n;
      }
      return c.toDataURL("image/png");
    })()`;
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    const url = r.result?.result?.value;
    if (typeof url !== "string") throw new Error(`${relative(REPO, file)}: ${JSON.stringify(r.result?.exceptionDetails ?? r).slice(0, 300)}`);
    const out = join(ART, relative(SVG, file)).replace(/\.svg$/i, ".png");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(url.split(",")[1], "base64"));
    console.log(`${relative(REPO, out)}  ${size.join("×")} (drawn ×${ss}${mirror ? ", mirrored" : ""})`);
  }
} finally {
  try { ws?.close(); } catch {}
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  rmSync(profile, { recursive: true, force: true });
}
