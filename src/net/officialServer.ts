// The OpenWar3 servers — the relays every copy of the game watches out of the box.
//
// Each is `server/relay.mjs` deployed exactly as it is to Railway (`.railway/railway.ts`: one
// service per region, ONE replica each — the room table lives in memory, and two replicas would be
// two game lists with a random load balancer dealing the players between them). Three regions are
// three game LISTS, on purpose: a room lives on the relay it was created on, and the client merges
// every list it watches, so a player sees the games on all three and picks a server only when
// hosting — where the nearest one is the one every snapshot of the match is cheapest to forward
// through (issue #225). They run no match: a game created there is still simulated by the player
// who created it, and the server only forwards (docs/multiplayer.md "Why the host, and not a
// server"), so what each costs is bandwidth.
//
// On the client each is a row in every Servers List with no ✕ (`RelaySource` "official" in
// src/net/lobby.ts), and the Create Game screen's Server menu offers them beside this computer,
// opening on the FIRST — EU, the original server and still the default.
// This file imports nothing, so the headless lobby tests can read it too.

export interface OfficialServer {
  /** What the Servers List, the Create Game screen and the game lobby call it. */
  name: string;
  /**
   * Where it is. A public hostname with no port, so `normalizeRelayUrl` dials it `wss://` on 443,
   * which is where Railway serves a generated domain.
   */
  address: string;
}

/**
 * Every official server, the DEFAULT first: the Create Game screen opens on the first one that
 * answers, and the Servers List shows them in this order.
 *
 * A build can point somewhere else with `VITE_OFFICIAL_SERVER` (a comma-separated list of
 * addresses), or set it EMPTY to watch no official server at all — a LAN-only test, or the dev
 * harness driving two windows against one relay (src/main.ts `officialServerAddresses`).
 */
export const OFFICIAL_SERVERS: readonly OfficialServer[] = [
  { name: "OpenWar3 Server (EU)", address: "openwar3-eu.up.railway.app" },  // Amsterdam
  { name: "OpenWar3 Server (US)", address: "openwar3-us.up.railway.app" },  // Virginia
  { name: "OpenWar3 Server (Asia)", address: "openwar3-asia.up.railway.app" }, // Singapore
];

/** What an official server whose address is not one of ours (a `VITE_OFFICIAL_SERVER` build) is
 *  called. */
const FALLBACK_NAME = "OpenWar3 Server";

/** An official server's name by its address as `relayAuthority` prints it (`host` or
 *  `host:port`). */
export function officialServerName(authority: string): string {
  return OFFICIAL_SERVERS.find((s) => s.address === authority)?.name ?? FALLBACK_NAME;
}
