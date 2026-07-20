import type { DataSource } from "../vfs/types";
import type { MapInfo } from "../world/mapInfo";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { ListItem } from "./fdf/widgets";
import { LanLobby, type LobbyState } from "../net/lobby";
import { matchLinkFrom, type MatchLinkSetup } from "../game/matchLink";
import type { StartMatch } from "../net/protocol";
import type { MeleeConfig, SlotConfig } from "./lobby";
import type { Race } from "../data/races";
import {
  INFO_ROWS, adopt, baseName, clearMapInfo, fillMapInfo, findFrame, layoutInfoPane,
  loadMinimapIcons, nudgeX, paneRowsToHide, readMapInfo, setProp,
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
// Choosing that map is the create screen's job (ui/fdfLanCreate.ts): the game you announce IS
// a map, so Create Game goes there first and comes back with one.
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
  /** Go pick a map to host. Comes back through `hostWith` on the screen this returns. */
  onCreateGame: () => void;
  /** The match is on — for the host the moment it presses Start, for a client the moment the
   *  host's `start` lands. Both are handed the same map and the same config, plus the match's
   *  end of the wire (`link`), assembled here because the lobby does not outlive this screen. */
  onStart: (mapPath: string, info: MapInfo, config: MeleeConfig, link: MatchLinkSetup) => void;
}

/** The LAN screen, plus the one thing the create screen needs to hand back to it. */
export interface LanScreen extends FdfScreen {
  /** Announce a room on the map the create screen picked. */
  hostWith(mapPath: string, info: MapInfo): void;
}

export async function mountLanScreen(
  container: HTMLElement,
  vfs: DataSource,
  maps: Map<string, File>,
  h: LanHandlers,
): Promise<LanScreen> {
  const lobby = new LanLobby();
  const minimapIcons = loadMinimapIcons(vfs);
  let screen: LanScreen;

  // The map of whatever the screen is currently showing — the room we are in, or the game
  // highlighted in the list. Null while we have no map for it (see `missing`).
  let shown: MapInfo | null = null;
  /** The highlighted game's map is not in THIS install: its name, for the message. */
  let missing: string | null = null;
  /** Which game in the list is highlighted (the roster reuses the same list when in a room). */
  let picked: string | null = null;

  // The name you appear as. WC3 remembers this between sessions; so do we.
  const savedName = localStorage.getItem("openwar3.playerName") || "Player";
  const playerName = (): string => screen.editBox("PlayerNameEditBox")?.value?.trim() || savedName;

  /** Read the map a room is advertising, out of OUR install. */
  const showMapOf = async (room: { mapPath: string; mapName: string } | null): Promise<void> => {
    shown = null;
    missing = null;
    if (!room?.mapPath) { render(screen, lobby.snapshot); return; }
    const info = await readMapInfo(maps, room.mapPath);
    if (info) shown = info;
    else missing = room.mapName || baseName(room.mapPath);
    render(screen, lobby.snapshot);
  };

  screen = await mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\LocalMultiplayerJoin.fdf",
    includeFdf: [MAP_LIST_FDF, MAP_INFO_FDF],
    rootFrame: "LocalMultiplayerJoin",
    buildRoot: (lib) => buildLanRoot(lib),
    buttonWidthScale: 1.35,
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
        h.onCreateGame(); // pick a map first — the room is announced on the way back
      },
      JoinButton: () => {
        remember();
        // In a room this button is the HOST's Start Game; in the browser it joins the
        // highlighted game. One button, the two things the screen can do at that moment.
        if (lobby.isHost) return startMatch();
        if (picked) lobby.join(picked, playerName());
      },
      CancelButton: () => {
        // In a room, Cancel backs out of the room first — one Cancel, one level, as the
        // original does. Only from the browser does it leave the screen.
        if (lobby.snapshot.phase === "hosting" || lobby.snapshot.phase === "joined") lobby.leave();
        else {
          lobby.dispose();
          h.onCancel();
        }
      },
    },
    onBuild: (s) => render(s as LanScreen, lobby.snapshot),
  }) as LanScreen;

  /**
   * Start the match. Host only.
   *
   * The host builds the ONE config every machine will run — which map, who sits where, and
   * the seed — sends it, and applies its own copy. Nobody else rolls anything: a second seed
   * would be a second match (docs/multiplayer.md Phase A).
   */
  const startMatch = (): void => {
    const room = lobby.snapshot.room;
    if (!room || !shown || !lobby.isHost) return;
    const msg = buildStart(room.mapPath, room.mapName, shown, lobby.snapshot);
    lobby.startMatch(msg);
    enter(msg);
  };

  /** Act on a start message — the host on its own, a client on the host's. */
  const enter = (msg: StartMatch): void => {
    const me = lobby.snapshot.you?.id;
    void (async () => {
      const info = await readMapInfo(maps, msg.mapPath);
      if (!info) {
        // Should not happen: a client without the map could never have joined. Say so
        // rather than dropping into a black screen.
        screen.setText("CustomCreateInfo", `|cffff8080You do not have ${msg.mapName}.|r`);
        return;
      }
      // The match's end of the wire, assembled HERE because this is the last place the lobby
      // and the seating exist together — `startGame` disposes the glue and never sees the
      // lobby (docs/multiplayer.md Phase E item 10b-note). `matchLinkFrom` is shared with the
      // dev-LAN boot so the harness proves this exact assembly, not a lookalike.
      const hostPeer = lobby.snapshot.peers.find((p) => p.host)?.id ?? 1;
      const link = matchLinkFrom(lobby, lobby.isHost, msg.slots, me, hostPeer);
      h.onStart(msg.mapPath, info, toConfig(msg, me), link);
    })();
  };

  lobby.onStart = (msg) => enter(msg);

  const remember = (): void => localStorage.setItem("openwar3.playerName", playerName());
  const nameBox = screen.editBox("PlayerNameEditBox");
  if (nameBox) nameBox.value = savedName;

  lobby.onChange = (s) => {
    // In a room, the summary follows the ROOM's map; in the browser, the highlighted game's.
    const room = s.room;
    if (room && room.mapPath !== currentMapPath) {
      currentMapPath = room.mapPath;
      void showMapOf(room);
      return;
    }
    if (!room) currentMapPath = null;
    render(screen, s);
  };
  let currentMapPath: string | null = null;
  render(screen, lobby.snapshot);

  // Connecting can fail for exactly one interesting reason — no relay is running — and the
  // fix is a command, so say it on screen rather than only in the console.
  const connected = lobby.connect();
  connected.catch((err: Error) => {
    screen.setText("CustomCreateInfo", `|cffff8080${err.message}|r`);
    screen.setEnabled("CreateButton", false);
    screen.setEnabled("JoinButton", false);
  });

  screen.hostWith = (mapPath: string, info: MapInfo): void => {
    shown = info;
    missing = null;
    currentMapPath = mapPath;
    // WAIT for the socket. This runs the moment the screen is mounted on the way back from
    // the create screen, which is well before `connect()` has resolved — and a `LanLobby`
    // with no transport yet drops a send on the floor without a word, so announcing here
    // directly meant the room silently never existed.
    void connected.then(() => {
      lobby.host(`${playerName()}'s Game`, playerName(), info.name || baseName(mapPath), mapPath, info.slots.length);
    }).catch(() => {}); // the failure is already on screen, above
  };

  const dispose = screen.dispose.bind(screen);
  screen.dispose = () => {
    lobby.dispose();
    dispose();
  };
  return screen;

  /** Paint the current lobby state onto the screen. */
  function render(s: LanScreen, st: LobbyState): void {
    const list = s.list("MapListBox");
    const inRoom = st.phase === "hosting" || st.phase === "joined";

    if (inRoom && st.room) {
      // In a room the list becomes the player list — the original swaps to a lobby view here;
      // reusing the one list keeps this slice to the frames the FDF actually gives us.
      list?.setItems(
        st.peers.map((p): ListItem => ({
          value: `peer${p.id}`,
          label: p.host ? `${p.name}  |cffffcc00(host)|r` : p.name,
        })),
      );
      list?.setEnabled(false); // a roster, not a chooser
      s.setText("GameListTitle", st.room.name);
      s.setText("GameCreatorValue", st.room.hostName);
      s.setText("GameSpeedValue", `${st.peers.length} / ${st.room.maxPlayers} players`);
      s.setText(
        "CustomCreateInfo",
        st.phase === "hosting"
          ? st.peers.length > 1
            ? "Everyone is here. Start when you are ready."
            : "Waiting for players to join. You are the host."
          : "Joined. Waiting for the host to start.",
      );
    } else {
      list?.setItems(
        st.rooms.map((r): ListItem => ({
          value: r.id,
          label: `${r.name}   |cff909090${r.players}/${r.maxPlayers}|r`,
        })),
      );
      list?.setEnabled(true);
      // Highlighting a game shows ITS map in the summary pane — which is the whole point of
      // the pane on this screen: you look at the map before you decide to join.
      if (list) {
        list.onChange = (value) => {
          picked = value;
          const room = lobby.snapshot.rooms.find((r) => r.id === value);
          currentMapPath = room?.mapPath ?? null;
          void showMapOf(room ?? null);
        };
        list.onActivate = () => {
          if (picked) { remember(); lobby.join(picked, playerName()); }
        };
        if (picked) list.select(picked);
      }
      s.setText("GameListTitle", "Network Games");
      s.setText("GameCreatorValue", "");
      s.setText("GameSpeedValue", "");
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
    }

    // The map summary: the room's map in a room, the highlighted game's in the browser.
    if (shown) fillMapInfo(s, shown, null, minimapIcons);
    else clearMapInfo(s);

    if (st.error) s.setText("CustomCreateInfo", `|cffff8080${st.error}|r`);

    // Create Game only from the browser; the bottom button is Join there and Start Game in a
    // room — and a room's Start belongs to the host alone.
    s.setEnabled("CreateButton", st.phase === "browsing");
    s.setText("JoinButtonText", inRoom ? "Start Game" : "Join Game");
    s.setEnabled(
      "JoinButton",
      inRoom
        ? st.phase === "hosting" && !!shown
        : st.phase === "browsing" && !!picked && !missing,
    );
  }
}

/**
 * The config every machine in the room will run.
 *
 * The map decides the slots; the room decides who sits in them. Peers take the map's human
 * seats in join order (the host first, because it is peer 1), and on a MELEE map whatever is
 * left over is filled with computers — the same rule the Custom Game screen uses, so a 4-player
 * map hosted by two people is a 2v2 against two AIs rather than a half-empty map.
 */
/** Build the host's start message. `seed` is injectable so the dev-LAN boot can pin a
 *  reproducible match; production omits it and one is rolled. Exported for that boot only. */
export function buildStart(mapPath: string, mapName: string, info: MapInfo, st: LobbyState, seed?: number): StartMatch {
  const peers = [...st.peers].sort((a, b) => (a.host ? -1 : b.host ? 1 : a.id - b.id));
  const human = info.slots.filter((s) => s.controller !== "computer");
  const slots: StartMatch["slots"] = [];

  info.slots.forEach((s) => {
    const seat = human.indexOf(s); // -1 for a slot the MAP declared a computer
    const peer = seat >= 0 ? peers[seat] : undefined;
    // A human seat with nobody in it becomes an AI on a melee map, and is simply left out
    // otherwise (a scenario's spare seats are for people — see fdfSkirmish's `spare`).
    if (s.controller !== "computer" && !peer && !info.isMelee) return;
    slots.push({
      id: s.id,
      controller: peer ? "user" : "computer",
      race: s.defaultRace,
      team: s.team,
      startX: s.startX,
      startY: s.startY,
      ...(peer ? { peer: peer.id } : {}),
    });
  });

  return {
    k: "start",
    mapPath,
    mapName,
    // One seed for the match, rolled once by the host — or pinned by the dev-LAN boot for a
    // reproducible two-client run. See MeleeConfig.seed.
    seed: seed ?? 1 + Math.floor(Math.random() * 2147483645),
    slots,
  };
}

/** A start message as THIS machine's `MeleeConfig` — the same match, seen from our seat.
 *  Exported for the dev-LAN boot, which overrides only `fog`. */
export function toConfig(msg: StartMatch, me: number | undefined): MeleeConfig {
  const slots: SlotConfig[] = msg.slots.map((s) => ({
    id: s.id,
    controller: s.controller,
    race: s.race as Race,
    team: s.team,
    startX: s.startX,
    startY: s.startY,
    ...(s.peer === undefined ? {} : { peer: s.peer }),
  }));
  return {
    slots,
    fog: "explored",
    seed: msg.seed,
    // Our seat. Every human slot says "user", so this is the only thing that tells two
    // clients apart — see MeleeConfig.localPlayer.
    localPlayer: slots.find((s) => s.peer === me)?.id,
  };
}

/** Compose the screen the way the engine does: MapListBox.fdf into the empty game-list
 *  container, MapInfoPane.fdf into the summary panel beside it. */
function buildLanRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("LocalMultiplayerJoin");
  if (!root) throw new Error("LocalMultiplayerJoin.fdf: no LocalMultiplayerJoin frame");

  // NOTE: this screen chains its anchors down a ladder of unsized TEXT frames
  // (title → label → editbox → list, each SetPoint TOPLEFT … BOTTOMLEFT). Those get their
  // one-line height from the layout solver itself (ui/fdf/layout.ts `textLineHeight`) — it
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
