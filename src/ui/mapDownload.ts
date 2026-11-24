import { showPatchDialog } from "./patchDialog";
import { fetchMap, MapFetchError, MAP_CHUNK as MAP_PIECE } from "../net/mapTransfer";
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
//
// A failure says WHICH failure (`failureLine`): a host that never answered is most often one
// whose OpenWar3 predates map downloads, and "There was an error downloading the map file." told
// the player nothing they could act on. Every outcome is also reported to the OpenWar3 server's
// event log (LanLobby.report) with the reason in full, since the console it used to go to is on
// the player's machine.

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
  noAnswerOld: "The host did not answer. Their OpenWar3 may be too old to send maps — ask them to update, then join again.",
  noAnswer: "The host did not answer the request for the map. Their game may have frozen or lost its connection.",
  refused: "The host could not send the map:",
  unreadable: "The map arrived, but it is not a map this game can read.",
};

/** The line a failed download leaves in the box — one per way it can fail. */
function failureLine(err: unknown, hostVersion: string | undefined, string: (key: string) => string | null): string {
  if (err instanceof MapFetchError) {
    const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
    switch (err.kind) {
      // A host that SAID its version is new enough to send maps, so its silence is something else.
      case "no-answer": return hostVersion ? TEXT.noAnswer : TEXT.noAnswerOld;
      case "refused": return `${TEXT.refused} ${err.message}`;
      case "stalled": {
        const got = Math.min(err.size, err.received * MAP_PIECE);
        return `The host stopped sending the map (${mb(got)} of ${mb(err.size)} MB arrived).`;
      }
      case "damaged": return string("NETERROR_MAPFILEINCOMPLETE") ?? TEXT.failed;
    }
  }
  return err instanceof Error && err.message ? err.message : string("NETERROR_MAPFILEINCOMPLETE") ?? TEXT.failed;
}

export interface MapDownloadOptions {
  container: HTMLElement;
  vfs: DataSource;
  lobby: LanLobby;
  /** The map as the ROOM names it — the host's own path, which is what it serves. */
  mapPath: string;
  mapName: string;
  hostName: string;
  /** The host's OpenWar3 version, if its room said (RoomInfo.version) — words a host's silence. */
  hostVersion?: string;
  /** Can this game read what arrived? Asked before the box closes, so a map that downloaded but
   *  will not open says so here rather than dropping the player back on the list without a word. */
  readable?: (key: string, file: File) => Promise<boolean>;
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
  const began = Date.now();
  /** How far it got, for the reports. */
  let got = { fraction: 0, bytes: 0 };
  lobby.report("map-download-start", { hostVersion: opts.hostVersion ?? null });
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
        lobby.report("map-download-cancelled", { by: "player", fraction: got.fraction, bytes: got.bytes, ms: Date.now() - began });
        abort.abort();
        lobby.leave();
      }
      restore();
      settle(null);
    },
  });

  /** It is over and it did not work: leave the room, and say so in the box until OK. */
  const stop = (title: string, why: string, report: { event: string; detail: Record<string, string | number | boolean | null> }): void => {
    if (!running) return;
    running = false;
    lobby.report(report.event, { ...report.detail, fraction: got.fraction, bytes: got.bytes, ms: Date.now() - began }, "warn");
    abort.abort();
    if (lobby.snapshot.phase === "joined") lobby.leave();
    dialog.finish(title, why, false);
  };

  // The host said go — and left us out, since a seat still downloading is not in the match.
  lobby.onStart = () => stop(TEXT.titleStarted, `|cffff8080${TEXT.started}|r`, { event: "map-download-cancelled", detail: { by: "match-started" } });
  // The room went away under us: the host left, or the relay dropped it.
  lobby.onChange = (st) => {
    if (st.phase !== "joined") stop(TEXT.titleFailed, st.error ?? TEXT.closed, { event: "map-download-cancelled", detail: { by: "room-closed", why: st.error ?? null } });
  };

  try {
    let size: number | null = null;
    const bytes = await fetchMap(lobby.mapWire(), opts.mapPath, (fraction, total) => {
      if (size === null) {
        size = total;
        dialog.setInfo(line(opts.mapName, opts.hostName, total));
      }
      dialog.setProgress(fraction);
      got = { fraction, bytes: Math.round(fraction * total) };
    }, abort.signal);
    if (!running) return closed;
    const kept = await keepDownloadedMap(opts.mapPath, bytes);
    if (!running) return closed;
    if (opts.readable && !(await opts.readable(kept.key, kept.file).catch(() => false))) {
      if (!running) return closed;
      stop(TEXT.titleFailed, TEXT.unreadable, { event: "map-download-failed", detail: { kind: "unreadable", size: bytes.length } });
      return closed;
    }
    if (!running) return closed;
    lobby.report("map-download-done", { size: bytes.length, ms: Date.now() - began, saved: kept.saveError === null, saveError: kept.saveError });
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
      const f = err instanceof MapFetchError ? err : null;
      stop(TEXT.titleFailed, failureLine(err, opts.hostVersion, opts.string), {
        event: "map-download-failed",
        detail: {
          kind: f?.kind ?? "error",
          detail: err instanceof Error ? err.message : String(err),
          received: f?.received ?? null,
          total: f?.total ?? null,
          size: f?.size ?? null,
          hostVersion: opts.hostVersion ?? null,
        },
      });
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
