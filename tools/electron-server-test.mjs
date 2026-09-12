// The exported game's server, checked without a window (`pnpm app:test`).
//
// `electron/server.mjs` is deliberately Electron-free so this can exist: the half that has to be
// RIGHT — one port carrying both the build and the relay, and not carrying the player's home
// directory — is the half a display would otherwise gate. The window is verified by looking at
// it; this is verified by a test.

import { startServer } from "../electron/server.mjs";
import { looksLikeInstall, serveInstall, installVersion, REQUIRED_VERSION } from "../electron/install.mjs";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { PROTOCOL_VERSION } from "../server/rooms.mjs";
import { WebSocket } from "ws";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (!existsSync(join(root, "index.html"))) {
  console.error("no dist/ — run `pnpm build` first");
  process.exit(1);
}

let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!cond) failed++;
};
const first = (ws) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("timeout")), 4000);
  ws.once("message", (d) => { clearTimeout(t); res(JSON.parse(d.toString())); });
  ws.once("error", (e) => { clearTimeout(t); rej(e); });
});

const server = await startServer({ root, host: "127.0.0.1" });
try {
  console.log(`the build and the relay share one port (${server.port})`);
  const index = await fetch(`${server.url}/`);
  ok("the game's page is served", index.status === 200 && (await index.text()).includes("<script"));
  const missing = await fetch(`${server.url}/no/such/route`);
  ok("an unknown route falls back to the app", missing.status === 200);

  // The one thing a static server must never do. `..` is normalized by fetch itself, so the
  // escape is spelled the way an attacker would have to send it.
  const escape = await fetch(`${server.url}/%2e%2e%2f%2e%2e%2fpackage.json`);
  const body = await escape.text();
  ok("it cannot be walked out of", !body.includes("\"openwar3\""), `status ${escape.status}`);

  console.log("the relay answers on the same port");
  const a = new WebSocket(`ws://127.0.0.1:${server.port}/relay`);
  const hello = await first(a);
  ok("hello, at the protocol the client speaks", hello.t === "hello" && hello.protocol === PROTOCOL_VERSION,
     `protocol ${hello.protocol}`);

  // The handshake also reports what this machine looks like from the network. Bound to loopback
  // — which is what this test does — that report is the one LAN failure a program can detect.
  ok("the handshake reports this machine's reachability", hello.host?.kind === "app", JSON.stringify(hello.host));
  ok("…and bound to loopback it says so", hello.host?.lan === false);

  const b = new WebSocket(`ws://127.0.0.1:${server.port}/relay`);
  await first(b);
  a.send(JSON.stringify({ t: "create", name: "Desktop Game", hostName: "Host", mapName: "Echo Isles",
    mapPath: "Maps\\(2)EchoIsles.w3x", maxPlayers: 2 }));
  let seen = null;
  for (let i = 0; i < 3 && !seen; i++) {
    const m = await first(b);
    if (m.t === "rooms" && m.rooms.length) seen = m.rooms[0];
  }
  ok("a second machine sees the game in the list", seen?.name === "Desktop Game", seen ? `"${seen.name}" on ${seen.mapName}` : "nothing listed");

  // A wrong path must be REFUSED rather than left hanging: the dev server has Vite's HMR socket
  // to leave alone, and this process has nothing else on the port at all.
  const stray = new WebSocket(`ws://127.0.0.1:${server.port}/nope`);
  const refused = await new Promise((res) => { stray.on("error", () => res(true)); stray.on("open", () => res(false)); });
  ok("an upgrade off the relay path is refused", refused);

  a.close(); b.close();
  console.log("only the Warcraft III OpenWar3 plays is accepted as an install");
  {
    // The rule is stated in src/vfs/version.ts, where it is also explained and said to the
    // player; this side only has to AGREE, so that a folder the game would refuse at load is
    // never remembered as the chosen one. Compared here rather than trusted, the way
    // relay-test compares PROTOCOL_VERSION across its own two files.
    const ts = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "vfs", "version.ts"), "utf8");
    const declared = /REQUIRED_VERSION\s*=\s*"([^"]+)"/.exec(ts)?.[1];
    ok("the shell asks for the same version the game does", declared === REQUIRED_VERSION,
       `install.mjs ${REQUIRED_VERSION}, version.ts ${declared}`);

    const tmp = join(process.env.TMPDIR ?? "/tmp", `ow3-version-test-${process.pid}`);
    const build = (version) => {
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(join(tmp, "Data"), { recursive: true });
      writeFileSync(join(tmp, ".build.info"),
        `Branch!STRING:0|Active!DEC:1|Version!STRING:0\neu|1|${version}\n`);
    };
    try {
      build("1.30.4.11274");
      ok("the build we play is accepted", looksLikeInstall(tmp), installVersion(tmp));
      build("1.29.2.9231");
      ok("an older one is refused", !looksLikeInstall(tmp), installVersion(tmp));
      build("1.31.1.12164");
      ok("…and a newer one too — same data, not later data", !looksLikeInstall(tmp));
      // The build NUMBER is not part of the rule: it varies with the download and says nothing
      // about the data.
      build("1.30.4.99999");
      ok("a different build number of the same version still passes", looksLikeInstall(tmp));
      rmSync(join(tmp, ".build.info"));
      ok("a folder that says nothing is refused", !looksLikeInstall(tmp));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    // And the developer's own install, which is the one everything else here is measured against.
    const wc3 = join(dirname(fileURLToPath(import.meta.url)), "..", "Warcraft III");
    if (existsSync(wc3)) ok("the install in this repo is that version", looksLikeInstall(wc3), installVersion(wc3));
  }

  console.log("the player's install is read over the app's own scheme, not over the port");
  {
    // `serveInstall` takes a Request and returns a Response — `protocol.handle`'s own contract,
    // and plain web types — so the half that has to be right needs no window to check.
    const wc3 = join(dirname(fileURLToPath(import.meta.url)), "..", "Warcraft III");
    if (!existsSync(wc3)) {
      console.log("  skip  no install at ./Warcraft III");
    } else {
      ok("a folder with a content store is an install", looksLikeInstall(wc3));
      ok("…and an ordinary folder is not", !looksLikeInstall("/tmp"));

      const man = await (await serveInstall(wc3, new Request("ow3-install://local/manifest.json"))).json();
      ok("the manifest finds the maps and the content store",
         man.maps.length > 0 && !!man.casc && man.casc.idx.length > 0,
         `${man.maps.length} maps, ${man.casc?.idx.length ?? 0} idx, ${Object.keys(man.casc?.data ?? {}).length} data`);

      // CustomKeys.txt is a LOOSE file the player writes (issue #142), so the manifest names it
      // rather than assuming it; a folder without one must say so rather than leaving the field
      // off, or the browser side cannot tell "no such file" from "an older manifest".
      ok("the manifest answers whether the folder keeps a CustomKeys.txt",
         man.customKeys === null || man.customKeys === "CustomKeys.txt",
         String(man.customKeys));
      if (man.customKeys) {
        const keys = await serveInstall(wc3, new Request(`ow3-install://local/file?path=${encodeURIComponent(man.customKeys)}`));
        const text = await keys.text();
        ok("…and it is served, and reads like the file it claims to be",
           keys.status === 200 && /^\s*(\/\/|\[)/.test(text), `${keys.status}, ${text.length} bytes`);
      }

      // The one that decides whether a boot is possible at all: `data.NNN` is a gigabyte and the
      // mount reads scattered slices of it.
      const big = man.casc.data[Object.keys(man.casc.data)[0]];
      const url = `ow3-install://local/file?path=${encodeURIComponent(big)}`;
      const part = await serveInstall(wc3, new Request(url, { headers: { range: "bytes=1024-2047" } }));
      const bytes = new Uint8Array(await part.arrayBuffer());
      ok("a ranged read answers 206 with exactly that slice",
         part.status === 206 && bytes.length === 1024, `${part.status}, ${bytes.length} bytes`);

      const escape = await serveInstall(wc3, new Request(`ow3-install://local/file?path=${encodeURIComponent("..\\package.json")}`));
      ok("a path that climbs out of the install is refused", escape.status === 404, `status ${escape.status}`);

      const none = await serveInstall(null, new Request("ow3-install://local/manifest.json"));
      ok("…and with no install chosen there is nothing to serve", none.status === 404);
    }
  }

  const open = await startServer({ root, port: 0, host: "0.0.0.0" });
  try {
    const c = new WebSocket(`ws://127.0.0.1:${open.port}/relay`);
    const h = await first(c);
    ok("bound to every interface it offers the addresses to type",
       h.host?.lan === true && h.host.addresses.every((a) => a.endsWith(`:${open.port}`)),
       JSON.stringify(h.host));
    c.close();
  } finally { await open.stop(); }
} finally {
  await server.stop();
}
console.log(failed ? `\nelectron server: ${failed} FAILED` : "\nelectron server: all checks passed");
process.exit(failed ? 1 : 0);
