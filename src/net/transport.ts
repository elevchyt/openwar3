import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "./protocol";

// The transport seam.
//
// Everything above this file — the lobby now, the command stream and snapshots later —
// talks to a `Transport`, never to a WebSocket. That is the whole point: the authority
// module must be transport-agnostic so the SAME code serves all three deployments in
// docs/multiplayer.md (LAN direct, internet via relay, dedicated cloud later). The day we
// move the authority off the host, only the adapter changes.

export interface Transport {
  send(msg: ClientMessage): void;
  close(): void;
  readonly connected: boolean;
  onMessage: (msg: ServerMessage) => void;
  onClose: (reason: string) => void;
}

/** Where the relay lives. Local by default (`node server/relay.mjs`); override with
 *  VITE_RELAY_URL to point a build at a deployed one. */
export function defaultRelayUrl(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const configured = env?.VITE_RELAY_URL;
  if (configured) return configured;
  // Same host as the page, relay port — so opening the dev server from another machine on
  // the LAN (http://192.168.x.x:5173) finds the relay on that machine too, not on 'localhost'
  // which would resolve to the *visitor's* box and silently fail to find the game.
  const host = window.location.hostname || "localhost";
  return `ws://${host}:8787`;
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
          reject(
            new Error(
              `No relay at ${url}. Start one with:  node server/relay.mjs`,
            ),
          );
        }
      };

      ws.onclose = () => {
        const wasSettled = settled;
        settled = true;
        this.ws = null;
        if (wasSettled) this.onClose("Connection to the game host was lost.");
        else reject(new Error(`No relay at ${url}. Start one with:  node server/relay.mjs`));
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
