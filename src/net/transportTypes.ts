import type { ClientMessage, ServerMessage } from "./protocol";

// The transport SEAM as a pure type — deliberately split from `transport.ts`, whose
// `WebSocketTransport` reads `import.meta` and `window` and so cannot compile to the CommonJS
// this project's headless tests run as. Anything that needs only the TYPE (the lobby, a test)
// imports it here and stays out of that dependency; `WebSocketTransport` is a value the
// browser wiring injects. See src/net/lobby.ts's header for why this matters.

export interface Transport {
  send(msg: ClientMessage): void;
  close(): void;
  readonly connected: boolean;
  onMessage: (msg: ServerMessage) => void;
  onClose: (reason: string) => void;
}
