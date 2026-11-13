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
// The bucket is reached with the S3 API, signed by `aws4fetch` (the only dependency), through
// the bucket's own variables referenced onto this service: ENDPOINT, BUCKET, REGION,
// ACCESS_KEY_ID, SECRET_ACCESS_KEY. Railway buckets take VIRTUAL-HOSTED URLs — the bucket name
// is the endpoint's subdomain (docs.railway.com/storage-buckets "URL style").

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
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
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-ow3-version, x-ow3-replay-format, x-ow3-install",
  "access-control-max-age": "86400",
};

const { ENDPOINT, BUCKET, REGION, ACCESS_KEY_ID, SECRET_ACCESS_KEY } = process.env;
const s3 =
  ENDPOINT && BUCKET && ACCESS_KEY_ID && SECRET_ACCESS_KEY
    ? new AwsClient({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY, service: "s3", region: REGION || "auto" })
    : null;
if (!s3) console.warn("replays: no bucket variables — every upload will answer 503");

/** Where `key` lives in the bucket, virtual-hosted style. */
function objectUrl(key) {
  const base = new URL(ENDPOINT);
  base.hostname = `${BUCKET}.${base.hostname}`;
  base.pathname = `/${key}`;
  return base.toString();
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
setInterval(() => sent.clear(), 60 * 60 * 1000).unref();

function clientAddress(req) {
  // Railway's edge puts the caller first in X-Forwarded-For.
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.socket.remoteAddress || "?";
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
  if (count >= PER_HOUR) return answer(res, 429, { error: "too many replays this hour" });

  const bytes = await readBody(req);
  if (!bytes) return answer(res, 413, { error: "too large" });
  const why = notAReplay(bytes);
  if (why) return answer(res, 400, { error: why });
  const format = bytes[4] | (bytes[5] << 8);
  if (String(req.headers["x-ow3-replay-format"]) !== String(format)) return answer(res, 400, { error: "format header disagrees with the file" });

  if (!s3) return answer(res, 503, { error: "storage unavailable" });
  const day = new Date().toISOString().slice(0, 10);
  const key = `replays/${day}/${install.toLowerCase()}_${version}_${randomBytes(6).toString("hex")}.o3r`;
  try {
    const r = await s3.fetch(objectUrl(key), {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
    if (!r.ok) throw new Error(`bucket answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    console.error("replays: upload failed", e);
    return answer(res, 503, { error: "storage unavailable" });
  }
  sent.set(who, count + 1);
  console.log(`replays: stored ${key} (${bytes.length} bytes)`);
  return answer(res, 201, { ok: true });
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && path === "/health") return answer(res, 200, { ok: true, bucket: !!s3 });
  if (path !== "/replays") return answer(res, 404, { error: "not found" });
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== "POST") return answer(res, 405, { error: "POST only" });
  collect(req, res).catch((e) => {
    console.error("replays: request failed", e);
    if (!res.headersSent) answer(res, 500, { error: "internal" });
  });
});

server.listen(PORT, () => console.log(`replays listening on ${PORT}`));
