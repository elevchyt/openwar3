import { showPatchDialog } from "./patchDialog";
import { fetchMap } from "../net/mapTransfer";
import { keepDownloadedMap } from "../assets/downloadedMaps";
import type { LanLobby } from "../net/lobby";
import type { DataSource } from "../vfs/types";

// "Downloading Map" — a LAN game's map, fetched from its host when the joiner's install lacks it
// (net/mapTransfer.ts), in the box the game used for downloads: `BattleNetPatchDialog`
// (ui/patchDialog.ts), the one Voice Control's model comes down in too.
//
// The joiner is IN THE ROOM while it runs — the host is reached through it — but not yet in the
// lobby screen, which needs the map to draw. The host prints the joiner's progress in the row's
// own `DownloadValue` column and leaves the seat out of any start until the map is in
// (net/lobbySetup.ts `LobbySlot.download`). So the host CAN start without them, and when it does
// the download is pointless: it is cancelled, the room is left, and the box says why — the one
// line the player must not be left guessing at.
//
// Cancel or Escape while it runs leaves the room too, and nothing half-downloaded is kept.

/** The box's words. The title and the failure are the game's own (`GlobalStrings.fdf`
 *  DOWNLOADING_MAP, `NetworkStrings.fdf` NETERROR_MAPFILEINCOMPLETE), asked of the screen's
 *  string table and falling back on the same text; the rest is ours. */
const TEXT = {
  title: "Downloading Map",
  failed: "There was an error downloading the map file.",
  titleStarted: "Download Cancelled",
  started: "Match started before the download could finish.",
  titleFailed: "Download Failed",
  closed: "The game is no longer available.",
};

export interface MapDownloadOptions {
  container: HTMLElement;
  vfs: DataSource;
  lobby: LanLobby;
  /** The map as the ROOM names it — the host's own path, which is what it serves. */
  mapPath: string;
  mapName: string;
  hostName: string;
  /** A string out of the screen's FDF tables, or null. */
  string: (key: string) => string | null;
}

/**
 * Fetch the room's map with the box up. Resolves with the map's key in the install's list and its
 * `File` once it is in and kept, or null — Cancel, a failure, the host starting without us — by
 * which time the room has been left and the box closed.
 */
export async function showMapDownload(opts: MapDownloadOptions): Promise<{ key: string; file: File } | null> {
  const { lobby } = opts;
  const abort = new AbortController();
  /** Still fetching: the button is Cancel and the room is ours to leave. */
  let running = true;
  let settle: (got: { key: string; file: File } | null) => void = () => {};
  const closed = new Promise<{ key: string; file: File } | null>((r) => (settle = r));

  const prevChange = lobby.onChange;
  const prevStart = lobby.onStart;
  const restore = (): void => {
    lobby.onChange = prevChange;
    lobby.onStart = prevStart;
  };

  const dialog = await showPatchDialog({
    container: opts.container,
    vfs: opts.vfs,
    title: opts.string("DOWNLOADING_MAP") ?? TEXT.title,
    info: line(opts.mapName, opts.hostName, null),
    className: "map-download",
    onClose: () => {
      if (running) {
        running = false;
        abort.abort();
        lobby.leave();
      }
      restore();
      settle(null);
    },
  });

  /** It is over and it did not work: leave the room, and say so in the box until OK. */
  const stop = (title: string, why: string): void => {
    if (!running) return;
    running = false;
    abort.abort();
    if (lobby.snapshot.phase === "joined") lobby.leave();
    dialog.finish(title, why, false);
  };

  // The host said go — and left us out, since a seat still downloading is not in the match.
  lobby.onStart = () => stop(TEXT.titleStarted, `|cffff8080${TEXT.started}|r`);
  // The room went away under us: the host left, or the relay dropped it.
  lobby.onChange = (st) => {
    if (st.phase !== "joined") stop(TEXT.titleFailed, st.error ?? TEXT.closed);
  };

  try {
    let size: number | null = null;
    const bytes = await fetchMap(lobby.mapWire(), opts.mapPath, (fraction, total) => {
      if (size === null) {
        size = total;
        dialog.setInfo(line(opts.mapName, opts.hostName, total));
      }
      dialog.setProgress(fraction);
    }, abort.signal);
    if (!running) return closed;
    const kept = await keepDownloadedMap(opts.mapPath, bytes);
    if (!running) return closed;
    // Kept in memory for this session either way; a write that failed only means the next game
    // on this map downloads it again.
    if (kept.saveError) console.warn(`[OpenWar3] the downloaded map was not saved: ${kept.saveError}`);
    running = false;
    dialog.close();
    // Until the lobby screen hooks the room up for itself — a beat away — a start is still ours
    // to answer, and there is no lobby to start it from: leave rather than sit in a dead room.
    // The host counts us downloading until that screen says otherwise (`MapWire.arrived`), so
    // this start left us out too.
    lobby.onChange = prevChange;
    lobby.onStart = () => {
      console.warn("[OpenWar3] the match started before the downloaded map could be opened");
      lobby.leave();
    };
    settle({ key: kept.key, file: kept.file });
  } catch (err) {
    if (running) {
      // The box says it in the game's own one line; the why is for the console.
      console.warn("[OpenWar3] map download failed:", err);
      stop(TEXT.titleFailed, opts.string("NETERROR_MAPFILEINCOMPLETE") ?? TEXT.failed);
    }
  }
  return closed;
}

/** The running line: which map, from whom, and (once the first piece has said) how big. One
 *  line, because it sits directly over the bar (patchDialog.ts `finish`). */
function line(mapName: string, hostName: string, bytes: number | null): string {
  const size = bytes === null ? "" : ` (${(bytes / (1024 * 1024)).toFixed(1)} MB)`;
  return `${mapName}${size} from ${hostName}`;
}
