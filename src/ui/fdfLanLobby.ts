import type { DataSource } from "../vfs/types";
import { RACES, RACE_LABEL } from "../data/races";
import type { MapInfo } from "../world/mapInfo";
import type { MapPreview } from "../world/mapPreview";
import { sanitizeChat } from "../game/chat";
import { matchLinkFrom, type MatchLinkSetup } from "../game/matchLink";
import type { LanLobby } from "../net/lobby";
import type { PeerInfo, StartMatch } from "../net/protocol";
import {
  allSeated, applyRequest, buildStart, newSetup, rosterDiff, seatPeers,
  type LobbyChat, type LobbyRequest, type LobbySetup, type LobbySlot,
} from "../net/lobbySetup";
import { PLAYER_COLORS } from "./hud";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { Controller, MeleeConfig } from "./lobby";
import {
  INFO_ROWS, adopt, fillMapInfo, findFrame, layoutInfoPane, loadMinimapIcons, nudgeX, num,
  paneRowsToHide, readMapPreviewFor, setProp, size, type MinimapIcons,
} from "./mapBrowser";
import {
  CONTROLLERS, HANDICAPS, PLAYER_SLOT_FDF, buildSlotRows, dropdownButtonNames, fillForceLabels,
  forceGroups, labelOf, teamOptions, type Group,
} from "./playerSlots";
import { toConfig } from "./fdfLan";

// The LAN GAME LOBBY (issue #77), built from the game's own UI\FrameDef\Glue\GameChatroom.fdf.
//
// This is the screen the real client puts you on the moment a local game is created — not the
// game list. The host lands here alone, everyone who joins the game afterwards lands here too
// and is auto-seated in the first OPEN slot, and only from here does Start Game exist.
//
// GameChatroom.fdf declares its four areas and fills none of them itself, exactly as
// Skirmish.fdf does — so this screen is composed out of the same files the engine uses:
//
//     Frame "FRAME"        "TeamSetupContainer"    ← one PlayerSlot.fdf row per map slot
//     Frame "TEXTAREA"     "ChatTextArea"          ← the lobby's chat log (TextAreaMaxLines 128)
//     Frame "SLASHCHATBOX" "ChatEditBox"           ← …and the line you type into
//     Frame "FRAME"        "MapInfoPaneContainer"  ← MapInfoPane.fdf, the map you are about to play
//     Frame "TEXT"         "GameNameLabel"/"Value" ← COLON_GAME_NAME + the room's own name
//     Frame "GLUETEXTBUTTON" "StartGameButton"     ← KEY_START_GAME, shortcut "S"
//
// The player rows are ui/playerSlots.ts — the SAME composition the Custom Game screen uses,
// because it is the same template dropped into the same container by the same engine.
//
// THE HOST OWNS THE SEATING (src/net/lobbySetup.ts). This screen renders whatever the host
// last broadcast and, on the host, is where those decisions are made. A client changing its
// race sends a request and waits for the broadcast to come back; it never edits its own copy,
// or two players changing rows in the same beat would be looking at two different lobbies.
//
// Not modelled: AdvancedOptionsContainer (a panel of its own we don't have, as on the Custom
// Game screen), and kicking a player out of a slot.

const MAP_INFO_FDF = "UI\\FrameDef\\Glue\\MapInfoPane.fdf";
/** The game's own network copy — "|CFFAAAAAA%s has joined the game." and its twin. Not
 *  included by GameChatroom.fdf, so it is loaded alongside it for the strings alone. */
const NETWORK_STRINGS_FDF = "UI\\FrameDef\\NetworkStrings.fdf";

/** The stat rows this screen's SHORT pane carries. GameChatroom sizes MapInfoPaneContainer
 *  0.234375 × 0.225, which has no room for a map's description — so it shows the three stat
 *  rows and stops, as the LAN game list's summary panel does. */
const SUMMARY_ROWS = INFO_ROWS.slice(0, 3);

export interface LanLobbyHandlers {
  /** Cancel: leave the room and go back to the game list. Also fired when the room dies
   *  under us (the host left, or the relay dropped it). */
  onCancel: () => void;
  /** The match is on — on the host the moment it presses Start Game, on a client the moment
   *  the host's `start` lands. Both are handed the same map and config, plus the match's own
   *  end of the wire (assembled here, because the lobby does not outlive this screen). */
  onStart: (mapPath: string, info: MapInfo, config: MeleeConfig, link: MatchLinkSetup) => void;
}

/**
 * Mount the game lobby over an ALREADY-JOINED room.
 *
 * `lobby` is the live relay connection, owned by main.ts across the whole LAN screen stack:
 * the host announced its room from the create screen and a client joined from the game list,
 * so by the time this screen exists we are in a room either way.
 */
export async function mountLanLobbyScreen(
  container: HTMLElement,
  vfs: DataSource,
  maps: Map<string, File>,
  lobby: LanLobby,
  map: { path: string; info: MapInfo },
  h: LanLobbyHandlers,
): Promise<FdfScreen> {
  const minimapIcons: MinimapIcons = loadMinimapIcons(vfs);
  let preview: MapPreview | null = null;
  let screen: FdfScreen | null = null;
  let strings: FdfLibrary | null = null;

  // NOT captured at mount: this screen is opened the instant the host asks the relay to
  // announce its room, which is BEFORE the relay has answered — so `lobby.isHost` is still
  // false here and would stay false for a host that had snapshotted it. Ask the lobby every
  // time instead; it is a getter over the state the relay writes.
  const isHost = (): boolean => lobby.isHost;

  // The seating. On the host this IS the truth; on a client it is the last thing the host
  // said. Null until the room exists (host) or the first broadcast lands (client) — the rows
  // come up as the map's empty seats for that instant rather than as a lobby of our invention.
  let setup: LobbySetup | null = null;
  let groups: Group[] = [];
  const chat: string[] = [];
  /** Cleared the moment the screen stops owning the lobby — on the way out, and at Start. */
  let alive = true;
  /** True once the relay has confirmed we are in a room. Until then a "browsing" state is
   *  simply the answer not having arrived; AFTER it, the same state means the room died. */
  let wasInRoom = false;

  /** The row groups the screen is built for. The FDF screen rebuilds its DOM on every resize
   *  and the row COUNT is part of the frame tree, so a change in it is a relayout. */
  const regroup = (): void => {
    groups = forceGroups(map.info, (setup?.slots ?? map.info.slots).map((s) => s.id));
  };
  regroup();

  // --- the chat area ------------------------------------------------------------------

  const append = (line: string): void => {
    chat.push(line);
    const area = screen?.textArea("ChatTextArea");
    area?.addLine(line);
    area?.scrollToBottom();
  };

  /** One of the game's own network lines, e.g. NETMESSAGE_PLAYERJOINED. */
  const system = (key: string, who: string): void => {
    append((strings?.string(key) ?? "%s").replace("%s", who));
  };

  /** Someone said something. `from` is the relay peer; the name and the colour are its ROW's,
   *  so a line reads in that player's own colour exactly as in-game chat does (game/chat.ts) —
   *  and the body is stripped of markup there too, so nobody can paint the log from the box. */
  const say = (from: number, text: string): void => {
    const clean = sanitizeChat(text);
    if (!clean) return;
    const slot = setup?.slots.find((s) => s.peer === from);
    const name = slot?.name ?? lobby.snapshot.peers.find((p) => p.id === from)?.name ?? "Player";
    const colour = slot ? PLAYER_COLORS[slot.id % PLAYER_COLORS.length].replace("#", "") : null;
    append(`${colour ? `|cff${colour}${name}|r` : name}: ${clean}`);
  };

  /** Send what is in the entry line, and echo it: the relay never echoes a sender its own
   *  message, so the only copy WE will ever see is the one we make here. */
  const submit = (): void => {
    const box = screen?.editBox("ChatEditBox");
    const text = sanitizeChat(box?.value ?? "");
    if (box) box.value = "";
    const me = lobby.snapshot.you?.id;
    if (!text || me === undefined) return;
    lobby.send({ k: "lobbychat", text } satisfies LobbyChat);
    say(me, text);
  };

  // --- the host's side of the lobby -----------------------------------------------------
  //
  // Everything here fires on the HOST only. A client's copy of `setup` is written by the
  // host's broadcast and by nothing else.

  const broadcast = (): void => {
    if (isHost() && setup) lobby.send(setup);
  };

  /** Re-seat against the room's roster and say who came and went. */
  const reseat = (peers: readonly PeerInfo[]): void => {
    if (!isHost()) return;
    // The host's lobby is born the moment the relay confirms the room — see `isHost`.
    setup ??= newSetup(map.path, map.info.name, lobby.snapshot.room?.name ?? map.info.name, map.info);
    const before = setup.slots.length;
    const { setup: next, joined, left } = seatPeers(setup, peers);
    setup = next;
    // The host seats itself on the way in; that is not news worth printing.
    for (const p of joined) if (!p.host) system("NETMESSAGE_PLAYERJOINED", p.name);
    for (const name of left) system("NETMESSAGE_PLAYERLEFT", name);
    if (setup.slots.length !== before) regroup();
    broadcast();
  };

  /** A client asked for something. Its identity is the relay's `from` stamp — never anything
   *  in the payload — which is what stops one peer re-racing another's row. */
  const onRequest = (from: number, req: LobbyRequest): void => {
    if (!isHost() || !setup) return;
    const next = applyRequest(setup, from, req);
    if (!next) return;
    setup = next;
    broadcast();
    if (screen) render(screen);
  };

  // --- starting the match ----------------------------------------------------------------

  /**
   * Act on a start message — the host on its own, a client on the host's.
   *
   * The wire changes hands HERE, before `onStart` returns: `startGame` disposes the glue on
   * its way in, and this screen's teardown would otherwise close the match's own transport a
   * beat before the link was attached to it (docs/multiplayer.md Phase F item 4).
   */
  const enter = (msg: StartMatch): void => {
    const me = lobby.snapshot.you?.id;
    const hostPeer = lobby.snapshot.peers.find((p) => p.host)?.id ?? 1;
    const link = matchLinkFrom(lobby, isHost(), msg.slots, me, hostPeer);
    alive = false;
    lobby.handOff();
    lobby.onChange = () => {};
    lobby.onStart = () => {};
    lobby.onPeerData = () => {};
    h.onStart(msg.mapPath, map.info, toConfig(msg, me), link);
  };

  const startMatch = (): void => {
    if (!isHost() || !setup) return;
    const msg = buildStart(setup);
    lobby.startMatch(msg);
    enter(msg);
  };

  // --- lobby traffic -----------------------------------------------------------------------

  lobby.onPeerData = (from, data) => {
    if (!alive) return;
    const msg = data as { k?: string } | null;
    if (!msg) return;
    if (msg.k === "lobby") {
      if (isHost()) return; // the host is the author of these; it never takes one
      const prev = setup;
      setup = msg as LobbySetup;
      // The roster is in the payload, so a client says who came and went off the SAME facts
      // the host does — no second message to keep in step (see rosterDiff).
      const { joined, left } = rosterDiff(prev, setup);
      for (const name of joined) system("NETMESSAGE_PLAYERJOINED", name);
      for (const name of left) system("NETMESSAGE_PLAYERLEFT", name);
      if (setup.slots.length !== (prev?.slots.length ?? -1)) { regroup(); screen?.relayout(); }
      else if (screen) render(screen);
      return;
    }
    if (msg.k === "lobbyreq") return onRequest(from, msg as LobbyRequest);
    if (msg.k === "lobbychat") return say(from, (msg as LobbyChat).text);
  };

  lobby.onChange = (st) => {
    if (!alive) return;
    const inRoom = st.phase === "hosting" || st.phase === "joined";
    // Not in a room. Before the relay's answer that is simply the answer not having landed —
    // the host opens this screen the instant it ASKS for a room, so the game list's own
    // `rooms` broadcast arrives first and must not read as "the game is gone". After we have
    // been in one, the same state means exactly that: the host left, or the relay dropped it.
    if (!inRoom) {
      if (wasInRoom) { alive = false; h.onCancel(); }
      return;
    }
    wasInRoom = true;
    reseat(st.peers);
    if (screen) render(screen);
  };

  lobby.onStart = (msg) => { if (alive) enter(msg); };

  // --- the screen ---------------------------------------------------------------------------

  screen = await mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\GameChatroom.fdf",
    rootFrame: "GameChatroom",
    includeFdf: [MAP_INFO_FDF, PLAYER_SLOT_FDF, NETWORK_STRINGS_FDF],
    buildRoot: (lib) => { strings = lib; return buildLobbyRoot(lib, groups); },
    // The dropdowns PlayerSlot declares as plain BUTTONs (TeamButton / ColorButton).
    dropdownButtons: dropdownButtonNames(),
    // Advanced Options is a screen of its own that we don't have (as on Skirmish), and the
    // pane's description row has no room on this screen (see SUMMARY_ROWS).
    hidden: ["AdvancedOptionsContainer", ...paneRowsToHide(SUMMARY_ROWS)],
    panels: [
      "TeamSetupContainer", "ChatTextArea", "ChatEditBox", "MapDisplayPanel",
      "StartGameBackdrop", "CancelBackdrop",
    ],
    // The rows and the map are what the screen is FOR; they fill in after the chrome has
    // landed, the same way the Custom Game screen's map list does.
    latePanels: ["TeamSetupContainer", "MapDisplayPanel"],
    handlers: {
      StartGameButton: () => startMatch(),
      CancelButton: () => { alive = false; lobby.leave(); h.onCancel(); },
    },
    onBuild: (s) => render(s),
  });

  // Seat whoever is already here — the host itself, plus anyone who joined while the create
  // screen was still up. `lobby.onChange` only fires on the NEXT roster change, and for a
  // client (which got here BECAUSE it joined) that change has already happened.
  wasInRoom = lobby.snapshot.phase === "hosting" || lobby.snapshot.phase === "joined";
  reseat(lobby.snapshot.peers);
  render(screen);

  // The minimap's markers (gold mines, shops, start locations) are read out of the map file;
  // it lands a beat later and repaints the pane.
  void readMapPreviewFor(vfs, maps, map.path).then((p) => {
    if (!alive || !screen) return;
    preview = p;
    render(screen);
  });

  const dispose = screen.dispose.bind(screen);
  screen.dispose = (): void => { alive = false; dispose(); };
  return screen;

  /** Paint the seating onto the screen. Called after every build and every change. */
  function render(s: FdfScreen): void {
    screen = s;
    s.setText("GameNameValue", setup?.gameName ?? lobby.snapshot.room?.name ?? "");
    fillMapInfo(s, map.info, preview, minimapIcons);
    fillForceLabels(s, groups);

    const area = s.textArea("ChatTextArea");
    area?.setLines(chat);
    area?.scrollToBottom();
    const box = s.editBox("ChatEditBox");
    if (box) box.onSubmit = () => submit();

    const slots = setup?.slots ?? [];
    const teams = teamOptions(slots.length);
    const me = lobby.snapshot.you?.id;
    const fixed = map.info.fixedPlayerSettings;

    slots.forEach((slot, i) => {
      const mine = slot.kind === "player" && slot.peer === me;
      // Your own row is yours; on the host, so is every row that is not another PERSON's.
      // That is the reference's division: each player picks their own race, team and handicap,
      // and the host gets the empty seats and whatever AI it put in them.
      const ours = mine || (isHost() && slot.kind !== "player");
      const seated = slot.kind === "player" || slot.kind === "computer";

      const name = s.popup(`NameMenu${i}`);
      if (name) {
        // A seated player's row is their NAME, not a menu. An empty row is the host's choice
        // of Open / Closed / Computer. A slot the MAP owns is greyed at Computer, exactly as
        // the real client greys WarChasers' "Dungeon Denizens".
        name.setOptions(
          slot.kind === "player" ? [{ value: "player", label: slot.name ?? "Player" }]
          : slot.locked ? [{ value: "computer", label: labelOf("computer") }]
          : CONTROLLERS.map(([v, l]) => ({ value: v, label: l })),
        );
        name.value = slot.kind;
        name.onChange = (v) => hostSetKind(i, v as Exclude<Controller, "user">);
        name.setEnabled(isHost() && slot.kind !== "player" && !slot.locked);
      }

      const race = s.popup(`RaceMenu${i}`);
      if (race) {
        race.setOptions(RACES.map((r) => ({ value: r, label: RACE_LABEL[r] })));
        race.value = slot.race;
        race.onChange = (v) => change(i, { k: "lobbyreq", race: v });
        race.setEnabled(seated && ours);
      }

      const team = s.popup(`TeamButton${i}`);
      if (team) {
        team.setOptions(teams);
        team.value = String(slot.team);
        team.onChange = (v) => change(i, { k: "lobbyreq", team: parseInt(v, 10) });
        // A fixed-settings map hands out everyone's team but your own (see MapInfo).
        team.setEnabled(seated && ours && (!fixed || mine));
      }

      const colour = s.popup(`ColorButton${i}`);
      if (colour) {
        // The colour IS the player slot in WC3 — player 6 is green because it is player 6 —
        // so the swatch is the slot's own and the menu is read-only.
        colour.setOptions(PLAYER_COLORS.map((c, ci) => ({ value: c, label: `Player ${ci + 1}` })));
        colour.value = PLAYER_COLORS[slot.id % PLAYER_COLORS.length];
        colour.setEnabled(false);
      }

      const handicap = s.popup(`HandicapMenu${i}`);
      if (handicap) {
        handicap.setOptions(HANDICAPS.map((p) => ({ value: String(p), label: `${p}%` })));
        handicap.value = String(slot.handicap);
        handicap.onChange = (v) => change(i, { k: "lobbyreq", handicap: parseInt(v, 10) });
        handicap.setEnabled(seated && ours && (!fixed || mine));
      }
    });

    // Start Game is the host's, and only once everybody in the room has a seat and there are
    // two players to play: a lobby of one is not a match.
    const playing = slots.filter((x) => x.kind === "player" || x.kind === "computer").length;
    s.setEnabled(
      "StartGameButton",
      isHost() && !!setup && playing >= 2 && allSeated(setup, lobby.snapshot.peers),
    );
  }

  /** A change to a row. On the host it applies straight away (its own row, and the AI rows it
   *  owns); on a client it is a REQUEST, and the row moves when the broadcast comes back. */
  function change(index: number, patch: LobbyRequest): void {
    const slot = setup?.slots[index];
    if (!setup || !slot) return;
    const me = lobby.snapshot.you?.id;
    const ours = slot.peer === me || (isHost() && slot.kind !== "player");
    if (!ours) return;
    if (!isHost()) { lobby.send(patch); return; }
    setup = { ...setup, slots: setup.slots.map((s, i) => (i === index ? { ...s, ...slotPatch(patch) } : s)) };
    broadcast();
    if (screen) render(screen);
  }

  /** Host only: what an empty row's slot menu does — Open / Closed / Computer. */
  function hostSetKind(index: number, kind: Exclude<Controller, "user">): void {
    const slot = setup?.slots[index];
    if (!isHost() || !setup || !slot || slot.kind === "player" || slot.locked) return;
    setup = { ...setup, slots: setup.slots.map((s, i) => (i === index ? { ...s, kind } : s)) };
    broadcast();
    if (screen) render(screen);
  }
}

/** A request's payload as a slot's fields (its message tag dropped). */
function slotPatch(patch: LobbyRequest): Partial<LobbySlot> {
  const out: Partial<LobbySlot> = {};
  if (patch.race !== undefined) out.race = patch.race;
  if (patch.team !== undefined) out.team = patch.team;
  if (patch.handicap !== undefined) out.handicap = patch.handicap;
  return out;
}

// --- composing the screen out of the game's templates --------------------------------------

/** GameChatroom + the player rows and the map-info pane dropped into its containers. */
function buildLobbyRoot(lib: FdfLibrary, groups: Group[]): FdfFrame {
  const root = lib.resolveRoot("GameChatroom");
  if (!root) throw new Error("GameChatroom.fdf: no GameChatroom frame");

  // The player rows — the same composition the Custom Game screen uses (ui/playerSlots.ts).
  adopt(root, "TeamSetupContainer", buildSlotRows(lib, groups, "TeamSetupContainer"));

  const pane = lib.resolveRoot("MapInfoPane");
  if (pane) adopt(root, "MapInfoPaneContainer", [layoutInfoPane(pane, { w: PANE_W, h: PANE_H, rows: SUMMARY_ROWS })]);

  // …and the map panel moves left to sit inside the 3D chrome that frames it, exactly as the
  // Custom Game and LAN screens do (see nudgeX). GameNameLabel/Value and the Advanced Options
  // container are anchored to the pane itself, so they travel with it.
  nudgeX(findFrame(root, "MapInfoPaneContainer"), -MAP_INFO_NUDGE);

  // The game name is a label/value pair sharing one line over the pane — the FDF's own idiom
  // (GameNameValue sits TOPLEFT on GameNameLabel and justifies right). Neither declares a
  // height, so they would inherit the screen's; give them the line they share.
  size(findFrame(root, "GameNameLabel"), PANE_W, 0.019);
  size(findFrame(root, "GameNameValue"), PANE_W, 0.019);

  // Start Game / Cancel grow to fill the slot the 3D chrome leaves them, keeping the file's
  // own base:button ratio — the same correction, and the same numbers, as Skirmish.
  for (const [base, button] of [["StartGameBackdrop", "StartGameButton"], ["CancelBackdrop", "CancelButton"]]) {
    setProp(findFrame(root, base), "Width", [num(BOTTOM_BUTTON_BASE_W)]);
    setProp(findFrame(root, button), "Width", [num(BOTTOM_BUTTON_BASE_W * BUTTON_TO_BASE)]);
  }
  return root;
}

/** GameChatroom.fdf's own MapInfoPaneContainer box. */
const PANE_W = 0.234375;
const PANE_H = 0.225;

/** How far left the map panel's contents move to sit inside the 3D chrome. */
const MAP_INFO_NUDGE = 0.052;

/** Start Game / Cancel: the ornate base's width, and the button's share of it (the FDF's own
 *  0.168 / 0.24 — see fdfSkirmish for why the share must not grow with the base). */
const BOTTOM_BUTTON_BASE_W = 0.3;
const BUTTON_TO_BASE = 0.168 / 0.24;
