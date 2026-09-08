import type { DataSource } from "../vfs/types";
import type { MapInfo } from "../world/mapInfo";
import type { MapPreview } from "../world/mapPreview";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { ListItem } from "./fdf/widgets";
import { reachabilityLine, type LanLobby, type LobbyState } from "../net/lobby";
import type { StartMatch } from "../net/protocol";
import { advancedOf, visibilityFog } from "../net/advancedOptions";
import { LAN_JOIN_OVERRIDE, OW3_STRINGS } from "../overrides";
import { showJoinAddressDialog } from "./joinAddressDialog";
import { OBSERVER_PLAYER, type MeleeConfig, type SlotConfig } from "./lobby";
import type { Race } from "../data/races";
import {
  INFO_ROWS, adopt, baseName, clearMapInfo, fillMapInfo, findFrame, layoutInfoPane,
  loadMinimapIcons, nudgeX, paneRowsToHide, readMapInfo, readMapPreviewFor, setProp,
} from "./mapBrowser";

// The Local Area Network screen, built from the game's own
// UI\FrameDef\Glue\LocalMultiplayerJoin.fdf.
//
// WC3's LAN screen lists GAMES on the network, not room codes — and that maps exactly onto
// what our relay serves (src/net/protocol.ts `RoomInfo`), so the original layout needs no
// reinterpretation: the relay IS the discovery mechanism the screen was designed around.
//
// Like Skirmish.fdf, this file declares GameListContainer as an EMPTY frame that the engine
// fills at runtime, so we compose MapListBox.fdf into it through `buildRoot` — the same hook
// and the same reason as ui/fdfSkirmish.ts. Its GameSummaryPanel takes MapInfoPane.fdf, the
// same pane the Custom Game screen carries, showing the MAP of whichever game is highlighted.
//
// This screen is the BROWSER and nothing more (issue #77). Creating a game goes to the create
// screen to pick a map (ui/fdfLanCreate.ts) and joining one goes to the game LOBBY
// (ui/fdfLanLobby.ts, UI\FrameDef\Glue\GameChatroom.fdf) — which is what the real client does,
// and it is why the room's roster is no longer squeezed into this screen's game list: it has a
// screen of its own, with a row per slot.
//
// THE MAP FILE NEVER CROSSES THE WIRE. A room advertises its map's PATH, and every client
// opens that path in its own install — see src/net/protocol.ts `RoomInfo.mapPath` for why
// (legal boundary, and megabytes through a free-tier relay). A player who does not have the
// map is told so and cannot join, rather than being sent one.

const MAP_LIST_FDF = "UI\\FrameDef\\Glue\\MapListBox.fdf";
const MAP_INFO_FDF = "UI\\FrameDef\\Glue\\MapInfoPane.fdf";

/** The stat rows this screen's SHORT summary pane carries: everything but the description,
 *  which needs more height than GameSummaryPanel has (see buildLanRoot). */
const SUMMARY_ROWS = INFO_ROWS.slice(0, 3);

export interface LanHandlers {
  onCancel: () => void;
  /** Go pick a map to host (ui/fdfLanCreate.ts). The room is announced from there, and the
   *  host lands straight in the lobby — it never comes back through this screen. */
  onCreateGame: () => void;
  /** We are in a room: show the game lobby. Fired the moment the relay confirms the join. */
  onJoined: (mapPath: string, info: MapInfo) => void;
}

export async function mountLanScreen(
  container: HTMLElement,
  vfs: DataSource,
  maps: Map<string, File>,
  lobby: LanLobby,
  /** Resolves when the relay connection is up (or rejects with why it is not). Owned by
   *  main.ts along with the lobby, because both outlive this screen. */
  connected: Promise<void>,
  h: LanHandlers,
): Promise<FdfScreen> {
  const minimapIcons = loadMinimapIcons(vfs);
  let screen: FdfScreen;
  /** The screen's own strings — GAMELIST_OBSERVERS, FAST — captured on build. */
  let strings: FdfLibrary | null = null;
  /** The lobby OUTLIVES this screen (main.ts owns it), and the screen it hands over to
   *  installs its own `onChange` while this one is still mounted — GlueManager builds the
   *  next screen before tearing down the last. So the handler below stays installed and goes
   *  quiet instead, rather than being cleared on a dispose that runs too late to matter. */
  let alive = true;

  // The map of the game highlighted in the list. Null while we have no map for it (`missing`).
  let shown: MapInfo | null = null;
  /** …and its markers — start locations, gold mines, the neutral buildings — read out of the
   *  map file a beat after the summary, exactly as the host's own map picker shows them. */
  let preview: MapPreview | null = null;
  /** The highlighted game's map is not in THIS install: its name, for the message. */
  let missing: string | null = null;
  /** Which game in the list is highlighted. */
  let picked: string | null = null;

  // The name you appear as. WC3 remembers this between sessions; so do we.
  const savedName = localStorage.getItem("openwar3.playerName") || "Player";
  const playerName = (): string => screen.editBox("PlayerNameEditBox")?.value?.trim() || savedName;

  /** Read the map a room is advertising, out of OUR install. */
  const showMapOf = async (room: { mapPath: string; mapName: string } | null): Promise<void> => {
    shown = null;
    preview = null;
    missing = null;
    if (!room?.mapPath) { render(screen, lobby.snapshot); return; }
    const info = await readMapInfo(maps, room.mapPath);
    if (info) shown = info;
    else missing = room.mapName || baseName(room.mapPath);
    render(screen, lobby.snapshot);
    if (!info) return;
    // The markers need the map's terrain header and unit list unpacked — a second read, and
    // only for the one game highlighted. Ignored if the highlight has moved on meanwhile.
    const markers = await readMapPreviewFor(vfs, maps, room.mapPath);
    if (!alive || shown !== info) return;
    preview = markers;
    render(screen, lobby.snapshot);
  };

  screen = await mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\LocalMultiplayerJoin.fdf",
    includeFdf: [MAP_LIST_FDF, MAP_INFO_FDF],
    rootFrame: "LocalMultiplayerJoin",
    buildRoot: (lib) => { strings = lib; return buildLanRoot(lib); },
    buttonWidthScale: 1.35,
    // Our own line under the info text: whether other machines can reach this one, and where.
    // The 2003 screen has no frame for it because the 2003 game broadcast — see the override.
    overrides: [OW3_STRINGS, LAN_JOIN_OVERRIDE],
    // The engine's own strings assume Blizzard's LAN browser; ours says what it does.
    textOverrides: {
      CustomCreateTitle: "Local Area Network",
      CustomCreateInfo: "Games on your network appear below.",
      GameListTitle: "Network Games",
      CreateButtonText: "Create Game",
      JoinButtonText: "Join Game",
    },
    // Load a saved game over the network — not in scope, and greying it out is more honest
    // than a button that does nothing.
    hidden: ["LoadBackdrop", ...paneRowsToHide(SUMMARY_ROWS)],
    handlers: {
      CreateButton: () => {
        remember();
        h.onCreateGame(); // pick a map first — the room is announced on the way into the lobby
      },
      JoinButton: () => {
        remember();
        if (picked) lobby.join(picked, playerName());
      },
      // The machines we watch for games — OpenWar3's own dialog, because the game we are
      // copying broadcast and never needed one (src/ui/joinAddressDialog.ts).
      JoinAddressButton: () => {
        void showJoinAddressDialog({
          container,
          vfs,
          lobby,
          onChange: () => { if (alive) render(screen, lobby.snapshot); },
        });
      },
      CancelButton: () => h.onCancel(),
    },
    onBuild: (s) => render(s, lobby.snapshot),
  });

  const remember = (): void => localStorage.setItem("openwar3.playerName", playerName());
  const nameBox = screen.editBox("PlayerNameEditBox");
  if (nameBox) nameBox.value = savedName;

  lobby.onChange = (s) => {
    if (!alive) return;
    // The relay confirmed a join: the room has a screen of its own now (issue #77).
    if (s.phase === "joined" && s.room) {
      const room = s.room;
      alive = false;
      void readMapInfo(maps, room.mapPath).then((info) => {
        if (info) h.onJoined(room.mapPath, info);
      });
      return;
    }
    render(screen, s);
  };
  render(screen, lobby.snapshot);

  const dispose = screen.dispose.bind(screen);
  screen.dispose = (): void => { alive = false; dispose(); };

  // Connecting can fail for exactly one interesting reason — no relay is running — and the
  // fix is a command, so say it on screen rather than only in the console.
  connected.catch((err: Error) => {
    screen.setText("CustomCreateInfo", `|cffff8080${err.message}|r`);
    screen.setEnabled("CreateButton", false);
    screen.setEnabled("JoinButton", false);
  });

  return screen;

  /** Paint the current lobby state onto the screen. */
  function render(s: FdfScreen, st: LobbyState): void {
    const list = s.list("MapListBox");
    // A row is the game's name and its seats, "(1/2)", in the same face as the name and in the
    // LABEL gold the screen's own captions wear (StandardLabelTextTemplate's 0.99 0.827 0.0705)
    // — and, for a game that takes observers, the game's own GAMELIST_OBSERVERS " (observers)".
    const observersTag = strings?.string("GAMELIST_OBSERVERS") ?? " (observers)";
    list?.setItems(
      st.rooms.map((r): ListItem => ({
        // The KEY, not the relay's room id: with more than one machine's games in the list
        // those ids collide (src/net/lobby.ts `ListedRoom`).
        value: r.key,
        label: `${r.name}${r.observers ? observersTag : ""} |cff${LABEL_GOLD}(${r.players}/${r.maxPlayers})|r`,
      })),
    );
    list?.setEnabled(true);
    // Highlighting a game shows ITS map in the summary pane — which is the whole point of
    // the pane on this screen: you look at the map before you decide to join.
    if (list) {
      list.onChange = (value) => {
        picked = value;
        const room = lobby.snapshot.rooms.find((r) => r.key === value);
        void showMapOf(room ?? null);
      };
      list.onActivate = () => {
        if (picked) { remember(); lobby.join(picked, playerName()); }
      };
      if (picked) list.select(picked);
    }
    s.setText("GameListTitle", "Network Games");
    // The two rows under the summary: who made the game, and the one speed we run at — WC3's
    // "Fast" (GlobalStrings FAST), the setting the create screen's slider is parked on.
    const room = picked ? st.rooms.find((r) => r.key === picked) : null;
    s.setText("GameCreatorValue", room?.hostName ?? "");
    s.setText("GameSpeedValue", room ? (strings?.string("FAST") ?? "Fast") : "");
    if (!st.error) {
      s.setText(
        "CustomCreateInfo",
        missing
              ? `|cffff8080You do not have ${missing}. You cannot join this game.|r`
          : st.rooms.length
            ? "Select a game and choose Join."
            : "No games found. Create one.",
      );
    }

    // What the relay told us about this machine (`HostInfo`) — ours, not WC3's, in a frame of
    // our own under the screen's own sentence. Only the WARNING half: this screen says when
    // nobody can see your games, because nothing else ever will, but it does not print the
    // address. That belongs where it is USED — on the game lobby, beside a game there is
    // something to join, and in the Join Server dialog where the addresses live.
    const reach = reachabilityLine(st.host);
    s.setText("NetworkStatusText", reach?.warn ? `|cffff8080${reach.text}|r` : "");

    // The map summary: the highlighted game's map, with its markers once they have been read.
    if (shown) fillMapInfo(s, shown, preview, minimapIcons);
    else clearMapInfo(s);

    if (st.error) s.setText("CustomCreateInfo", `|cffff8080${st.error}|r`);

    s.setEnabled("CreateButton", st.phase === "browsing");
    s.setEnabled("JoinButton", st.phase === "browsing" && !!picked && !missing);
  }
}

/** The name this machine plays under — what the create screen announces its room as, and what
 *  a joiner appears as in the lobby's rows. Kept in localStorage, as WC3 keeps it between
 *  sessions, so every LAN screen reads the same answer without threading it between them. */
export function savedPlayerName(): string {
  return localStorage.getItem("openwar3.playerName") || "Player";
}

/** The gold every label on these screens is set in — `StandardLabelTextTemplate`'s FontColor
 *  0.99 0.827 0.0705, as a WC3 colour code. The list's own rows are white by default, so a
 *  row that wants to match its captions has to say so. */
export const LABEL_GOLD = "fcd312";

/**
 * The Observers bench as the match numbers it: the first watcher is `OBSERVER_PLAYER`, the
 * next one past it, and so on — outside the alliance matrix and the sim's player range, for
 * the reasons OBSERVER_PLAYER gives. Every machine numbers them the same way off the same
 * `start`, which is what lets the host address one by number and the watcher answer to it.
 */
export function observerSeats(msg: StartMatch): Array<{ id: number; peer: number; name: string }> {
  return (msg.observers ?? []).map((o, i) => ({ id: OBSERVER_PLAYER + i, peer: o.peer, name: o.name }));
}

/** A start message as THIS machine's `MeleeConfig` — the same match, seen from our seat.
 *  Exported for the game lobby (which sends it) and for the dev-LAN boot, which overrides
 *  only `fog`. */
export function toConfig(msg: StartMatch, me: number | undefined): MeleeConfig {
  const slots: SlotConfig[] = msg.slots.map((s) => ({
    id: s.id,
    controller: s.controller,
    race: s.race as Race,
    team: s.team,
    startX: s.startX,
    startY: s.startY,
    ...(s.color === undefined ? {} : { color: s.color }),
    ...(s.peer === undefined ? {} : { peer: s.peer }),
    ...(s.aiDifficulty === undefined ? {} : { aiDifficulty: s.aiDifficulty }),
    ...(s.aiPlus === undefined ? {} : { aiPlus: s.aiPlus }),
    ...(s.name === undefined ? {} : { playerName: s.name }),
  }));
  const advanced = advancedOf(msg.advanced);
  const observers = observerSeats(msg);
  // Our seat — or our place on the bench. Every human slot says "user", so the peer is the
  // only thing that tells two clients apart (see MeleeConfig.localPlayer); a watcher's peer
  // is on the bench instead, and that machine plays nobody (MeleeConfig.observer).
  const seat = slots.find((s) => s.peer === me)?.id;
  const watching = seat === undefined ? observers.find((o) => o.peer === me) : undefined;
  return {
    slots,
    // Advanced Options → Visibility. An older host's `start` carries none and reads as the
    // pane's own default, the game's ordinary fog.
    fog: visibilityFog(advanced.visibility),
    seed: msg.seed,
    localPlayer: watching ? watching.id : seat,
    ...(watching ? { observer: true } : {}),
    ...(observers.length ? { observers } : {}),
    lockTeams: advanced.lockTeams,
    sharedControl: advanced.sharedControl,
  };
}

/** Compose the screen the way the engine does: MapListBox.fdf into the empty game-list
 *  container, MapInfoPane.fdf into the summary panel beside it. */
function buildLanRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("LocalMultiplayerJoin");
  if (!root) throw new Error("LocalMultiplayerJoin.fdf: no LocalMultiplayerJoin frame");

  // NOTE: this screen chains its anchors down a ladder of unsized TEXT frames
  // (title → label → editbox → list, each SetPoint TOPLEFT … BOTTOMLEFT). Those get their
  // one-line height from the layout solver itself (ui/fdf/layout.ts `textBoxHeight`) — it
  // used to inherit the parent's height and push the list clean off the screen.
  const listBox = lib.resolveRoot("MapListBox");
  if (listBox) {
    setProp(listBox, "SetAllPoints", []); // fill the container the FDF already sized
    adopt(root, "GameListContainer", [listBox]);
  }

  // This screen's summary pane is the SHORT one — 0.223125 against Skirmish's 0.2875, because
  // the Game Creator / Game Speed rows sit underneath it. There is no room in it for a map's
  // description, so it carries the three stat rows and stops: a compact summary of the game
  // you are about to join, which is what the panel is called.
  const pane = lib.resolveRoot("MapInfoPane");
  if (pane) {
    adopt(root, "MapInfoPaneContainer", [
      layoutInfoPane(pane, { w: PANE_W, h: PANE_H, rows: SUMMARY_ROWS }),
    ]);
  }

  // …and the summary panel moves left to sit inside the 3D chrome that frames it, exactly as
  // the Custom Game screen's does (see nudgeX). The Game Creator / Game Speed rows are
  // anchored to the pane's own BOTTOM, so they travel with it.
  nudgeX(findFrame(root, "MapInfoPaneContainer"), -MAP_INFO_NUDGE);
  return root;
}

/** How far left the summary panel's contents move to sit inside the 3D chrome. */
const MAP_INFO_NUDGE = 0.052;

/** LocalMultiplayerJoin.fdf's own MapInfoPaneContainer box. */
const PANE_W = 0.271875;
const PANE_H = 0.223125;

/**
 * Put a string on the clipboard, by whichever route this page is allowed.
 *
 * `navigator.clipboard` is gated on a SECURE CONTEXT, and the two ways OpenWar3 is served fall
 * on opposite sides of that line: the desktop app's window is `http://127.0.0.1`, which browsers
 * treat as trustworthy, while a second machine reaching the dev server at `http://192.168.x.x`
 * is not — and that is exactly the player who most needs to copy an address. So the old
 * selection trick stays as the fallback rather than the feature quietly doing nothing on half
 * the machines that run it.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable — fall through rather than fail.
  }
  try {
    const box = document.createElement("textarea");
    box.value = text;
    // Off-screen but focusable: `execCommand` copies the SELECTION, so the text has to be in a
    // real, selectable element in the document.
    box.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand("copy");
    box.remove();
    return ok;
  } catch {
    return false;
  }
}
