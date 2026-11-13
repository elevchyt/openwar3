// The REPLAY UPLOADER (issue #158) — every finished MULTIPLAYER replay is sent to OpenWar3's own
// collection, so the matches people actually play can be studied and, in time, an AI that plays
// like a person can be trained on them. It is not optional (the developer's call, which retired
// the "Share Replays" option): the HOST of a multiplayer match, the one machine that records it,
// uploads it as it hands it to the other players. A single-player match is never uploaded.
//
// Where they go: the `openwar3-replays` service in the Railway project the relays live in
// (`replays-server/server.mjs`), which files them in that project's PRIVATE bucket
// (`REPLAY_UPLOAD_URL`). How they get there:
//
//   · a replay is offered the moment its match ends (MapViewerScene.closeReplay), in memory;
//   · a send that fails for a reason that may pass (offline, a 5xx, a 429) is kept in a small
//     queue in IndexedDB — the page's own store, which the desktop app and a browser both have —
//     and tried again on the next launch and after the next match, so a player who is offline
//     loses nothing; one the collection REFUSED (any other 4xx: not a replay, too large) is
//     dropped instead, because it will be refused for ever and the queue drains in order;
//   · the queue is CAPPED (`MAX_QUEUED`, oldest dropped), so a machine that is never online does
//     not grow it for ever;
//   · the request carries the replay's bytes and three headers — the OpenWar3 version, the
//     replay format, and an ANONYMOUS install id (a random one made on first use, kept in
//     localStorage), which is what lets a collection tell one player's matches from another's
//     without knowing who anybody is.
//
// A DEV build (`pnpm dev`) sends nothing unless `VITE_REPLAY_UPLOAD_URL` names a door: the
// developer's own test matches would otherwise fill the collection (and the store's monthly
// write allowance) with debug runs.
//
// What a replay HOLDS: the names the players typed, every chat line they sent (game/replay.ts) and
// each player's own camera, selections and cursor (game/inputTrack.ts) — and the host's anonymous
// install id on its seat. Nothing that names a person outside the game.

import { REPLAY_FORMAT } from "./replay";

/** Where replays are sent: the collection service (replays-server/, Railway). A build may
 *  name another with `VITE_REPLAY_UPLOAD_URL`; a dev build sends nowhere unless it does. Ours. */
export const REPLAY_UPLOAD_URL: string =
  (import.meta.env as Record<string, string | undefined>).VITE_REPLAY_UPLOAD_URL ??
  (import.meta.env.DEV ? "" : "https://openwar3-replays-production.up.railway.app/replays");

/** The most replays kept waiting for a connection. Ours. */
const MAX_QUEUED = 50;

const DB_NAME = "openwar3-replay-uploads";
const STORE = "queue";
const INSTALL_ID_KEY = "ow3.installId";

/** OpenWar3's version, from package.json (vite.config.ts `define`). */
declare const __OW3_VERSION__: string;

/** A random id for this install, made once. Not the player: nothing ties it to a person. */
export function installId(): string {
  try {
    let id = localStorage.getItem(INSTALL_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(INSTALL_ID_KEY, id);
    }
    return id;
  } catch {
    return "unknown";
  }
}

function openQueue(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openQueue();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}

/** What became of one send: TAKEN, worth trying AGAIN later, or REFUSED for good. */
type Sent = "taken" | "again" | "refused";

/** Send one replay. */
async function send(bytes: Uint8Array): Promise<Sent> {
  if (!REPLAY_UPLOAD_URL) return "again";
  try {
    const r = await fetch(REPLAY_UPLOAD_URL, {
      method: "POST",
      body: bytes as BodyInit,
      headers: {
        "content-type": "application/octet-stream",
        "x-ow3-version": __OW3_VERSION__,
        "x-ow3-replay-format": String(REPLAY_FORMAT),
        "x-ow3-install": installId(),
      },
    });
    if (r.ok) return "taken";
    // 408 and 429 pass; every other 4xx is the collection saying "never this file".
    return r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429 ? "refused" : "again";
  } catch {
    return "again";
  }
}

/** The uploader. What it is OFFERED is the caller's decision — a multiplayer match's replay, by
 *  its host (MapViewerScene.closeReplay). */
export class ReplayUploader {
  private draining = false;

  /** A match has ended: send its replay, and keep it for later if that fails. */
  async offer(bytes: Uint8Array): Promise<void> {
    if (!REPLAY_UPLOAD_URL) return;
    const sent = await send(bytes);
    if (sent !== "again") {
      void this.drain();
      return;
    }
    await withStore("readwrite", (s) => s.add(bytes));
    const keys = (await withStore("readonly", (s) => s.getAllKeys())) ?? [];
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_QUEUED))) await withStore("readwrite", (s) => s.delete(k));
  }

  /** Send whatever is waiting, oldest first, stopping at the first send worth trying again — a
   *  refused one is dropped and the drain goes on past it. */
  async drain(): Promise<void> {
    if (this.draining || !REPLAY_UPLOAD_URL) return;
    this.draining = true;
    try {
      const keys = (await withStore("readonly", (s) => s.getAllKeys())) ?? [];
      for (const k of keys) {
        const bytes = await withStore<Uint8Array>("readonly", (s) => s.get(k) as IDBRequest<Uint8Array>);
        if (bytes && (await send(bytes)) === "again") return;
        await withStore("readwrite", (s) => s.delete(k));
      }
    } finally {
      this.draining = false;
    }
  }
}
