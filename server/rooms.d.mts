// Types for server/rooms.mjs, whose relay the dev server mounts (tools/vite-plugin-relay.ts).
// Only the surface that plugin touches is declared; the room protocol itself lives in
// src/net/protocol.ts.

export const PROTOCOL_VERSION: number;

export interface RelayConn {
  readonly send: (msg: unknown) => void;
  roomId?: number | null;
  peerId?: number;
}

export class RelayCore {
  constructor(opts?: { describeHost?: (() => unknown) | null; holdMs?: number });
  readonly rooms: Map<unknown, unknown>;
  readonly conns: Set<RelayConn>;
  listing(): unknown[];
  broadcastRooms(): void;
  connect(conn: RelayConn): void;
}
