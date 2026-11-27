// The REPLAY COLLECTION's door (issue #158) — its own Railway service in the `openwar3` project,
// beside the three relays and deliberately NOT one of them: a relay is "the port, and nothing
// else" (server/relay.mjs), and a redeploy of it costs every open lobby, so the collection lives
// in a deployable of its own with its own watch path (/replays-server).
//
// The game's uploader (src/game/replayUpload.ts) POSTs every finished replay to `/replays` when
// the player has "Share Replays" on, and this files it in the project's PRIVATE Railway bucket.
// The request is the uploader's, unchanged: the replay's raw bytes plus three headers —
// `x-ow3-version` (OpenWar3's), `x-ow3-replay-format` (the FILE's, src/game/replay.ts
// REPLAY_FORMAT) and `x-ow3-install` (the anonymous install id, a random UUID). The game page is
// never on this origin — the desktop app serves itself from `127.0.0.1:<random port>`, a browser
// build from wherever it is hosted — so every answer carries open CORS headers and the preflight
// those custom headers cause is answered.
//
// The door is anonymous by design (there is no account to sign), so what keeps junk out is the
// FILE: an OpenWar3 replay is "OW3R", a format number, then `[tag:4][length:u32 LE][gzip]`
// sections that tile the file exactly, HEAD first (src/game/replay.ts `encodeReplay`). A body
// that is not that shape is refused before anything is written, and one address may send only
// `PER_HOUR` replays an hour (one replica, so a counter in memory is the whole of it). The status
// says whether the uploader should try again: a 4xx other than 408/429 is FINAL (it drops the
// file), anything else is not (it keeps it queued).
//
// Where a replay lands: `replays/<YYYY-MM-DD>/<install>_<version>_<random>.o3r`. The date is the
// day it ARRIVED (an offline player's queue arrives late); the install id groups one player's
// matches without saying who they are; the version says which build recorded it.
//
// THE WAY BACK (the View Replay screen's "Download Replays" dialog, src/ui/replayBrowser.ts): the
// same door LISTS what it holds and hands a replay out again.
//
//   GET /replays?map=&player=&race=&version=&page=&size=   → { rows, total, versions }
//   GET /replays/<id>                                       → the replay's bytes
//
// A row is what a replay's own HEAD says — the map, each seat's name, race, team and colour,
// whether the race was ROLLED (the lobby said Random: `config.slots[].random`), the OpenWar3
// version — plus the match's length off ENDS. `race` takes the four races and `random` (a seat
// that picked Random); beside `player` it is about THAT player's seat. Newest first.
//
// The list is an INDEX kept in memory and saved to the bucket as one object (`index/v1.json`),
// so a restart reads one file and then only the replays it has not seen. Two things never leave:
// the bucket KEY (it carries the uploader's install id — a row is named by a hash of it), and the
// per-seat anonymous ids inside the file, which are taken out of the HEAD of every copy handed
// out. Everything else in a replay — the names the players typed, their chat — is what a replay
// is, and goes with it.
//
// Without the bucket variables, `LOCAL_DIR=<folder>` stands a folder in for the bucket (a local
// test of both directions).
//
// The bucket is reached with the S3 API, signed by `aws4fetch` (the only dependency), through
// the bucket's own variables referenced onto this service: ENDPOINT, BUCKET, REGION,
// ACCESS_KEY_ID, SECRET_ACCESS_KEY. Railway buckets take VIRTUAL-HOSTED URLs — the bucket name
// is the endpoint's subdomain (docs.railway.com/storage-buckets "URL style").

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AwsClient } from "aws4fetch";

const PORT = Number(process.env.PORT) || 8790;

/** The largest replay accepted. Every section is gzip'd JSON; a ten-minute two-player match is
 *  ~186 KB even in a dev build, so this is a long game many times over. Ours. */
const MAX_BYTES = 8 * 1024 * 1024;

/** The highest file format accepted. Generous on purpose: a newer client must not be refused
 *  for being newer, only for not being a replay. Ours. */
const MAX_FORMAT = 99;

/** Replays one address may send in an hour. A player's queue holds at most 50 (MAX_QUEUED in
 *  replayUpload.ts), so a returning offline player drains in about an hour. Ours. */
const PER_HOUR = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const TAG = /^[A-Z]{4}$/;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-ow3-version, x-ow3-replay-format, x-ow3-install",
  "access-control-max-age": "86400",
};

/** Replays one address may DOWNLOAD in an hour, and list requests it may make. Ours. */
const DOWNLOADS_PER_HOUR = 300;
const LISTS_PER_HOUR = 3000;
/** The most rows one page may ask for. Ours. */
const MAX_PAGE = 50;
/** The sim's step (src/render/mapViewer.ts SIM_HZ): ENDS counts the match in these. */
const SIM_HZ = 60;
/** The test upload made when the service was set up — not a match anybody played. */
const TEST_INSTALL = "00000000-0000-4000-8000-000000000000";
const INDEX_KEY = "index/v1.json";

const { ENDPOINT, BUCKET, REGION, ACCESS_KEY_ID, SECRET_ACCESS_KEY, LOCAL_DIR } = process.env;
const s3 =
  ENDPOINT && BUCKET && ACCESS_KEY_ID && SECRET_ACCESS_KEY
    ? new AwsClient({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY, service: "s3", region: REGION || "auto" })
    : null;
if (!s3 && !LOCAL_DIR) console.warn("replays: no bucket variables — every upload will answer 503");

/** Where `key` lives in the bucket, virtual-hosted style. */
function objectUrl(key) {
  const base = new URL(ENDPOINT);
  base.hostname = `${BUCKET}.${base.hostname}`;
  base.pathname = `/${key}`;
  return base.toString();
}

// --- the store: the bucket, or a folder standing in for it ------------------------------------

/** The bucket's three verbs. `list` answers every key under a prefix with its size. */
const store = s3
  ? {
      async put(key, bytes, type = "application/octet-stream") {
        const r = await s3.fetch(objectUrl(key), { method: "PUT", body: bytes, headers: { "content-type": type } });
        if (!r.ok) throw new Error(`bucket answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
      },
      async get(key) {
        const r = await s3.fetch(objectUrl(key));
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`bucket answered ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      },
      async list(prefix) {
        const out = [];
        let token = "";
        do {
          const url = new URL(objectUrl(""));
          url.searchParams.set("list-type", "2");
          url.searchParams.set("prefix", prefix);
          if (token) url.searchParams.set("continuation-token", token);
          const r = await s3.fetch(url.toString());
          if (!r.ok) throw new Error(`bucket list answered ${r.status}`);
          const xml = await r.text();
          for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
            const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1];
            if (key) out.push({ key: unxml(key), size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0) });
          }
          token = unxml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "");
        } while (token);
        return out;
      },
    }
  : LOCAL_DIR
    ? {
        async put(key, bytes) {
          mkdirSync(dirname(join(LOCAL_DIR, key)), { recursive: true });
          writeFileSync(join(LOCAL_DIR, key), bytes);
        },
        async get(key) {
          try { return readFileSync(join(LOCAL_DIR, key)); } catch { return null; }
        },
        async list(prefix) {
          const out = [];
          const walk = (rel) => {
            let names = [];
            try { names = readdirSync(join(LOCAL_DIR, rel)); } catch { return; }
            for (const n of names) {
              const at = rel ? `${rel}/${n}` : n;
              const st = statSync(join(LOCAL_DIR, at));
              if (st.isDirectory()) walk(at);
              else if (at.startsWith(prefix)) out.push({ key: at, size: st.size });
            }
          };
          walk("");
          return out;
        },
      }
    : null;

function unxml(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// --- the index ------------------------------------------------------------------------------------

/** Every replay held, by bucket key: what the list shows of it. */
const index = new Map();
/** …and by the public id a row is named with. */
const byId = new Map();
let indexReady = false;
let saveTimer = null;

const idOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 20);

/** A replay's sections, by tag, as the raw (still gzip'd) bodies. */
function sectionsOf(bytes) {
  const out = [];
  for (let at = 6; at + 8 <= bytes.length; ) {
    const tag = bytes.toString("latin1", at, at + 4);
    const len = bytes.readUInt32LE(at + 4);
    out.push({ tag, body: bytes.subarray(at + 8, at + 8 + len) });
    at += 8 + len;
  }
  return out;
}

const text = (v, max) => String(v ?? "").slice(0, max);

/** What the list shows of one replay, read out of its HEAD and ENDS. Null for a file with no
 *  usable header, or one that is nobody's match (the set-up test upload). */
export function describe(key, bytes) {
  if (key.includes(TEST_INSTALL)) return null;
  try {
    const parts = sectionsOf(bytes);
    const head = JSON.parse(gunzipSync(parts.find((p) => p.tag === "HEAD").body).toString("utf8"));
    const ends = parts.find((p) => p.tag === "ENDS");
    const ticks = ends ? Number(JSON.parse(gunzipSync(ends.body).toString("utf8"))?.ticks) || 0 : 0;
    const slots = new Map((head.config?.slots ?? []).map((s) => [s.id, s]));
    const seats = (head.seats ?? []).slice(0, 24).map((s) => ({
      name: text(s.name, 48),
      race: text(s.race, 16),
      // The lobby said Random and the match rolled `race` (the recorder keeps the flag on the slot).
      ...(slots.get(s.player)?.random ? { random: true } : {}),
      team: Number(s.team) || 0,
      color: Number(s.color ?? s.player) || 0,
      ...(s.kind === "computer" ? { computer: true } : {}),
    }));
    if (!seats.length) return null;
    return {
      id: idOf(key),
      key,
      size: bytes.length,
      map: text(head.map?.name, 80),
      mapFile: text(String(head.map?.path ?? "").split(/[\\/]/).pop(), 80),
      version: text(head.version, 32),
      edition: head.edition === "roc" ? "roc" : "tft",
      recordedAt: text(head.recordedAt, 32),
      lengthSec: Math.round(ticks / SIM_HZ),
      seats,
    };
  } catch {
    return null;
  }
}

function remember(entry) {
  index.set(entry.key, entry);
  byId.set(entry.id, entry);
}

function saveIndexSoon() {
  if (saveTimer || !store) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    store.put(INDEX_KEY, Buffer.from(JSON.stringify({ entries: [...index.values()] })), "application/json")
      .catch((e) => console.error("replays: index not saved", e));
  }, 5000);
  saveTimer.unref();
}

/** Bring the index up: the saved one, then every replay in the bucket it does not know. */
async function loadIndex() {
  if (!store) return;
  try {
    const saved = await store.get(INDEX_KEY);
    for (const e of saved ? JSON.parse(saved.toString("utf8")).entries ?? [] : []) remember(e);
  } catch (e) {
    console.error("replays: saved index unreadable, rebuilding", e);
  }
  const held = await store.list("replays/");
  const keys = new Set(held.map((o) => o.key));
  let changed = false;
  for (const key of [...index.keys()]) {
    if (keys.has(key)) continue;
    byId.delete(index.get(key).id);
    index.delete(key);
    changed = true;
  }
  const fresh = held.filter((o) => !index.has(o.key) && o.key.endsWith(".o3r"));
  // A few at a time: a first boot reads every replay once.
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < fresh.length) {
      const { key } = fresh[next++];
      try {
        const bytes = await store.get(key);
        const entry = bytes && describe(key, bytes);
        if (entry) { remember(entry); changed = true; }
      } catch (e) {
        console.error(`replays: could not index ${key}`, e);
      }
    }
  }));
  indexReady = true;
  if (changed) saveIndexSoon();
  console.log(`replays: index ready, ${index.size} replay(s) (${fresh.length} read)`);
}

const RACES = new Set(["human", "orc", "undead", "nightelf", "random"]);
const fold = (v) => String(v ?? "").toLowerCase();

/** One page of the list under the query's filters. */
export function search(entries, q) {
  const map = fold(q.get("map")).trim();
  const player = fold(q.get("player")).trim();
  const race = RACES.has(q.get("race")) ? q.get("race") : "";
  const version = q.get("version") ?? "";
  const size = Math.min(MAX_PAGE, Math.max(1, Number(q.get("size")) || 10));
  const page = Math.max(0, Number(q.get("page")) || 0);
  const seatFits = (s) =>
    (!player || fold(s.name).includes(player)) && (!race || (race === "random" ? !!s.random : s.race === race));
  const all = [...entries];
  const rows = all
    .filter((e) => (!version || e.version === version) && (!map || fold(e.map).includes(map) || fold(e.mapFile).includes(map)) && e.seats.some(seatFits))
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0));
  const versions = [...new Set(all.map((e) => e.version))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return {
    rows: rows.slice(page * size, (page + 1) * size).map(({ key: _key, ...row }) => row),
    total: rows.length,
    versions,
  };
}

/** A replay as it is handed OUT: the same file, less the per-seat anonymous ids in its HEAD
 *  (they tell one person's matches from another's — the collection's business, nobody else's). */
export function forDownload(bytes) {
  const parts = sectionsOf(bytes);
  const out = [bytes.subarray(0, 6)];
  for (const p of parts) {
    let body = p.body;
    if (p.tag === "HEAD") {
      const head = JSON.parse(gunzipSync(body).toString("utf8"));
      for (const seat of head.seats ?? []) delete seat.id;
      body = gzipSync(Buffer.from(JSON.stringify(head)));
    }
    const h = Buffer.alloc(8);
    h.write(p.tag, 0, "latin1");
    h.writeUInt32LE(body.length, 4);
    out.push(h, body);
  }
  return Buffer.concat(out);
}

/** Why `bytes` is not an OpenWar3 replay, or null when it is one. */
export function notAReplay(bytes) {
  if (bytes.length < 6 || bytes[0] !== 0x4f || bytes[1] !== 0x57 || bytes[2] !== 0x33 || bytes[3] !== 0x52) return "bad magic";
  const format = bytes[4] | (bytes[5] << 8);
  if (format < 1 || format > MAX_FORMAT) return "bad format";
  let at = 6;
  let first = true;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return "truncated section";
    const tag = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const len = bytes.readUInt32LE(at + 4);
    if (!TAG.test(tag)) return "bad section tag";
    if (first && tag !== "HEAD") return "no header";
    // Every section body is gzip (RFC 1952 starts 1f 8b).
    if (len < 2 || bytes[at + 8] !== 0x1f || bytes[at + 9] !== 0x8b) return "bad section body";
    at += 8 + len;
    first = false;
  }
  return at === bytes.length && !first ? null : "sections do not tile the file";
}

/** Sends per address in the current hour. Cleared on the hour rather than sliding: the point is
 *  a ceiling on a flood, not an exact rate. */
const sent = new Map();
const fetched = new Map();
const listed = new Map();
setInterval(() => { sent.clear(); fetched.clear(); listed.clear(); }, 60 * 60 * 1000).unref();

/** Count one request against an hourly ceiling; false once `who` is past it. */
function allow(counter, who, ceiling) {
  const n = counter.get(who) ?? 0;
  if (n >= ceiling) return false;
  counter.set(who, n + 1);
  return true;
}

/** All sends this hour, whoever made them: a ceiling on the bucket that no choice of address
 *  gets round. Ours, sized well above what the player base sends. */
let sentThisHour = 0;
setInterval(() => { sentThisHour = 0; }, 60 * 60 * 1000).unref();
const ALL_PER_HOUR = 2000;

function clientAddress(req) {
  // The LAST entry of X-Forwarded-For, never the first. A proxy APPENDS the address it saw, so
  // everything before the edge's own entry is whatever the caller chose to send — keyed on the
  // first, a client that sent a fresh `X-Forwarded-For: <anything>` with every upload was a
  // fresh address every time and the hourly cap meant nothing. With one proxy in front (Railway's
  // edge), its entry is the last; if it overwrites the header instead, first and last agree.
  const fwd = req.headers["x-forwarded-for"];
  const last = typeof fwd === "string" ? fwd.split(",").pop()?.trim() : "";
  return last || req.socket.remoteAddress || "?";
}

function answer(res, status, body) {
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The request body, or null once it has passed `MAX_BYTES` (the rest is not read). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        req.removeAllListeners("data");
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function collect(req, res) {
  if (Number(req.headers["content-length"] ?? 0) > MAX_BYTES) return answer(res, 413, { error: "too large" });
  const install = String(req.headers["x-ow3-install"] ?? "");
  const version = String(req.headers["x-ow3-version"] ?? "");
  // "unknown" is what `installId()` answers when the page has no localStorage.
  if (install !== "unknown" && !UUID.test(install)) return answer(res, 400, { error: "bad install id" });
  if (!VERSION.test(version)) return answer(res, 400, { error: "bad version" });

  const who = clientAddress(req);
  const count = sent.get(who) ?? 0;
  if (count >= PER_HOUR || sentThisHour >= ALL_PER_HOUR) return answer(res, 429, { error: "too many replays this hour" });
  // Counted NOW, before the body is read: counted after a successful store, any number of
  // uploads sent at once all read the same count and all went through. A send that turns out
  // malformed still spent its turn, which is the point of a ceiling on a flood.
  sent.set(who, count + 1);
  sentThisHour++;

  const bytes = await readBody(req);
  if (!bytes) return answer(res, 413, { error: "too large" });
  const why = notAReplay(bytes);
  if (why) return answer(res, 400, { error: why });
  const format = bytes[4] | (bytes[5] << 8);
  if (String(req.headers["x-ow3-replay-format"]) !== String(format)) return answer(res, 400, { error: "format header disagrees with the file" });

  if (!store) return answer(res, 503, { error: "storage unavailable" });
  const day = new Date().toISOString().slice(0, 10);
  const key = `replays/${day}/${install.toLowerCase()}_${version}_${randomBytes(6).toString("hex")}.o3r`;
  try {
    await store.put(key, bytes);
  } catch (e) {
    console.error("replays: upload failed", e);
    return answer(res, 503, { error: "storage unavailable" });
  }
  // On the list at once (a restart would find it anyway).
  const entry = describe(key, bytes);
  if (entry) { remember(entry); saveIndexSoon(); }
  console.log(`replays: stored ${key} (${bytes.length} bytes)`);
  return answer(res, 201, { ok: true });
}

/** GET /replays — a page of the list. */
function list(req, res) {
  if (!allow(listed, clientAddress(req), LISTS_PER_HOUR)) return answer(res, 429, { error: "too many requests this hour" });
  if (!store) return answer(res, 503, { error: "storage unavailable" });
  if (!indexReady) return answer(res, 503, { error: "the list is still being read — try again in a moment" });
  return answer(res, 200, search(index.values(), new URL(req.url ?? "/", "http://x").searchParams));
}

/** GET /replays/<id> — one replay's bytes. */
async function hand(req, res, id) {
  const entry = byId.get(id);
  if (!entry) return answer(res, 404, { error: "no such replay" });
  if (!allow(fetched, clientAddress(req), DOWNLOADS_PER_HOUR)) return answer(res, 429, { error: "too many downloads this hour" });
  let bytes;
  try {
    bytes = await store.get(entry.key);
  } catch (e) {
    console.error("replays: download failed", e);
    return answer(res, 503, { error: "storage unavailable" });
  }
  if (!bytes) return answer(res, 404, { error: "no such replay" });
  const out = forDownload(bytes);
  res.writeHead(200, { ...CORS, "content-type": "application/octet-stream", "content-length": out.length, "cache-control": "public, max-age=86400" });
  res.end(out);
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && path === "/health") return answer(res, 200, { ok: true, bucket: !!store, replays: index.size });
  const one = /^\/replays\/([0-9a-f]{20})$/.exec(path);
  if (path !== "/replays" && !one) return answer(res, 404, { error: "not found" });
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  const fail = (e) => {
    console.error("replays: request failed", e);
    if (!res.headersSent) answer(res, 500, { error: "internal" });
  };
  if (req.method === "GET") {
    if (!one) return list(req, res);
    return void hand(req, res, one[1]).catch(fail);
  }
  if (req.method !== "POST" || one) return answer(res, 405, { error: "GET or POST only" });
  collect(req, res).catch(fail);
});

server.listen(PORT, () => console.log(`replays listening on ${PORT}`));
loadIndex().catch((e) => {
  console.error("replays: index failed to load", e);
  indexReady = true; // serve what there is; uploads still add to it
});
