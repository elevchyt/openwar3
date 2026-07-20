// The OpenWar3 relay — rooms and message forwarding, nothing else.
//
// Run locally for LAN play and for two-window testing:   node server/relay.mjs
// Deploy the same file to Railway/Render for internet play (it reads PORT).
//
// WHY THIS IS DUMB, ON PURPOSE (docs/multiplayer.md):
//   • It runs no simulation. The authoritative sim is the HOST CLIENT's. That keeps the
//     CPU cost on hardware we don't rent, which is what makes a free tier viable.
//   • It never loads Blizzard data. An authoritative *server* would have to read the
//     install's SLKs to know a footman's stats — and OpenWar3_PLAN.md §8 forbids hosting
//     Blizzard content. A relay sidesteps that entirely: it forwards opaque payloads.
//   • It keeps no match state beyond a room table, so a cold start or a restart costs a
//     lobby, never a game in progress.
//
// THIS FILE IS NOW ONLY THE WEBSOCKET ADAPTER. The room table and the routing live in
// `rooms.mjs`, socket-free, so the same logic can also run in-process for tests
// (`tools/loopback.mjs`, docs/multiplayer.md Phase E item 8). What stays here is the port,
// the JSON framing and the parse error — the three things that are genuinely about a wire.
//
// The protocol is src/net/protocol.ts. Both files must stay in sync with it by hand — they are
// plain .mjs so the relay can be deployed on its own, with no build step and no bundler.

import { WebSocketServer } from "ws";
import { RelayCore } from "./rooms.mjs";

const PORT = Number(process.env.PORT) || 8787;

const core = new RelayCore();
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  const conn = {
    send: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  core.connect(conn);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      // A parse failure is a WIRE fault, so it is answered here rather than in the core —
      // the core only ever sees messages that already parsed.
      return conn.send({ t: "error", message: "Malformed message." });
    }
    core.handle(conn, msg);
  });

  ws.on("close", () => core.disconnect(conn));
  ws.on("error", () => core.disconnect(conn));
});

console.log(`[OpenWar3] relay listening on ws://localhost:${PORT}`);
