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

/**
 * How long a piece may go unanswered before it is ASKED FOR AGAIN, and how many times. A request
 * is a relay message like any other and can be lost with the socket it went out on (a relay
 * restart, a host whose tab was frozen for a moment); without a resend ONE lost piece stopped the
 * whole download dead until the stall ran out (issue: a joiner sat at 0% and was then told only
 * "There was an error downloading the map file."). Ours.
 *
 * The FIRST piece is asked for sooner and given up on sooner: until it is answered the joiner
 * does not know the host is listening at all, and the common reason it never is — a host whose
 * OpenWar3 predates map downloads ignores the request — will not change by waiting. 5 × 3 s.
 */
const FIRST_RETRY_MS = 3_000;
const FIRST_TRIES = 5;
/** …and every later piece: 4 × 6 s, ~24 s of a host that has stopped answering. */
const RETRY_MS = 6_000;
const TRIES = 4;
/** How often the resend clock is looked at. */
const TICK_MS = 500;

/** Why a download ended without the map. The dialog words each one differently (ui/mapDownload.ts). */
export type MapFetchFailure =
  /** The host answered with a refusal (its own words are the message). */
  | "refused"
  /** The host never answered the first piece. */
  | "no-answer"
  /** The host answered, then stopped. */
  | "stalled"
  /** What arrived does not add up to the map the host described. */
  | "damaged";

export class MapFetchError extends Error {
  constructor(
    readonly kind: MapFetchFailure,
    message: string,
    /** How far it got: pieces in, pieces in the whole map (0 before the first answer), bytes. */
    readonly received: number,
    readonly total: number,
    readonly size: number,
  ) {
    super(message);
    this.name = "MapFetchError";
  }
}

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
 * Pull the host's map, piece by piece. Resolves with the whole file; rejects with a
 * `MapFetchError` (a refusal, a host that never answers or stops answering, a map that does not
 * add up) or an AbortError on `signal` — the player's Cancel, or the match starting without them.
 *
 * Every piece asked for and not yet answered is asked for AGAIN after `RETRY_MS` (the first after
 * `FIRST_RETRY_MS`), up to `TRIES` times; a second answer to a piece that was asked twice is
 * simply not wanted any more (`pending`).
 */
export function fetchMap(
  wire: MapWire,
  path: string,
  /** How much is in, and the whole map's size in bytes. */
  onProgress: (fraction: number, size: number) => void,
  signal: AbortSignal,
  /** The resend clock, for tests (tools/map-transfer-test.cjs) — a game always takes the defaults. */
  timing: { firstRetryMs?: number; firstTries?: number; retryMs?: number; tries?: number; tickMs?: number } = {},
): Promise<Uint8Array> {
  const { firstRetryMs = FIRST_RETRY_MS, firstTries = FIRST_TRIES, retryMs = RETRY_MS, tries: maxTries = TRIES, tickMs = TICK_MS } = timing;
  return new Promise((resolve, reject) => {
    let out: Uint8Array | null = null;
    let total = 0;
    let next = 0;
    let received = 0;
    /** Piece → when it was last asked for, and how many times. */
    const pending = new Map<number, { at: number; tries: number }>();
    let done = false;
    let clock: ReturnType<typeof setInterval> | null = null;

    const fail = (kind: MapFetchFailure, message: string): void =>
      finish(new MapFetchError(kind, message, received, total, out?.length ?? 0));
    const finish = (err: Error | null): void => {
      if (done) return;
      done = true;
      wire.listen(null);
      if (clock !== null) clearInterval(clock);
      signal.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(out!);
    };
    const onAbort = (): void => finish(new DOMException("Download cancelled.", "AbortError"));
    const request = (chunk: number, tries = 1): void => {
      pending.set(chunk, { at: Date.now(), tries });
      wire.ask({ k: "mapget", path, chunk });
    };
    /** Keep `WINDOW` pieces asked for, once the first answer has said how many there are. */
    const fill = (): void => {
      while (pending.size < WINDOW && next < total) request(next++);
    };
    /** Ask again for what has gone unanswered too long; give up on what has been asked enough. */
    const resend = (): void => {
      const now = Date.now();
      const first = out === null;
      const wait = first ? firstRetryMs : retryMs;
      const tries = first ? firstTries : maxTries;
      for (const [chunk, ask] of pending) {
        if (now - ask.at < wait) continue;
        if (ask.tries >= tries) {
          return first
            ? fail("no-answer", "The host never answered the request for the map.")
            : fail("stalled", `The host stopped sending the map after ${received} of ${total} pieces.`);
        }
        request(chunk, ask.tries + 1);
      }
    };

    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort);
    clock = setInterval(resend, tickMs);
    wire.listen((part) => {
      if (done || part.path !== path || !pending.has(part.chunk)) return; // a stale or repeated answer, or not ours
      if (part.error || part.data === undefined) return fail("refused", part.error ?? "The host refused to send the map.");
      if (!out) {
        if (!(part.size > 0 && part.size <= MAX_MAP_BYTES)) return fail("damaged", `The host's map is not a size a map can be (${part.size} bytes).`);
        out = new Uint8Array(part.size);
        total = chunkCount(part.size);
        next = Math.max(next, 1);
      }
      const bytes = fromBase64(part.data);
      const at = part.chunk * MAP_CHUNK;
      if (part.size !== out.length || bytes.length !== Math.min(MAP_CHUNK, out.length - at)) {
        return fail("damaged", `Piece ${part.chunk} arrived the wrong size.`);
      }
      out.set(bytes, at);
      pending.delete(part.chunk);
      received += 1;
      onProgress(received / total, out.length);
      if (received === total) return finish(null);
      fill();
    });
    // The first piece alone: its answer carries the size, and with it how many more to ask for.
    request(next++);
  });
}
