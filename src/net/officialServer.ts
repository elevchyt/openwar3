// The OpenWar3 server — the relay every copy of the game watches out of the box.
//
// It is `server/relay.mjs` deployed exactly as it is to Railway (`.railway/railway.ts`: EU West,
// Amsterdam, ONE replica — the room table lives in memory, and two replicas would be two game
// lists with a random load balancer dealing the players between them). It runs no match: a game
// created there is still simulated by the player who created it, and the server only forwards
// (docs/multiplayer.md "Why the host, and not a server"), so what it costs is bandwidth.
//
// On the client it is a row in every Servers List with no ✕ (`RelaySource` "official" in
// src/net/lobby.ts), and the Create Game screen's Server menu offers it beside this computer.
// This file imports nothing, so the headless lobby tests can read it too.

/** What the Servers List, the Create Game screen and the game lobby call it. */
export const OFFICIAL_SERVER_NAME = "OpenWar3 Server (EU)";

/**
 * Where it is. A public hostname with no port, so `normalizeRelayUrl` dials it `wss://` on 443,
 * which is where Railway serves a generated domain.
 *
 * A build can point somewhere else with `VITE_OFFICIAL_SERVER`, or set it EMPTY to watch no
 * official server at all — a LAN-only test, or the dev harness driving two windows against one
 * relay (src/main.ts `officialServerAddress`).
 */
export const OFFICIAL_SERVER_ADDRESS = "openwar3.up.railway.app";
