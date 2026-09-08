// What this machine looks like FROM THE NETWORK — the `HostInfo` of src/net/protocol.ts.
//
// The one LAN failure a program can actually diagnose is its own binding. A page cannot: it can
// only reach itself, and "I can load the game" is true in exactly the case that is broken. The
// server knows which interface it bound and what addresses this machine has, so the diagnosis
// lives here and the screen only has to print it.
//
// Shared by the dev-server plugin and the desktop app because they answer the same question and
// must not answer it differently. Plain `.mjs` beside the rest of `server/`, for the same reason
// that file is: no build step.

import { networkInterfaces } from "node:os";

/** The addresses another machine could type, one per non-loopback IPv4 interface.
 *
 *  IPv4 only, deliberately: this is a string a person reads off one screen and types into
 *  another, and a link-local IPv6 address with its `%eth0` zone is not that. A machine reachable
 *  only over IPv6 will show none and be told it is unreachable, which is wrong but rare, and
 *  quieter than printing an address that will not work. */
export function lanAddresses(port) {
  const out = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      out.push(`${entry.address}:${port}`);
    }
  }
  return out;
}

/**
 * Describe a listening server. `address` is what `server.address()` reports — the INTERFACE it
 * bound, which is the whole diagnosis: `127.0.0.1` is `pnpm dev` without `--host`, and no amount
 * of firewall or cabling will make that game visible to anybody.
 */
export function describeHost(kind, address, port) {
  const loopbackOnly = address === "127.0.0.1" || address === "::1" || address === "localhost";
  const addresses = loopbackOnly ? [] : lanAddresses(port);
  return { kind, lan: !loopbackOnly && addresses.length > 0, addresses };
}
