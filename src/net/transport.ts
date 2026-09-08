import { PROTOCOL_VERSION, RELAY_PATH, type ClientMessage, type ServerMessage } from "./protocol";
import type { Transport } from "./transportTypes";

// The transport seam.
//
// Everything above this file — the lobby now, the command stream and snapshots later —
// talks to a `Transport`, never to a WebSocket. That is the whole point: the authority
// module must be transport-agnostic so the SAME code serves all three deployments in
// docs/multiplayer.md (LAN direct, internet via relay, dedicated cloud later). The day we
// move the authority off the host, only the adapter changes.
//
// The `Transport` TYPE lives in transportTypes.ts (no `import.meta`), re-exported here so
// existing importers are unaffected; this file adds the socket-backed implementation.

export type { Transport };

/** Where the relay lives. SAME ORIGIN as the page by default; override with VITE_RELAY_URL to
 *  point a build at a deployed one (internet play, where the page and the relay are two boxes). */
export function defaultRelayUrl(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const configured = env?.VITE_RELAY_URL;
  if (configured) return configured;
  // Same origin — host AND port — because whoever serves the page serves the relay: the dev
  // server mounts it at /relay (tools/vite-plugin-relay.ts) and the exported game's own process
  // will do the same. That is what makes LAN play one process and one firewall rule, and it is
  // why the address is DERIVED rather than typed: a second machine that can load the page can by
  // construction reach the relay. Deriving it from `location` also rules out the failure this
  // replaced — a hardcoded 'localhost' resolves to the VISITOR's box and finds no games at all.
  //
  // The scheme follows the page's, so an https deployment gets wss and is not blocked as mixed
  // content — which a fixed `ws://` would be.
  const { protocol, host } = window.location;
  const scheme = protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${host || "localhost:5173"}${RELAY_PATH}`;
}

/** The relay rides the page's own server now, so "no relay" almost always means the page is
 *  being served by something that does not carry one — a bare static host — rather than a
 *  second process somebody forgot to start. Name both, shortest fix first. */
function noRelay(url: string): string {
  return `No relay at ${url}. It is served by \`pnpm dev\` / \`pnpm preview\`; a static host needs \`node server/relay.mjs\` and VITE_RELAY_URL.`;
}

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  onMessage: (msg: ServerMessage) => void = () => {};
  onClose: (reason: string) => void = () => {};

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Resolves once the relay's `hello` has been seen and the protocol version agreed —
   *  not merely when the socket opens. A version mismatch must fail HERE, loudly, rather
   *  than as a confusing error three messages into a lobby. */
  connect(url = defaultRelayUrl()): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      // Set when the handshake itself REFUSED the relay (a protocol mismatch). We close the
      // socket to say so, and that close fires `onclose` like any other — but this one is not a
      // connection that was lost, it is one we never accepted, and its real reason is already on
      // its way to the caller in the rejection. Without this flag the generic close text
      // OVERWRITES that rejection in the lobby's state (`onLost` runs after the `catch`), so a
      // relay one version behind reported "Connection to the game host was lost." and the actual
      // fault — two numbers that differ, and which file to change — was never shown to anybody.
      let refused = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        return reject(new Error(`Could not reach the relay at ${url}: ${String(err)}`));
      }
      this.ws = ws;

      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        if (!settled) {
          // First message must be the handshake.
          if (msg.t !== "hello") return;
          settled = true;
          if (msg.protocol !== PROTOCOL_VERSION) {
            refused = true;
            ws.close();
            return reject(
              new Error(
                `Relay speaks protocol ${msg.protocol}, this client speaks ${PROTOCOL_VERSION}. Update one of them.`,
              ),
            );
          }
          return resolve();
        }
        this.onMessage(msg);
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error(noRelay(url)));
        }
      };

      ws.onclose = () => {
        const wasSettled = settled;
        settled = true;
        this.ws = null;
        if (refused) return; // we closed it, and the caller already has the reason why
        if (wasSettled) this.onClose("Connection to the game host was lost.");
        else reject(new Error(noRelay(url)));
      };
    });
  }

  send(msg: ClientMessage): void {
    if (this.connected) this.ws!.send(JSON.stringify(msg));
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
