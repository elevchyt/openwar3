// A LAN game's MAP, handed from the host to a joiner whose install lacks it — the way Warcraft
// III's own lobby sent a custom map to whoever joined without it (ui/mapDownload.ts shows it,
// assets/downloadedMaps.ts keeps it in `Maps\Download\`).
//
// It travels as ordinary game traffic inside `relay`/`deliver` (src/net/protocol.ts), so the relay
// stays the dumb forwarder it is and needs no change: it never learns that a map is crossing, and
// a relay that cannot see a message cannot be asked to treat it differently. JSON is the relay's
// framing, so each piece is base64.
//
// The JOINER PULLS. It asks for piece n and the host answers with piece n, never more than
// `WINDOW` pieces in flight — so a map of several megabytes cannot fill the host's socket ahead
// of the lobby's own traffic (seating, chat, the countdown), and a joiner that goes away simply
// stops asking. The host has nothing to clean up but an entry in `LobbyState.downloads`.
//
// The host serves exactly ONE file: the map of the room it is hosting, named by the path it
// advertised. A request for any other path is refused, whatever it names — a peer in a room is
// not a reader of the host's disk.

/** Joiner → host: "piece `chunk` of the map at `path`, please". */
export interface MapGet {
  k: "mapget";
  path: string;
  chunk: number;
}

/** Host → joiner: one piece, with the whole file's size so the joiner knows how many to ask for.
 *  `error` instead of `data` is a refusal, and ends the download. */
export interface MapPart {
  k: "mappart";
  path: string;
  chunk: number;
  size: number;
  data?: string;
  error?: string;
}

/** Joiner → host: the whole map is in — the host stops counting it as downloading, and its seat
 *  is in the next start. */
export interface MapGot {
  k: "mapgot";
  path: string;
}

/** Bytes per piece: 48 KiB, 64 KiB of base64 — small beside the relay's frame limit, large enough
 *  that a several-megabyte map is a few hundred round trips rather than thousands. */
export const MAP_CHUNK = 48 * 1024;

/** Pieces in flight at once. Eight is ~400 KiB a round trip: a few seconds for a big map over the
 *  internet, and it leaves the wire to the lobby between them. */
const WINDOW = 8;

/** How long a piece may take before the host is taken to have stopped sending. */
const STALL_MS = 20_000;

/** The largest map a host will hand out — what the 1.30+ editor allows a map to be (128 MB),
 *  so nothing a real map can be is refused, and nothing larger is pushed through a relay. */
export const MAX_MAP_BYTES = 128 * 1024 * 1024;

export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / MAP_CHUNK));
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  // In slices: `String.fromCharCode(...bytes)` on 48 KiB overflows the argument limit on some engines.
  for (let i = 0; i < bytes.length; i += 0x2000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The map's bytes, read once per file and shared by every piece and every joiner. Read WHOLE
 * through `arrayBuffer()` rather than sliced: the desktop app's map files are lazy stubs
 * (assets/remoteInstall.ts `lazyMapFile`) whose `size` and `slice` mean nothing until they are
 * read, and a picked `File` re-read per piece would read a large map hundreds of times over.
 */
const mapBytes = new WeakMap<File, Promise<Uint8Array>>();
function bytesOf(file: File): Promise<Uint8Array> {
  let read = mapBytes.get(file);
  if (!read) {
    read = file.arrayBuffer().then((b) => new Uint8Array(b));
    read.catch(() => mapBytes.delete(file)); // a failed read is not remembered
    mapBytes.set(file, read);
  }
  return read;
}

/**
 * The host's answer to one `mapget`. `file` is the room's map, or null when the host cannot read
 * it; `roomPath` is the path the room advertised, the only one this ever serves.
 */
export async function answerMapGet(file: File | null, roomPath: string, msg: MapGet): Promise<MapPart> {
  const refuse = (error: string): MapPart => ({ k: "mappart", path: msg.path, chunk: msg.chunk, size: 0, error });
  if (msg.path !== roomPath) return refuse("The host only sends the map of its own game.");
  if (!file) return refuse("The host could not read its map.");
  let bytes: Uint8Array;
  try {
    bytes = await bytesOf(file);
  } catch {
    return refuse("The host could not read its map.");
  }
  if (bytes.length > MAX_MAP_BYTES) return refuse("The map is too large to send.");
  const n = Math.floor(msg.chunk);
  if (!(n >= 0 && n < chunkCount(bytes.length))) return refuse("No such part of the map.");
  return { k: "mappart", path: msg.path, chunk: n, size: bytes.length, data: toBase64(bytes.subarray(n * MAP_CHUNK, (n + 1) * MAP_CHUNK)) };
}

/** What `fetchMap` needs of the lobby: a way to ask the host, and a way to hear its answers. */
export interface MapWire {
  ask(msg: MapGet): void;
  /** Install the handler for `mappart`s; called with null to take it down again. */
  listen(fn: ((part: MapPart) => void) | null): void;
  /** Tell the host the map is in (`MapGot`). */
  arrived(path: string): void;
}

/**
 * Pull the host's map, piece by piece. Resolves with the whole file; rejects on a refusal, a host
 * that stops answering, or `signal` — the player's Cancel, or the match starting without them.
 */
export function fetchMap(
  wire: MapWire,
  path: string,
  /** How much is in, and the whole map's size in bytes. */
  onProgress: (fraction: number, size: number) => void,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let out: Uint8Array | null = null;
    let total = 0;
    let next = 0;
    let received = 0;
    const pending = new Set<number>();
    let stall: ReturnType<typeof setTimeout> | null = null;

    const finish = (err: Error | null): void => {
      wire.listen(null);
      if (stall !== null) clearTimeout(stall);
      signal.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(out!);
    };
    const onAbort = (): void => finish(new DOMException("Download cancelled.", "AbortError"));
    const armStall = (): void => {
      if (stall !== null) clearTimeout(stall);
      stall = setTimeout(() => finish(new Error("The host stopped sending the map.")), STALL_MS);
    };
    const request = (chunk: number): void => {
      pending.add(chunk);
      wire.ask({ k: "mapget", path, chunk });
    };
    /** Keep `WINDOW` pieces asked for, once the first answer has said how many there are. */
    const fill = (): void => {
      while (pending.size < WINDOW && next < total) request(next++);
    };

    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort);
    wire.listen((part) => {
      if (part.path !== path || !pending.has(part.chunk)) return; // a stale answer, or not ours
      if (part.error || part.data === undefined) return finish(new Error(part.error ?? "The host refused to send the map."));
      if (!out) {
        if (!(part.size > 0 && part.size <= MAX_MAP_BYTES)) return finish(new Error("The host's map is not a size a map can be."));
        out = new Uint8Array(part.size);
        total = chunkCount(part.size);
        next = Math.max(next, 1);
      }
      const bytes = fromBase64(part.data);
      const at = part.chunk * MAP_CHUNK;
      if (part.size !== out.length || bytes.length !== Math.min(MAP_CHUNK, out.length - at)) {
        return finish(new Error("The map arrived damaged."));
      }
      out.set(bytes, at);
      pending.delete(part.chunk);
      received += 1;
      onProgress(received / total, out.length);
      if (received === total) return finish(null);
      armStall();
      fill();
    });
    armStall();
    // The first piece alone: its answer carries the size, and with it how many more to ask for.
    request(next++);
  });
}
