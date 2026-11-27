// Types for server/wsAdapter.mjs, the socket half of the relay (tools/vite-plugin-relay.ts
// mounts it on the dev server's HTTP server). Returns the sweep's stop().

import type { WebSocketServer } from "ws";
import type { RelayCore } from "./rooms.mjs";

export function attachRelay(
  wss: WebSocketServer,
  core: RelayCore,
  opts?: { heartbeatMs?: number; maxConnections?: number; maxMessagesPerSecond?: number },
): () => void;

export const MAX_PAYLOAD: number;
export const MAX_CONNECTIONS: number;
export const MAX_MESSAGES_PER_SECOND: number;
