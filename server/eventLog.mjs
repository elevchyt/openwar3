// The relay's EVENT LOG — what happened on this server, kept for good (the developer's ask: "log
// everything that happens in online mode, crashes and games hosted included, and keep it longer
// than Railway's seven days").
//
// Two sinks, one line format:
//
//   • STDOUT, one JSON object per line. Railway reads `message` and `level` and makes every other
//     key a filterable attribute (docs.railway.com/observability/logs "Structured logs":
//     `@event:room.create`, `@level:error`, `@room:12`). Kept 7 days on Hobby, 30 on Pro.
//   • The project's private `logs` BUCKET, for ever: the same lines, gzip'd NDJSON, one object
//     per FLUSH — `relay/<name>/<YYYY-MM-DD>/<HH-MM-SS>_<random>.ndjson.gz` — so a day is a prefix
//     to list and a file is `zcat | jq`-able as it is. Flushed every `FLUSH_MS`, sooner once the
//     buffer passes `FLUSH_BYTES`, and on the way out (SIGTERM — a redeploy — or a crash).
//
// The bucket is reached exactly as the replay collection reaches its own (replays-server/
// server.mjs): the S3 API signed by `aws4fetch`, through the bucket's variables referenced onto
// the service under a `LOGS_` prefix (LOGS_ENDPOINT, LOGS_BUCKET, LOGS_REGION,
// LOGS_ACCESS_KEY_ID, LOGS_SECRET_ACCESS_KEY), virtual-hosted URLs. Without them the log is
// stdout alone — a local `pnpm relay` writes nothing anywhere.
//
// What is NEVER written: an address. The relay never reads one (it has no use for it), so there
// is nothing to leak; a player is the name they typed and, for the reports a client sends, its
// anonymous install id (the same random UUID the replay collection files by).
//
// A failed upload keeps its lines and tries again on the next flush; past `MAX_PENDING_BYTES`
// the OLDEST lines go (stdout still had them), because a bucket that is down must not become a
// relay that runs out of memory.

import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { AwsClient } from "aws4fetch";

const FLUSH_MS = 60_000;
const FLUSH_BYTES = 512 * 1024;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

/**
 * Make the relay's log. `relay` names this server in every line and in the bucket path (the
 * service's RELAY_NAME: eu, us, asia). Returns `log(event, fields, level)` plus `flush()`.
 */
export function createEventLog({ relay = "local", env = process.env } = {}) {
  const { LOGS_ENDPOINT, LOGS_BUCKET, LOGS_REGION, LOGS_ACCESS_KEY_ID, LOGS_SECRET_ACCESS_KEY } = env;
  const s3 =
    LOGS_ENDPOINT && LOGS_BUCKET && LOGS_ACCESS_KEY_ID && LOGS_SECRET_ACCESS_KEY
      ? new AwsClient({ accessKeyId: LOGS_ACCESS_KEY_ID, secretAccessKey: LOGS_SECRET_ACCESS_KEY, service: "s3", region: LOGS_REGION || "auto" })
      : null;
  const objectUrl = (key) => {
    const base = new URL(LOGS_ENDPOINT);
    base.hostname = `${LOGS_BUCKET}.${base.hostname}`;
    base.pathname = `/${key}`;
    return base.toString();
  };

  /** Lines waiting for the bucket, and their size. */
  let pending = [];
  let pendingBytes = 0;
  let flushing = null;

  function log(event, fields = {}, level = "info") {
    const line = JSON.stringify({ message: event, level, event, relay, ts: new Date().toISOString(), ...fields });
    // stderr for errors, so a line Railway could not parse still lands as an error.
    (level === "error" ? process.stderr : process.stdout).write(line + "\n");
    if (!s3) return;
    pending.push(line);
    pendingBytes += line.length + 1;
    while (pendingBytes > MAX_PENDING_BYTES && pending.length > 1) pendingBytes -= pending.shift().length + 1;
    if (pendingBytes >= FLUSH_BYTES) void flush();
  }

  /** Write what is waiting as one object. Resolves when it is written or has failed. */
  function flush() {
    if (!s3 || pending.length === 0) return flushing ?? Promise.resolve();
    if (flushing) return flushing;
    const lines = pending;
    const bytes = pendingBytes;
    pending = [];
    pendingBytes = 0;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 19).replace(/:/g, "-");
    const key = `relay/${relay}/${day}/${time}_${randomBytes(4).toString("hex")}.ndjson.gz`;
    flushing = (async () => {
      try {
        const body = gzipSync(lines.join("\n") + "\n");
        const r = await s3.fetch(objectUrl(key), { method: "PUT", body, headers: { "content-type": "application/x-ndjson", "content-encoding": "gzip" } });
        if (!r.ok) throw new Error(`bucket answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
      } catch (err) {
        // Put back IN FRONT of anything logged meanwhile, so the next object keeps the order.
        pending = lines.concat(pending);
        pendingBytes += bytes;
        process.stderr.write(JSON.stringify({ message: "log.flush-failed", level: "warn", relay, error: String(err) }) + "\n");
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  const timer = setInterval(() => void flush(), FLUSH_MS);
  timer.unref?.();

  return { log, flush, toBucket: s3 !== null };
}
