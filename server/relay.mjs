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

const PORT = Number(process.env.PORT) || 8787;
const HEARTBEAT_MS = Number(process.env.RELAY_HEARTBEAT_MS) || 15_000;

const wss = new WebSocketServer({ port: PORT });
attachRelay(wss, new RelayCore(), { heartbeatMs: HEARTBEAT_MS });

// Any path is accepted, so both `ws://host:PORT` and `ws://host:PORT/relay` reach it — the
// second being what a client built against the same-origin default sends when VITE_RELAY_URL
// points a deployment here.
console.log(`[OpenWar3] relay listening on ws://localhost:${PORT} (heartbeat ${HEARTBEAT_MS} ms)`);
