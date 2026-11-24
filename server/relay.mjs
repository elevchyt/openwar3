// The OpenWar3 relay as a STANDALONE server — the port, and nothing else.
//
// Run it on its own:                                node server/relay.mjs   (pnpm relay)
// Deploy this file to Railway/Render for internet play (it reads PORT).
//
// For LAN play and two-window testing you no longer need it: `pnpm dev` mounts the same core
// on the dev server's own port at `/relay` (tools/vite-plugin-relay.ts), so a LAN game is one
// process and one firewall rule. This file stays because the INTERNET deployment is a box that
// serves no page — it is the artifact that goes to the cloud, and it must keep deploying with
// no build step and no bundler, which is why it and `rooms.mjs` are plain `.mjs`.
//
// WHY THE RELAY IS DUMB, ON PURPOSE (docs/multiplayer.md):
//   • It runs no simulation. The authoritative sim is the HOST CLIENT's. That keeps the
//     CPU cost on hardware we don't rent, which is what makes a free tier viable.
//   • It never loads Blizzard data. An authoritative *server* would have to read the
//     install's SLKs to know a footman's stats — and OpenWar3_PLAN.md §8 forbids hosting
//     Blizzard content. A relay sidesteps that entirely: it forwards opaque payloads.
//   • It keeps no match state beyond a room table, so a cold start or a restart costs a
//     lobby, never a game in progress.
//
// The room table and the routing live in `rooms.mjs`, socket-free, so the same logic can also
// run in-process for tests (`tools/loopback.mjs`). The JSON framing and the heartbeat live in
// `wsAdapter.mjs`, shared with the dev-server plugin and with whatever ships the exported game.
// What is left here is the PORT — the one thing that is genuinely this deployment's own.
//
// The protocol is src/net/protocol.ts. These files must stay in sync with it by hand.

import { WebSocketServer } from "ws";
import { RelayCore } from "./rooms.mjs";
import { attachRelay } from "./wsAdapter.mjs";
import { createEventLog } from "./eventLog.mjs";

const PORT = Number(process.env.PORT) || 8787;
const HEARTBEAT_MS = Number(process.env.RELAY_HEARTBEAT_MS) || 15_000;

// The event log (eventLog.mjs): stdout for Railway's log explorer, and the `logs` bucket for
// keeps. RELAY_NAME is the service's own (eu, us, asia) and names it in every line.
const events = createEventLog({ relay: process.env.RELAY_NAME || "local" });
const wss = new WebSocketServer({ port: PORT });
attachRelay(wss, new RelayCore({ log: events.log }), { heartbeatMs: HEARTBEAT_MS });
events.log("relay.start", { port: PORT, toBucket: events.toBucket, retentionDays: events.retentionDays, node: process.version });

// The way out. A redeploy is a SIGTERM, and the last minute of lines is still in memory; a crash
// is logged with its stack BEFORE the process goes, since a relay that dies takes every room on it
// and "why" is the one thing that must survive it. Flushes are bounded: a bucket that does not
// answer must not hold a dying process up.
const flushThen = (code) => {
  const done = () => process.exit(code);
  Promise.race([events.flush(), new Promise((r) => setTimeout(r, 4000))]).then(done, done);
};
process.on("SIGTERM", () => { events.log("relay.stop", { signal: "SIGTERM" }); flushThen(0); });
process.on("SIGINT", () => { events.log("relay.stop", { signal: "SIGINT" }); flushThen(0); });
process.on("uncaughtException", (err) => {
  events.log("relay.crash", { error: String(err), stack: err?.stack ?? null }, "error");
  flushThen(1);
});
process.on("unhandledRejection", (err) => {
  // Logged, not fatal: nothing in the relay awaits anything a room depends on (the one promise
  // it keeps is the log's own flush), so an orphaned rejection is a bug to read, not a reason
  // to drop every game on the server.
  events.log("relay.unhandled-rejection", { error: String(err), stack: err?.stack ?? null }, "error");
});

// Any path is accepted, so both `ws://host:PORT` and `ws://host:PORT/relay` reach it — the
// second being what a client built against the same-origin default sends when VITE_RELAY_URL
// points a deployment here.
console.log(`[OpenWar3] relay listening on ws://localhost:${PORT} (heartbeat ${HEARTBEAT_MS} ms)`);
