// What the Download Replays dialog (ui/replayBrowser.ts) asks of the REPLAY COLLECTION
// (replays-server/server.mjs, docs/replays.md "The collection"): a page of the replays it holds
// under a set of filters, and one replay's bytes. The door is the uploader's own
// (game/replayUpload.ts), read with GET — but unlike the uploader a DEV build reads it too:
// browsing puts nothing into the collection.

/** Where the collection is read: `GET` lists, `GET /<id>` hands a replay out. A build may name
 *  another door with `VITE_REPLAY_BROWSE_URL` (a local `node replays-server/server.mjs`). */
export const REPLAY_BROWSE_URL: string =
  (import.meta.env as Record<string, string | undefined>).VITE_REPLAY_BROWSE_URL ??
  "https://openwar3-replays-production.up.railway.app/replays";

/** A race the list filters by: the four, or `random` — a seat whose lobby said Random. */
export type CatalogRace = "random" | "human" | "orc" | "undead" | "nightelf";

export interface SharedSeat {
  name: string;
  /** The race the seat PLAYED (a custom map's own, now and then). */
  race: string;
  /** The lobby said Random, and the match rolled the race above. */
  random?: boolean;
  team: number;
  color: number;
  computer?: boolean;
}

export interface SharedReplay {
  id: string;
  /** The map's display name, and its file's. */
  map: string;
  mapFile: string;
  /** OpenWar3's version that recorded it. */
  version: string;
  edition: "roc" | "tft";
  recordedAt: string;
  /** The match's length in game seconds; 0 when the replay has no ending. */
  lengthSec: number;
  size: number;
  seats: SharedSeat[];
}

export interface ReplayQuery {
  player: string;
  map: string;
  /** "" = every race. Beside `player` it is about THAT player's seat. */
  race: CatalogRace | "";
  version: string;
  page: number;
  pageSize: number;
}

export interface ReplayPage {
  rows: SharedReplay[];
  total: number;
  /** Every version the collection holds, newest first — the version menu's entries. */
  versions: string[];
}

export interface ReplayCatalog {
  search(q: ReplayQuery, signal: AbortSignal): Promise<ReplayPage>;
  download(r: SharedReplay): Promise<Uint8Array>;
}

async function refusal(r: Response): Promise<Error> {
  const said = await r.json().then((b: { error?: string }) => b.error, () => undefined);
  return new Error(said ?? `the collection answered ${r.status}`);
}

/** The collection itself. */
export function collectionCatalog(base = REPLAY_BROWSE_URL): ReplayCatalog {
  return {
    async search(q, signal) {
      const url = new URL(base);
      for (const [k, v] of Object.entries({ player: q.player, map: q.map, race: q.race, version: q.version })) if (v) url.searchParams.set(k, v);
      url.searchParams.set("page", String(q.page));
      url.searchParams.set("size", String(q.pageSize));
      const r = await fetch(url, { signal });
      if (!r.ok) throw await refusal(r);
      return (await r.json()) as ReplayPage;
    },
    async download(row) {
      const r = await fetch(`${base}/${encodeURIComponent(row.id)}`);
      if (!r.ok) throw await refusal(r);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}
