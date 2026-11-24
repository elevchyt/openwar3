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
// KEPT FOR `LOGS_RETENTION_DAYS` (30 by default — the developer's figure), then deleted: each
// relay sweeps its OWN prefix once at start and once a day (`sweep`), dropping every day folder
// older than that. Per relay, so three servers never race over one key; by the FOLDER's date,
// which is the day the lines were written, so nothing is listed object by object to decide.
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
/** How often the retention sweep runs, and how long after start the first one waits — out of
 *  the way of a fresh relay's first connections. */
const SWEEP_EVERY_MS = 24 * 60 * 60_000;
const SWEEP_FIRST_MS = 60_000;

const unxml = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * Make the relay's log. `relay` names this server in every line and in the bucket path (the
 * service's RELAY_NAME: eu, us, asia). Returns `log(event, fields, level)` plus `flush()`.
 */
export function createEventLog({ relay = "local", env = process.env, now = () => Date.now() } = {}) {
  const { LOGS_ENDPOINT, LOGS_BUCKET, LOGS_REGION, LOGS_ACCESS_KEY_ID, LOGS_SECRET_ACCESS_KEY } = env;
  const retentionDays = Math.max(1, Number(env.LOGS_RETENTION_DAYS) || 30);
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

  /** One page of a ListObjectsV2 under `prefix`: the keys, the "folders" (with `delimiter`),
   *  and the token for the next page. */
  async function listPage(prefix, delimiter, token) {
    const url = new URL(objectUrl(""));
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (delimiter) url.searchParams.set("delimiter", delimiter);
    if (token) url.searchParams.set("continuation-token", token);
    const r = await s3.fetch(url.toString());
    if (!r.ok) throw new Error(`bucket list answered ${r.status}`);
    const xml = await r.text();
    const keys = [...xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g)].map((m) => unxml(m[1]));
    const folders = [...xml.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g)].map((m) => unxml(m[1]));
    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
    return { keys, folders, next: next ? unxml(next) : null };
  }

  /**
   * Delete this relay's day folders older than `retentionDays`. The folder names ARE the dates
   * (`relay/<name>/<YYYY-MM-DD>/`), compared as strings against the cut-off day: a folder of that
   * day or later stays. Logged, like everything else, with what it removed.
   */
  async function sweep() {
    if (!s3) return { days: 0, objects: 0 };
    const root = `relay/${relay}/`;
    const cutoff = new Date(now() - retentionDays * 86_400_000).toISOString().slice(0, 10);
    let days = 0;
    let objects = 0;
    try {
      const old = [];
      let token = null;
      do {
        const page = await listPage(root, "/", token);
        for (const f of page.folders) {
          const day = f.slice(root.length, -1);
          if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) old.push(f);
        }
        token = page.next;
      } while (token);
      for (const folder of old) {
        // The whole folder is LISTED before anything in it is deleted: deleting under a listing
        // still being paged shifts the pages, and a store whose token is an offset then skips
        // half the keys (tools/relay-log-sweep-test.mjs caught exactly that).
        const keys = [];
        let t = null;
        do {
          const page = await listPage(folder, null, t);
          keys.push(...page.keys);
          t = page.next;
        } while (t);
        for (const key of keys) {
          const r = await s3.fetch(objectUrl(key), { method: "DELETE" });
          if (!r.ok && r.status !== 404) throw new Error(`bucket delete answered ${r.status}`);
          objects++;
        }
        days++;
      }
      log("log.sweep", { retentionDays, cutoff, days, objects });
    } catch (err) {
      log("log.sweep-failed", { retentionDays, cutoff, days, objects, error: String(err) }, "warn");
    }
    return { days, objects };
  }

  const timer = setInterval(() => void flush(), FLUSH_MS);
  timer.unref?.();
  if (s3) {
    const first = setTimeout(() => void sweep(), SWEEP_FIRST_MS);
    first.unref?.();
    const daily = setInterval(() => void sweep(), SWEEP_EVERY_MS);
    daily.unref?.();
  }

  return { log, flush, sweep, toBucket: s3 !== null, retentionDays };
}
