// The slice of `ws` the dev relay uses (tools/vite-plugin-relay.ts). `ws` is a devDependency
// loaded only by the dev server, so one hand-written declaration is cheaper than pulling
// @types/ws in for a single call site.

declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export interface WebSocket {
    readonly OPEN: number;
    readonly readyState: number;
    send(data: string): void;
    ping(): void;
    terminate(): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export interface WebSocketServerOptions {
    noServer?: boolean;
    port?: number;
  }

  export class WebSocketServer {
    constructor(opts?: WebSocketServerOptions);
    on(event: "connection", listener: (ws: WebSocket, req: IncomingMessage) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
    handleUpgrade(
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      cb: (ws: WebSocket) => void,
    ): void;
    close(): void;
  }
}
