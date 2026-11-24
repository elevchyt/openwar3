// The relay event log's 30-day retention (server/eventLog.mjs `sweep`), against an in-memory
// S3 that answers the three calls it makes — ListObjectsV2 (with and without a delimiter, paged),
// DELETE and PUT. Run: node tools/relay-log-sweep-test.mjs
import { createServer } from "node:http";
import { createEventLog } from "../server/eventLog.mjs";

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
};

const store = new Map();
const PAGE = 2; // small pages, so the continuation path is walked
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const key = decodeURIComponent(url.pathname.slice(1));
  if (req.method === "DELETE") { store.delete(key); res.statusCode = 204; return res.end(); }
  if (req.method === "PUT") { const b = []; req.on("data", (d) => b.push(d)); req.on("end", () => { store.set(key, Buffer.concat(b)); res.end(); }); return; }
  const prefix = url.searchParams.get("prefix") ?? "";
  const delim = url.searchParams.get("delimiter");
  const start = Number(url.searchParams.get("continuation-token") ?? 0);
  const under = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
  const items = delim ? [...new Set(under.map((k) => { const i = k.indexOf(delim, prefix.length); return i < 0 ? k : k.slice(0, i + 1); }))] : under;
  const page = items.slice(start, start + PAGE);
  const more = start + PAGE < items.length;
  res.end(`<ListBucketResult>${page.map((k) => (k.endsWith("/") ? `<CommonPrefixes><Prefix>${k}</Prefix></CommonPrefixes>` : `<Contents><Key>${k}</Key><Size>1</Size></Contents>`)).join("")}${more ? `<NextContinuationToken>${start + PAGE}</NextContinuationToken>` : ""}</ListBucketResult>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// Today is 2026-11-24: the cut-off is 30 days back, 2026-10-25, and that day itself stays.
const days = ["2026-09-01", "2026-10-24", "2026-10-25", "2026-11-24"];
for (const d of days) for (let i = 0; i < 3; i++) store.set(`relay/eu/${d}/00-00-0${i}_x.ndjson.gz`, Buffer.from("x"));
store.set("relay/us/2026-09-01/00-00-00_x.ndjson.gz", Buffer.from("x")); // another relay's: not ours to touch
store.set("relay/eu/notes.txt", Buffer.from("x")); // not a day folder

const lines = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => { lines.push(String(s)); return true; };
const events = createEventLog({
  relay: "eu",
  now: () => Date.parse("2026-11-24T12:00:00Z"),
  env: { LOGS_ENDPOINT: `http://127.0.0.1:${port}`, LOGS_BUCKET: "localhost", LOGS_ACCESS_KEY_ID: "a", LOGS_SECRET_ACCESS_KEY: "b" },
});
const got = await events.sweep();
process.stdout.write = write;

console.log("the 30-day sweep");
check("two days, six objects removed", got, { days: 2, objects: 6 });
check("what is left of ours", [...store.keys()].filter((k) => k.startsWith("relay/eu/")).map((k) => k.split("/")[2]).filter((v, i, a) => a.indexOf(v) === i).sort(), ["2026-10-25", "2026-11-24", "notes.txt"]);
check("another relay's folder is untouched", store.has("relay/us/2026-09-01/00-00-00_x.ndjson.gz"), true);
check("the sweep logs what it did", lines.some((l) => l.includes('"log.sweep"') && l.includes('"cutoff":"2026-10-25"')), true);
check("LOGS_RETENTION_DAYS overrides the 30", createEventLog({ relay: "x", env: { LOGS_RETENTION_DAYS: "7" } }).retentionDays, 7);

server.close();
console.log(failed === 0 ? "\nrelay log sweep: all checks passed" : `\nrelay log sweep: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
