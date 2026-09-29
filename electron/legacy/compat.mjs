// What the main process uses that ELECTRON 18 does not have — the 32-bit Linux build's shell.
//
// Electron stopped publishing `linux-ia32` after 18.3.15 (its 19.0.0 release has no such asset;
// docs/linux.md), so a 32-bit AppImage is that Electron or nothing. Its Node is 16.13 and its
// `protocol` module predates `handle`, and `main.mjs` — written for the Electron the rest of the
// app runs — reaches for four things neither has. They are supplied HERE, once, before a line of
// `main.mjs` runs, so the shell stays one file with no `if (legacy)` inside it:
//
//   • `protocol.handle` (Electron 25) — adapted onto `registerStreamProtocol`, which is the same
//     request/response exchange in Node's types instead of the web's;
//   • `Response` / `Response.json` (Node 18) — the only web type `serveInstall` builds, and it
//     only ever reads back `status`, `headers` and `body`, so that is all this one carries;
//   • `Readable.toWeb` (Node 17) — the identity here, because the adapter below wants the NODE
//     stream back anyway;
//   • `globalThis.crypto` (Node 19 as a global) — the relay mints room tokens with `randomUUID`.
//
// Plus one thing that is not an API at all, Chromium 100's garbage collection — see below.
//
// Nothing here runs on the 64-bit build: `main.mjs` is its entry, and this file is only bundled
// in front of it by tools/build-legacy-main.mjs.

import { app, protocol } from "electron";
import { Readable } from "node:stream";
import { webcrypto } from "node:crypto";

// ---------------------------------------------------------------------------------------------
// The one thing here that is not an API gap: CHROMIUM 100 COLLECTS ITS OWN GARBAGE TOO LATE.
//
// Measured with memory-infra dumps on the 64-bit build of this same Electron: while the menu
// loads, the renderer's Oilpan heap (`blink_gc`, LargePageSpace) climbs to 1.0–1.6 GB and the
// resident set to 2.3 GB, and Chromium only collects it ~15 s later, dropping to ~0.5 GB. The same
// load on Electron 44 peaks at 1 GB with 118 MB in `blink_gc`. It is not the install reads (moved
// to IPC with no `Response` in between, it barely changed), not WebGL (18 MB uploaded in the whole
// load), not a big DOM (105 elements) and not the audio decode — which Blink object it is was not
// found. What IS known: a 64-bit process rides the spike out, and a 32-bit one runs out of ADDRESS
// SPACE in the middle of it (V8's fatal "Last few GCs" with an empty JS stack at ~2.9 GB mapped) —
// which is why the 32-bit AppImage died before it had drawn the menu, three runs out of three.
//
// So the shell asks the renderer for a collection whenever it has GROWN by COLLECT_GROWTH since
// the lowest it has been since the last one — through the DevTools protocol's
// `HeapProfiler.collectGarbage`, Chromium's own low-memory sequence, which (unlike a page's
// `gc()`, a single major collection) empties Oilpan too. Growth, not a level: a big match's LIVE
// set is itself over a gigabyte, and a level would collect every few seconds for the rest of it.
// Not on a clock, for the same reason. It does not prevent the spike — part of it is live while
// the load runs — but it lowers it (2.3 → ~2.0 GB resident, ~2.7 GB mapped on the 32-bit build),
// and with it the 32-bit build loads the menu and a match. OURS, not the game's.
const COLLECT_GROWTH_KB = 400 * 1024;
const POLL_MS = 250;

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "window") return;
  let floor = Infinity; // the lowest working set since the last collection
  let busy = false;
  const collect = async () => {
    busy = true;
    try {
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
      await contents.debugger.sendCommand("HeapProfiler.collectGarbage");
    } catch {
      // A renderer that is gone or a debugger already claimed: nothing to do, try next time.
    } finally {
      floor = Infinity; // re-measured from the next poll, now the collection has run
      busy = false;
    }
  };
  const timer = setInterval(() => {
    if (busy || contents.isDestroyed()) return;
    const pid = contents.getOSProcessId();
    const kb = app.getAppMetrics().find((m) => m.pid === pid)?.memory?.workingSetSize ?? 0;
    if (!kb) return;
    floor = Math.min(floor, kb);
    if (kb - floor >= COLLECT_GROWTH_KB) void collect();
  }, POLL_MS);
  contents.once("destroyed", () => clearInterval(timer));
});

// ---------------------------------------------------------------------------------------------
// The API gaps.

if (!globalThis.crypto) globalThis.crypto = webcrypto;

if (!Readable.toWeb) Readable.toWeb = (stream) => stream;

if (typeof globalThis.Response === "undefined") {
  globalThis.Response = class Response {
    constructor(body = null, init = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.headers = { ...(init.headers ?? {}) };
    }
    static json(value, init = {}) {
      return new Response(JSON.stringify(value), {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      });
    }
  };
}

/** The one part of a `Request` a handler here reads: its url and its headers by name. The old
 *  API hands the headers over as a plain object in whatever case the page sent them. */
function toRequest(url, method, headers) {
  const lower = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { url, method, headers: { get: (name) => lower[name.toLowerCase()] ?? null } };
}

if (!protocol.handle) {
  protocol.handle = (scheme, handler) =>
    protocol.registerStreamProtocol(scheme, (req, respond) => {
      Promise.resolve(handler(toRequest(req.url, req.method, req.headers))).then(
        (res) => respond({ statusCode: res.status, headers: res.headers, data: toStream(res.body) }),
        (err) => respond({ statusCode: 500, headers: {}, data: toStream(String(err?.message ?? err)) }),
      );
    });
}

function toStream(body) {
  if (body instanceof Readable) return body;
  if (body == null) return Readable.from([]);
  return Readable.from([Buffer.from(body)]);
}
