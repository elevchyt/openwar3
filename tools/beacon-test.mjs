// The LAN beacon (electron/beacon.mjs), driven for real over UDP on this machine.
//
// Three beacons in one process stand in for three machines: they broadcast to the same subnet
// address and hear each other exactly as separate boxes would, because a datagram does not know
// where it came from. What that DOESN'T cover is a second subnet, which nothing here can.
//
// `reuseAddr` is what makes this possible at all — several sockets bound to one broadcast port,
// all delivered — and it is also what lets a developer run two copies of the game on one machine.

import { startBeacon } from "../electron/beacon.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (what, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${what}${detail ? `   ${detail}` : ""}`);
  if (!cond) failed++;
};
const heardBy = (seen, port) => seen.some((p) => p.url.endsWith(`:${port}/relay`));

const seen = { a: [], b: [] };
const a = startBeacon({ port: () => 8787, protocol: 13, onChange: (p) => { seen.a = p; } });
const b = startBeacon({ port: () => 9999, protocol: 13, onChange: (p) => { seen.b = p; } });
// A build one version out of step. It would be refused at the relay's handshake anyway; dropping
// it HERE is the difference between never listed and listed-but-unjoinable.
const other = startBeacon({ port: () => 7777, protocol: 99, onChange: () => {} });

try {
  console.log("two copies on a network find each other, and nothing else");
  await sleep(3500);
  ok("A hears B, at B's own relay port", heardBy(seen.a, 9999), seen.a.map((p) => p.url).join(" "));
  ok("…and B hears A", heardBy(seen.b, 8787));
  ok("neither hears a different protocol", !heardBy(seen.a, 7777) && !heardBy(seen.b, 7777));
  // An address cannot do this job: we hear ourselves on whichever interface the datagram went
  // out of, and on a machine running two copies both would look like "us".
  ok("nobody hears themselves", !heardBy(seen.a, 8787) && !heardBy(seen.b, 9999));
  ok("the url is one the lobby can watch", /^ws:\/\/[\d.]+:\d+\/relay$/.test(seen.a[0]?.url ?? ""), seen.a[0]?.url);

  console.log("\na copy that goes away is forgotten");
  other.close();
  b.close();
  await sleep(8000);
  ok("A forgot B within a few beats", !heardBy(seen.a, 9999), `hears ${seen.a.length}`);
} finally {
  a.close(); b.close(); other.close();
}

console.log(failed ? `\nbeacon: ${failed} FAILED` : "\nbeacon: all checks passed");
process.exit(failed ? 1 : 0);
