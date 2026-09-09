import type { DataSource } from "../vfs/types";
import { RACES, RACE_LABEL } from "../data/races";
import type { MapInfo } from "../world/mapInfo";
import type { MapPreview } from "../world/mapPreview";
import { sanitizeChat } from "../game/chat";
import { matchLinkFrom, type MatchLinkSetup } from "../game/matchLink";
import type { LanLobby } from "../net/lobby";
import type { PeerInfo, StartMatch } from "../net/protocol";
import { isDefaultAdvanced, type AdvancedOptions } from "../net/advancedOptions";
import {
  applyRequest, buildStart, canStart, colorsFreeFor, editSlot, isSeated, newSetup, rosterDiff,
  seatPeers, type LobbyChat, type LobbyCount, type LobbyRequest, type LobbySetup, type SlotKind,
} from "../net/lobbySetup";
import { ADVANCED_OPTIONS_DISPLAY_OVERRIDE, LAN_LOBBY_ADDRESS_OVERRIDE, OW3_STRINGS } from "../overrides";
import { PLAYER_COLORS } from "./hud";
import type { FdfFrame } from "./fdf/parser";
import { numProp, type FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { Option } from "./fdf/widgets";
import type { MeleeConfig } from "./lobby";
import {
  BLURB_SCROLLBAR, BLURB_SCROLLBAR_FDF, INFO_ROWS, adopt, fillMapInfo, findFrame, layoutInfoPane,
  loadMinimapIcons, nudgeX, nudgeY, num, paneRowsToHide, readMapPreviewFor, setProp, size,
  type MinimapIcons,
} from "./mapBrowser";
import {
  HANDICAPS, PLAYER_SLOT_FDF, ROW_INDENT, SLOT_OPTIONS, buildSlotRows, dropdownButtonNames,
  fillForceLabels, forceGroups, labelOf, slotOption, slotOptionValue, slotOptionsFor, teamOptions,
  type Group,
} from "./playerSlots";
import { copyText, observerSeats, toConfig } from "./fdfLan";
import { LABEL_GOLD } from "./glueColors";

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
//     Frame "FRAME"        "AdvancedOptionsContainer" ← AdvancedOptionsDisplay.fdf, the host's options
//     Frame "TEXT"         "GameNameLabel"/"Value" ← COLON_GAME_NAME + the room's own name
//     Frame "GLUETEXTBUTTON" "StartGameButton"     ← KEY_START_GAME, shortcut "S"
//
// The player rows are ui/playerSlots.ts — the SAME composition the Custom Game screen uses,
// because it is the same template dropped into the same container by the same engine. Under
// Full Observers the rows continue below the players' as an "Observers:" force — one row per
// seat on the bench, name only, because a watcher has no race, team, colour or handicap.
//
// THE HOST OWNS THE SEATING (src/net/lobbySetup.ts). This screen renders whatever the host
// last broadcast and, on the host, is where those decisions are made. A client changing its
// race sends a request and waits for the broadcast to come back; it never edits its own copy,
// or two players changing rows in the same beat would be looking at two different lobbies.
//
// Not modelled: kicking a player out of a slot.

const MAP_INFO_FDF = "UI\\FrameDef\\Glue\\MapInfoPane.fdf";
const ADVANCED_DISPLAY_FDF = "UI\\FrameDef\\Glue\\AdvancedOptionsDisplay.fdf";
/** The game's own network copy — "|CFFAAAAAA%s has joined the game." and its twin. Not
 *  included by GameChatroom.fdf, so it is loaded alongside it for the strings alone. */
const NETWORK_STRINGS_FDF = "UI\\FrameDef\\NetworkStrings.fdf";

/** The stat rows this screen's SHORT pane carries. GameChatroom sizes MapInfoPaneContainer
 *  0.234375 × 0.225, which has no room for a map's description — so it shows the three stat
 *  rows and stops, as the LAN game list's summary panel does. */
const SUMMARY_ROWS = INFO_ROWS.slice(0, 3);

/**
 * How long Start Game counts down for, in seconds.
 *
 * Not a value any file in the install carries — it is what the real client counts, "Game
 * starting in 5 ..." down to 1, with the match beginning a second after the last line.
 */
const COUNTDOWN_SECONDS = 5;

/**
 * The last seconds of the countdown, in which Cancel is dead too.
 *
 * Until then a start can be called off and the room goes back to what it was; from the "2" the
 * match is committed, and a Cancel that landed here would be racing the `start` message.
 */
const CANCEL_DEADLINE_SECONDS = 2;

/** The team menu's value for "move onto the Observers bench" / "this row is on it". */
const OBSERVERS_TEAM = "observers";

/** The rows of a bench seat that PlayerSlot.fdf declares and a watcher has no use for. */
const BENCH_HIDDEN = ["RaceMenu", "ColorButton", "HandicapMenu"] as const;

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
 * so by the time this screen exists we are in a room either way. `hostAdvanced` is what the
 * host set on the create screen — the host's own lobby is born with it; a client passes none
 * and renders the host's broadcast.
 */
export async function mountLanLobbyScreen(
  container: HTMLElement,
  vfs: DataSource,
  maps: Map<string, File>,
  lobby: LanLobby,
  map: { path: string; info: MapInfo },
  h: LanLobbyHandlers,
  hostAdvanced?: AdvancedOptions,
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
  /** How long "Copied." stands in for the address after a click. Long enough to be seen, short
   *  enough that the row is back to being the thing it says before anybody needs it again. */
  const COPIED_MS = 1500;
  /**
   * Up here with the rest of the state, and not beside `paintJoinAddress` where it reads —
   * because `mountFdfScreen` calls `onBuild` BEFORE it resolves, and everything declared after
   * that `await` is still in its temporal dead zone when the first paint runs. It was written
   * below and threw on the first build, taking the whole lobby screen with it.
   *
   * It did not throw under `pnpm dev`, which is what made it look like a build problem: without
   * `--host` the dev server binds loopback, so `HostInfo` carries no address, `paintJoinAddress`
   * returns before this line, and the bug is invisible. The desktop app binds every interface
   * and always has an address to show.
   */
  let copiedUntil = 0;
  /** True once the relay has confirmed we are in a room. Until then a "browsing" state is
   *  simply the answer not having arrived; AFTER it, the same state means the room died. */
  let wasInRoom = false;

  /**
   * Frames the build leaves out — the array `mountFdfScreen` reads its `hidden` set from on
   * every build, so it is edited in place (same object) and a change is a relayout. Besides
   * the pane rows this short screen has no room for, it names the widgets a BENCH row does not
   * carry, and the Advanced Options summary while there is nothing in it to tell a joiner.
   */
  const hiddenFrames: string[] = [...paneRowsToHide(SUMMARY_ROWS)];

  /** The lobby's rows: the map's player slots first, then the bench — one index space, which
   *  is also each row's widget suffix. */
  const playerRows = (): number => setup?.slots.length ?? map.info.slots.length;
  const benchRows = (): number => setup?.observers.length ?? 0;

  /** The row groups the screen is built for. The FDF screen rebuilds its DOM on every resize
   *  and the row COUNT is part of the frame tree, so a change in it is a relayout. */
  const regroup = (): void => {
    const t = (key: string, fallback: string): string => strings?.string(key) ?? fallback;
    groups = forceGroups(map.info, (setup?.slots ?? map.info.slots).map((s) => s.id));
    const bench = benchRows();
    if (!bench) return;
    // With a bench the players get a heading too — "Players:" over a melee map's one
    // nameless force (a custom map's own force names stay), then "Observers:" over the bench.
    if (groups.length === 1 && !groups[0].name) groups[0].name = `${t("PLAYERS", "Players")}:`;
    const first = playerRows();
    groups.push({ name: t("COLON_OBSERVERS", "Observers:"), rows: Array.from({ length: bench }, (_, j) => first + j) });
  };
  regroup();

  /** Recompute the hidden set from the seating; true when it changed (a relayout is owed). */
  const syncHidden = (): boolean => {
    const next = [...paneRowsToHide(SUMMARY_ROWS)];
    const first = playerRows();
    (setup?.observers ?? []).forEach((seat, j) => {
      const i = first + j;
      for (const w of BENCH_HIDDEN) next.push(`${w}${i}`);
      if (seat.kind !== "player") next.push(`TeamButton${i}`); // an empty bench seat is its name box alone
    });
    if (!setup || isDefaultAdvanced(setup.advanced)) next.push("AdvancedOptionsContainer");
    if (next.length === hiddenFrames.length && next.every((n, i) => n === hiddenFrames[i])) return false;
    hiddenFrames.length = 0;
    hiddenFrames.push(...next);
    return true;
  };
  syncHidden();

  /** The seating changed: rebuild the screen if its frame tree did, else repaint it. */
  const refresh = (): void => {
    if (!screen) return;
    if (syncHidden()) screen.relayout();
    else render(screen);
  };

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

  /** The room's host, as the relay stamps it — who a countdown line has to have come from. */
  const hostPeer = (): number | undefined => lobby.snapshot.peers.find((p) => p.host)?.id;

  /** Everyone in the room by peer, wherever they sit — a name for a chat line. */
  const nameOf = (peer: number): string =>
    setup?.slots.find((s) => s.peer === peer)?.name
    ?? setup?.observers.find((o) => o.peer === peer)?.name
    ?? lobby.snapshot.peers.find((p) => p.id === peer)?.name
    ?? "Player";

  /** Someone said something. `from` is the relay peer; the name is its ROW's. The name is set
   *  in the screen's own label gold rather than the player's colour: in the lobby a colour is
   *  still being CHOSEN (the menu on the row), and a line painted in a colour that may change
   *  under it — or, for a watcher, in no colour at all — reads worse than one voice for all.
   *  The body is stripped of markup (game/chat.ts), so nobody can paint the log from the box. */
  const say = (from: number, text: string): void => {
    const clean = sanitizeChat(text);
    if (!clean) return;
    append(`|cff${LABEL_GOLD}${nameOf(from)}|r: ${clean}`);
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
    // The host's lobby is born the moment the relay confirms the room — see `isHost` — and
    // born with the options the host set on the create screen.
    setup ??= newSetup(map.path, map.info.name, lobby.snapshot.room?.name ?? map.info.name, map.info, hostAdvanced);
    const before = setup.slots.length + setup.observers.length;
    const { setup: next, joined, left } = seatPeers(setup, peers);
    setup = next;
    // The host seats itself on the way in; that is not news worth printing.
    for (const p of joined) if (!p.host) system("NETMESSAGE_PLAYERJOINED", p.name);
    for (const name of left) system("NETMESSAGE_PLAYERLEFT", name);
    if (setup.slots.length + setup.observers.length !== before) regroup();
    broadcast();
  };

  /** A client asked for something. Its identity is the relay's `from` stamp — never anything
   *  in the payload — which is what stops one peer re-racing another's row. */
  const onRequest = (from: number, req: LobbyRequest): void => {
    if (!isHost() || !setup) return;
    // Calling off the start is not a seating change and the seating model does not answer it —
    // the countdown is a clock, and the clock is ours. The room hears in the broadcast.
    if (req.abort) { if (countdown !== null && cancelLive()) abortCountdown(); return; }
    const next = applyRequest(setup, from, req);
    if (!next) return;
    setup = next;
    broadcast();
    refresh();
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
    // The bench is seated on the link too — a watcher is addressed snapshots like anybody.
    const link = matchLinkFrom(lobby, isHost(), msg.slots, me, hostPeer() ?? 1, observerSeats(msg));
    alive = false;
    stopCountdown();
    lobby.handOff();
    lobby.onChange = () => {};
    lobby.onStart = () => {};
    lobby.onPeerData = () => {};
    h.onStart(msg.mapPath, map.info, toConfig(msg, me), link);
  };

  /** Actually begin the match: the host's own countdown has run out. */
  const launch = (): void => {
    if (!isHost() || !setup) return;
    const msg = buildStart(setup);
    lobby.startMatch(msg);
    enter(msg);
  };

  // --- the countdown ------------------------------------------------------------------------
  //
  // Start Game does not start the game: it starts a FIVE-SECOND COUNTDOWN, printed into the
  // chat log a line at a time — GlobalStrings' own
  //
  //     TIMER_COUNTDOWN  "|Cffff0000Game starting in |R%d|Cffff0000 ..."
  //
  // from 5 down to 1, one a second, with the match beginning a second after the last one. The
  // clock is the HOST's alone (LobbyCount): every line goes out as its own message and a client
  // prints what it is told, so no client can count out of step with the `start` that ends it.
  // No LINE is sent for an abort — they just stop, which is all the real client shows.
  //
  // The SEATING LOCKS for the duration on every machine — the rows the countdown is about to
  // hand to `buildStart` are the rows the room is looking at — and that lock rides the seating
  // broadcast (`LobbySetup.counting`) rather than the countdown's own messages: a client greys
  // its menus off the payload it already renders, and an abandoned countdown gives the rows
  // back with one more broadcast instead of a second kind of message that could go missing.
  //
  // CANCEL stays live and calls the start off (`cancel`) — a start is the room's, and until the
  // last two seconds anybody may say no to it. From the "2" that button is dead too.

  /** The host's countdown handle, or null while there is none. A client never runs one. */
  let countdown: number | null = null;
  /** The number the NEXT tick announces; the match begins on the tick that finds it at zero. */
  let countdownAt = 0;
  /** The number the room was LAST told, on any machine — the host off its own clock, a client
   *  off the message. Null between countdowns. It is what Cancel's deadline is measured in. */
  let showing: number | null = null;

  const stopCountdown = (): void => {
    if (countdown === null) return;
    clearInterval(countdown);
    countdown = null;
  };

  /** Give up on the countdown and hand the room its rows back — the host's side of an abort. */
  const abortCountdown = (): void => {
    stopCountdown();
    showing = null;
    if (setup?.counting) { setup = { ...setup, counting: false }; broadcast(); }
    refresh();
  };

  /**
   * May Cancel be pressed? Always, except in the countdown's last two seconds.
   *
   * A start is the ROOM's and anybody may call it off until then (see `cancel`) — but from the
   * "2" it is committed: the host is about to send `start`, and a Cancel landing in that window
   * would be racing it. `showing` is null for the instant between the lock going out and the
   * first line landing, which is the top of the count and so not the deadline.
   */
  const cancelLive = (): boolean =>
    !setup?.counting || showing === null || showing > CANCEL_DEADLINE_SECONDS;

  /** Print one countdown line, wherever it came from — our own clock or the host's message. */
  const countdownLine = (n: number): void => {
    append((strings?.string("TIMER_COUNTDOWN") ?? "Game starting in %d ...").replace("%d", String(n)));
  };

  /**
   * One second of the host's countdown.
   *
   * It is abandoned the moment the lobby stops being startable — somebody left, or a joiner is
   * still standing — which is the only way it ends early, and puts Start Game back under the
   * host's hand.
   */
  const tick = (): void => {
    if (!isHost() || !setup || !canStart(setup, lobby.snapshot.peers)) {
      abortCountdown();
      return;
    }
    if (countdownAt <= 0) { stopCountdown(); launch(); return; }
    lobby.send({ k: "lobbycount", n: countdownAt } satisfies LobbyCount);
    countdownLine(countdownAt);
    showing = countdownAt;
    countdownAt -= 1;
    syncButtons(); // the last seconds take Cancel with them
  };

  /**
   * Cancel.
   *
   * While a countdown is running it calls the START off and the room stays exactly as it was —
   * on the host directly, from anywhere else by asking (`abort`), which is a smaller act than
   * the LEAVING that would stop the countdown anyway and cost the leaver their seat. With no
   * countdown to stop it is what it has always been: leave the room, back to the game list.
   */
  const cancel = (): void => {
    if (setup?.counting) {
      if (isHost()) abortCountdown();
      else lobby.send({ k: "lobbyreq", abort: true } satisfies LobbyRequest);
      return;
    }
    alive = false;
    stopCountdown();
    lobby.leave();
    h.onCancel();
  };

  const startMatch = (): void => {
    if (!isHost() || !setup || countdown !== null) return;
    countdownAt = COUNTDOWN_SECONDS;
    showing = null;
    // The lock goes out FIRST: from here the room's seating is settled, and the rows a client
    // is looking at stop being ones it can still change under the start.
    setup = { ...setup, counting: true };
    broadcast();
    countdown = window.setInterval(tick, 1000);
    tick();     // the first line belongs to the press, not to a second later
    refresh();  // …and Start Game is spent until the countdown ends or is abandoned
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
      if (!setup.counting) showing = null; // a countdown that ended takes its number with it
      const rows = setup.slots.length + setup.observers.length;
      if (rows !== (prev ? prev.slots.length + prev.observers.length : -1)) { regroup(); syncHidden(); screen?.relayout(); }
      else refresh();
      return;
    }
    if (msg.k === "lobbyreq") return onRequest(from, msg as LobbyRequest);
    if (msg.k === "lobbychat") return say(from, (msg as LobbyChat).text);
    // Only the host counts, and only the host's own line is printed — a peer that sends one is
    // no more the host than one that sends a seating (the relay's `from` stamp settles it).
    if (msg.k === "lobbycount" && from === hostPeer()) {
      showing = (msg as LobbyCount).n;
      countdownLine(showing);
      syncButtons(); // …and with the last two seconds, this machine's Cancel goes too
      return;
    }
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
    refresh();
  };

  lobby.onStart = (msg) => { if (alive) enter(msg); };

  // --- the screen ---------------------------------------------------------------------------

  screen = await mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\GameChatroom.fdf",
    rootFrame: "GameChatroom",
    // …and EscMenuTemplates.fdf for the player rows' scrollbar (BLURB_SCROLLBAR), which the
    // glue's own StandardTemplates.fdf does not carry.
    includeFdf: [MAP_INFO_FDF, PLAYER_SLOT_FDF, NETWORK_STRINGS_FDF, ADVANCED_DISPLAY_FDF, BLURB_SCROLLBAR_FDF],
    // …and our one row on the options summary (Computer+), and the strings our menus need.
    overrides: [OW3_STRINGS, ADVANCED_OPTIONS_DISPLAY_OVERRIDE, LAN_LOBBY_ADDRESS_OVERRIDE],
    buildRoot: (lib) => { strings = lib; regroup(); return buildLobbyRoot(lib, groups); },
    // The dropdowns PlayerSlot declares as plain BUTTONs (TeamButton / ColorButton).
    dropdownButtons: dropdownButtonNames(),
    hidden: hiddenFrames,
    panels: [
      "TeamSetupContainer", "ChatTextArea", "ChatEditBox", "MapDisplayPanel",
      "StartGameBackdrop", "CancelBackdrop",
    ],
    // The rows and the map are what the screen is FOR; they fill in after the chrome has
    // landed, the same way the Custom Game screen's map list does.
    latePanels: ["TeamSetupContainer", "MapDisplayPanel"],
    handlers: {
      StartGameButton: () => startMatch(),
      CancelButton: () => cancel(),
    },
    onBuild: (s) => render(s),
  });

  // Seat whoever is already here — the host itself, plus anyone who joined while the create
  // screen was still up. `lobby.onChange` only fires on the NEXT roster change, and for a
  // client (which got here BECAUSE it joined) that change has already happened.
  wasInRoom = lobby.snapshot.phase === "hosting" || lobby.snapshot.phase === "joined";
  reseat(lobby.snapshot.peers);
  refresh();

  // The minimap's markers (gold mines, shops, start locations) are read out of the map file;
  // it lands a beat later and repaints the pane.
  void readMapPreviewFor(vfs, maps, map.path).then((p) => {
    if (!alive || !screen) return;
    preview = p;
    render(screen);
  });

  const dispose = screen.dispose.bind(screen);
  screen.dispose = (): void => { alive = false; stopCountdown(); dispose(); };
  return screen;

  /** Paint the seating onto the screen. Called after every build and every change. */
  /**
   * The address other machines type to reach this game (`HostInfo`, src/net/protocol.ts).
   *
   * Shown only when there is one — a relay that is not also serving this page cannot know its
   * own reachability, and a machine with no network has nothing to offer. The row copies itself
   * when clicked; `navigator.clipboard` needs a secure context, which `127.0.0.1` is and a plain
   * `http://192.168.x.x` is NOT, so the desktop app takes the modern path and a browser on the
   * LAN falls back to the selection trick that predates it.
   */
  function paintJoinAddress(s: FdfScreen): void {
    const addresses = lobby.snapshot.host?.addresses ?? [];
    const first = addresses[0];
    if (!first) {
      s.setText("JoinAddressLobbyLabel", "");
      s.setText("JoinAddressLobbyValue", "");
      return;
    }
    // No scheme. The address is going into the OTHER machine's Servers List box, and
    // `normalizeRelayUrl` takes `192.168.1.42:8787` — it strips a scheme if one is there, so
    // `http://` was never doing anything except making the line longer in a band that has no
    // room to spare. A browser address bar accepts `host:port` too, for the player who would
    // rather open the game that way.
    const url = first;
    s.setText("JoinAddressLobbyLabel", "Others join at (click to copy):");
    s.setText("JoinAddressLobbyValue", copiedUntil > Date.now() ? `|cff${LABEL_GOLD}Copied.|r` : url);
    const el = s.frame("JoinAddressLobbyValue");
    if (!el) return;
    el.style.cursor = "pointer";
    el.onclick = () => {
      void copyText(url);
      copiedUntil = Date.now() + COPIED_MS;
      render(s);
      setTimeout(() => { if (screen === s) render(s); }, COPIED_MS);
    };
  }

  function render(s: FdfScreen): void {
    screen = s;
    s.setText("GameNameValue", setup?.gameName ?? lobby.snapshot.room?.name ?? "");
    // The start locations on the minimap wear the colours the rows have picked.
    const colorOf = (id: number): string => PLAYER_COLORS[(setup?.slots.find((x) => x.id === id)?.color ?? id) % PLAYER_COLORS.length];
    fillMapInfo(s, map.info, preview, minimapIcons, colorOf);
    fillForceLabels(s, groups);
    if (setup) fillAdvanced(s, setup.advanced);

    paintJoinAddress(s);

    const area = s.textArea("ChatTextArea");
    area?.setLines(chat);
    area?.scrollToBottom();
    const box = s.editBox("ChatEditBox");
    if (box) box.onSubmit = () => submit();

    const t = (key: string, fallback: string): string => strings?.string(key) ?? fallback;
    const slots = setup?.slots ?? [];
    const bench = setup?.observers ?? [];
    const me = lobby.snapshot.you?.id;
    const fixed = map.info.fixedPlayerSettings;
    const computerPlus = setup?.advanced.computerPlus ?? false;
    // Every row is dead while the countdown runs, host and client alike — the seating is
    // settled the moment Start Game is pressed. It is read off the SEATING rather than off our
    // own `countdown`, which only the host has (see LobbySetup.counting).
    const locked = setup?.counting ?? false;
    /** The team menu: the map's teams and, with a bench, the way onto it. */
    const teams: Option[] = [
      ...teamOptions(slots.length),
      ...(bench.length ? [{ value: OBSERVERS_TEAM, label: t("OBSERVERS_TEAM", "Observers") }] : []),
    ];

    slots.forEach((slot, i) => {
      const mine = slot.kind === "player" && slot.peer === me;
      // Your own row is yours; on the host, so is every row that is not another PERSON's.
      // That is the reference's division: each player picks their own race, team, colour and
      // handicap, and the host gets the empty seats and whatever AI it put in them.
      const ours = mine || (isHost() && slot.kind !== "player");
      const seated = isSeated(slot);

      const name = s.popup(`NameMenu${i}`);
      if (name) {
        // A seated player's row is their NAME, not a menu. An empty row is the host's choice
        // of Open / Closed / Computer. A slot the MAP owns is greyed at Computer, exactly as
        // the real client greys WarChasers' "Dungeon Denizens". Which AI's three difficulties
        // an empty row offers is the host's Computer+ switch (issue #124), as on the Custom
        // Game screen — the switch was set on the create screen and rides in `advanced`.
        name.setOptions(
          slot.kind === "player" ? [{ value: "player", label: slot.name ?? "Player" }]
          : slot.locked ? [{ value: "computer", label: labelOf("computer") }]
          : slotOptionsFor(computerPlus).map((o) => ({ value: o.value, label: o.label })),
        );
        name.value = slot.kind === "computer" ? slotOptionValue("computer", slot.ai, computerPlus) : slot.kind;
        name.onChange = (v) => hostSetKind(i, v);
        name.setEnabled(!locked && isHost() && slot.kind !== "player" && !slot.locked);
      }

      const race = s.popup(`RaceMenu${i}`);
      if (race) {
        race.setOptions(RACES.map((r) => ({ value: r, label: RACE_LABEL[r] })));
        race.value = slot.race;
        race.onChange = (v) => change(i, { race: v });
        race.setEnabled(!locked && seated && ours);
      }

      const team = s.popup(`TeamButton${i}`);
      if (team) {
        team.setOptions(teams);
        team.value = String(slot.team);
        // "Observers" on a player's row is not a team but a move: off the slot, onto the bench.
        team.onChange = (v) => change(i, v === OBSERVERS_TEAM ? { observe: true } : { team: parseInt(v, 10) });
        // A fixed-settings map hands out everyone's team but your own (see MapInfo).
        team.setEnabled(!locked && seated && ours && (!fixed || mine));
      }

      const colour = s.popup(`ColorButton${i}`);
      if (colour) {
        // The colours on offer are the palette less what every other seated row wears — a
        // colour is one player's, and the lobby keeps them unique (lobbySetup.ts). The value
        // is the row's own; a menu whose current value is not among its options would drop it,
        // which is why the row's own colour is always in the list.
        const free = setup ? colorsFreeFor(setup, i) : [slot.color];
        colour.setOptions(free.map((c) => ({ value: PLAYER_COLORS[c], label: `Player ${c + 1}` })));
        colour.value = PLAYER_COLORS[slot.color % PLAYER_COLORS.length];
        colour.onChange = (v) => {
          // Validated at the pick against the NEWEST setup, not only when the menu was built:
          // a colour another seated row wears by now is refused here — on a client too, which
          // otherwise sends a request the host refuses and is never told — and the button keeps
          // the colour it had. The host's `change` refuses the same way through setSlotColor.
          const color = PLAYER_COLORS.indexOf(v);
          if (setup && !colorsFreeFor(setup, i).includes(color)) return false;
          return change(i, { color });
        };
        colour.setEnabled(!locked && seated && ours);
      }

      const handicap = s.popup(`HandicapMenu${i}`);
      if (handicap) {
        handicap.setOptions(HANDICAPS.map((p) => ({ value: String(p), label: `${p}%` })));
        handicap.value = String(slot.handicap);
        handicap.onChange = (v) => change(i, { handicap: parseInt(v, 10) });
        handicap.setEnabled(!locked && seated && ours && (!fixed || mine));
      }
    });

    // The bench: a name box, and — for somebody sitting on it — the team menu that is the way
    // back to a player slot. The other widgets are not built for these rows (`syncHidden`).
    bench.forEach((seat, j) => {
      const i = slots.length + j;
      const mine = seat.kind === "player" && seat.peer === me;
      const name = s.popup(`NameMenu${i}`);
      if (name) {
        name.setOptions(
          seat.kind === "player"
            ? [{ value: "player", label: seat.name ?? "Player" }]
            : SLOT_OPTIONS.filter((o) => o.controller === "open" || o.controller === "closed").map((o) => ({ value: o.value, label: o.label })),
        );
        name.value = seat.kind;
        name.onChange = (v) => hostSetBenchKind(j, v);
        name.setEnabled(!locked && isHost() && seat.kind !== "player");
      }
      const team = s.popup(`TeamButton${i}`);
      if (team) {
        team.setOptions(teams);
        team.value = OBSERVERS_TEAM;
        team.onChange = (v) => { if (v !== OBSERVERS_TEAM) benchChange(j, parseInt(v, 10)); };
        team.setEnabled(!locked && mine);
      }
    });

    syncButtons();
  }

  /**
   * The two buttons' greying — its own pass because the COUNTDOWN moves them between renders.
   *
   * Start Game is the host's, and only once everybody in the room has a seat and there are two
   * PLAYERS to play (NEED_AT_LEAST_TWO): a lobby of one, or of one and a bench, is not a match.
   * It is spent for as long as a countdown of ours is running.
   */
  function syncButtons(): void {
    const s = screen;
    if (!s) return;
    s.setEnabled("StartGameButton", isHost() && !!setup && countdown === null && canStart(setup, lobby.snapshot.peers));
    s.setEnabled("CancelButton", cancelLive());
  }

  /**
   * The Advanced Options summary under the map — `AdvancedOptionsDisplay.fdf`'s seven rows
   * plus ours, each a Yes/No or the menu item's own label. Only built while the options differ
   * from the defaults (`syncHidden`), which is when there is something to tell a joiner.
   */
  function fillAdvanced(s: FdfScreen, a: AdvancedOptions): void {
    const t = (key: string): string => strings?.string(key) ?? key;
    const yesNo = (on: boolean): string => t(on ? "YES" : "NO");
    s.setText("AdvancedOptionsTitleValue", "");
    s.setText("LockTeamsValue", yesNo(a.lockTeams));
    s.setText("TeamsTogetherValue", yesNo(a.teamsTogether));
    s.setText("AdvSharedControlValue", yesNo(a.sharedControl));
    s.setText("RandomRacesValue", yesNo(a.randomRaces));
    s.setText("RandomHeroValue", yesNo(a.randomHero));
    s.setText("ObserversValue", t(a.observers));
    s.setText("MapVisibilityValue", t(a.visibility));
    s.setText("ComputerPlusDisplayValue", yesNo(a.computerPlus));
  }

  /** A change to a player row. On the host it applies straight away (its own row, and the AI
   *  rows it owns); on a client it is a REQUEST, and the row moves when the broadcast comes
   *  back. Both go through lobbySetup's rules, so a colour is unique on every machine. */
  function change(index: number, patch: Omit<LobbyRequest, "k">): boolean {
    const slot = setup?.slots[index];
    if (!setup || !slot) return false;
    const me = lobby.snapshot.you?.id;
    const mine = slot.kind === "player" && slot.peer === me;
    if (!mine && !(isHost() && slot.kind !== "player")) return false;
    if (!isHost()) { lobby.send({ k: "lobbyreq", ...patch } satisfies LobbyRequest); return true; }
    const next = mine && me !== undefined
      ? applyRequest(setup, me, { k: "lobbyreq", ...patch })
      : editSlot(setup, index, patch);
    // Nothing changed — a colour refused by the seating rule, say — and the menu that asked is
    // told so, so it falls back to what it showed (PopupControl.onChange).
    if (!next) return false;
    setup = next;
    broadcast();
    refresh();
    return true;
  }

  /** A watcher picked a team: the way back off the bench into an open player slot. */
  function benchChange(j: number, team: number): void {
    const seat = setup?.observers[j];
    const me = lobby.snapshot.you?.id;
    if (!setup || !seat || seat.kind !== "player" || seat.peer !== me || me === undefined) return;
    if (!isHost()) { lobby.send({ k: "lobbyreq", team } satisfies LobbyRequest); return; }
    const next = applyRequest(setup, me, { k: "lobbyreq", team });
    if (!next) return;
    setup = next;
    broadcast();
    refresh();
  }

  /** Host only: what an empty row's slot menu does — Open / Closed / one of the three
   *  computers (ui/playerSlots.ts, which owns the menu the two screens share). */
  function hostSetKind(index: number, value: string): void {
    const slot = setup?.slots[index];
    if (!isHost() || !setup || !slot || slot.kind === "player" || slot.locked) return;
    const opt = slotOption(value);
    const kind = (opt?.controller ?? value) as Exclude<SlotKind, "player">;
    setup = { ...setup, slots: setup.slots.map((s, i) => (i === index ? { ...s, kind, ai: opt?.ai } : s)) };
    broadcast();
    refresh();
  }

  /** Host only: open or close a seat on the bench. */
  function hostSetBenchKind(j: number, value: string): void {
    const seat = setup?.observers[j];
    if (!isHost() || !setup || !seat || seat.kind === "player") return;
    if (value !== "open" && value !== "closed") return;
    setup = { ...setup, observers: setup.observers.map((o, k) => (k === j ? { kind: value } : o)) };
    broadcast();
    refresh();
  }
}

// --- composing the screen out of the game's templates --------------------------------------

/** GameChatroom + the player rows, the map-info pane and the options summary dropped into
 *  its containers. */
function buildLobbyRoot(lib: FdfLibrary, groups: Group[]): FdfFrame {
  const root = lib.resolveRoot("GameChatroom");
  if (!root) throw new Error("GameChatroom.fdf: no GameChatroom frame");

  // The player rows — the same composition the Custom Game screen uses (ui/playerSlots.ts) —
  // and, down the container's right, the bar that scrolls them. GameChatroom.fdf gives the
  // container 0.39, fifteen rows at the row pitch, and a map can ask for more: twelve seats
  // under a heading per force, plus an Observers bench under a heading of its own. Handing the
  // container a SCROLLBAR is what makes it a viewport (ui/fdf/widgets.ts buildScrollFrame),
  // and the bar is the Map Description's — EscMenuScrollBarTemplate, the in-game bare track
  // and round knob (see mapBrowser.ts makeBlurbScrollable for why that one and not the glue's
  // stepped bar). It is drawn only while the rows overrun the box; a lobby that fits looks
  // exactly as it did.
  const rows = buildSlotRows(lib, groups, "TeamSetupContainer");
  const bar = lib.resolveRoot(BLURB_SCROLLBAR);
  if (bar) {
    bar.name = "TeamSetupScrollBar";
    rows.push(bar);
    // The bar stands down the container's RIGHT edge, and the file's 0.46375 is the rows'
    // own width — a PlayerSlot's Handicap box ends a hair inside it, and a row under a force
    // heading is indented ROW_INDENT further. So the box grows by the bar and that indent,
    // or the widest row's Handicap runs under the bar's strip and the viewport clips it.
    // The rows anchor TOPLEFT and do not move; the chrome's panel has the room.
    const barW = numProp(bar, "Width") ?? 0.012;
    setProp(findFrame(root, "TeamSetupContainer"), "Width", [num(TEAM_SETUP_W + barW + ROW_INDENT)]);
  }
  adopt(root, "TeamSetupContainer", rows);

  const pane = lib.resolveRoot("MapInfoPane");
  if (pane) adopt(root, "MapInfoPaneContainer", [layoutInfoPane(pane, { w: PANE_W, h: PANE_H, rows: SUMMARY_ROWS })]);

  // The host's options, under the map: AdvancedOptionsDisplay.fdf is a bare FRAME whose rows
  // chain down from its top, so it takes the container's own box.
  const display = lib.resolveRoot("AdvancedOptionsDisplay");
  if (display) {
    setProp(display, "SetAllPoints", []);
    // Every row of the display is a TEXT anchored TOPLEFT and TOPRIGHT to the row above and
    // given no Height — the engine sizes it to its string, and two anchors on one edge tell
    // our solver the box is zero tall, so nothing drew. Each gets its line here: the title at
    // its 0.015 face, the rows a little under their 0.013 one, tight enough that eight rows
    // and the title fit the 0.125 the container has (the reference packs them just so).
    size(findFrame(display, "AdvancedOptionsTitleLabel"), PANE_W, DISPLAY_TITLE_H);
    for (const row of DISPLAY_ROWS) size(findFrame(display, row), PANE_W, DISPLAY_ROW_H);
    // …and the container grows for the eighth row: the file sized it for its own seven.
    setProp(findFrame(root, "AdvancedOptionsContainer"), "Height", [num(DISPLAY_H)]);
    adopt(root, "AdvancedOptionsContainer", [display]);
  }

  // …and the map panel moves left to sit inside the 3D chrome that frames it, exactly as the
  // Custom Game and LAN screens do (see nudgeX). GameNameLabel/Value and the Advanced Options
  // container are anchored to the pane itself, so they travel with it.
  nudgeX(findFrame(root, "MapInfoPaneContainer"), -MAP_INFO_NUDGE);

  // The game name is a label/value pair sharing one line over the pane — the FDF's own idiom
  // (GameNameValue sits TOPLEFT on GameNameLabel and justifies right). Neither declares a
  // height, so they would inherit the screen's; give them the line they share.
  size(findFrame(root, "GameNameLabel"), PANE_W, 0.019);
  size(findFrame(root, "GameNameValue"), PANE_W, 0.019);

  // The chat log sits INSIDE the lower-left panel of the 16:9 chrome, whose top rail runs
  // lower than the 4:3 file's anchor (0.453125 down) expects: as authored, the first line of
  // chat was drawn across the rail. The area drops by the rail's height and gives that much
  // back off its bottom, so the entry line (anchored to its BOTTOMLEFT) stays on the panel's
  // floor where the file put it.
  nudgeY(findFrame(root, "ChatTextArea"), -CHAT_RAIL);
  setProp(findFrame(root, "ChatTextArea"), "Height", [num(CHAT_H - CHAT_RAIL)]);
  // …and in from the panel's left rail by the same margin, narrowing to keep its right edge.
  nudgeX(findFrame(root, "ChatTextArea"), CHAT_INSET);
  setProp(findFrame(root, "ChatTextArea"), "Width", [num(CHAT_W - CHAT_INSET)]);

  // Start Game / Cancel grow to fill the slot the 3D chrome leaves them, keeping the file's
  // own base:button ratio — the same correction, and the same numbers, as Skirmish.
  for (const [base, button] of [["StartGameBackdrop", "StartGameButton"], ["CancelBackdrop", "CancelButton"]]) {
    setProp(findFrame(root, base), "Width", [num(BOTTOM_BUTTON_BASE_W)]);
    setProp(findFrame(root, button), "Width", [num(BOTTOM_BUTTON_BASE_W * BUTTON_TO_BASE)]);
  }
  return root;
}

/** GameChatroom.fdf's own TeamSetupContainer width — the rows' own; see `buildLobbyRoot`. */
const TEAM_SETUP_W = 0.46375;

/** GameChatroom.fdf's own MapInfoPaneContainer box. */
const PANE_W = 0.234375;
const PANE_H = 0.225;

/** AdvancedOptionsDisplay.fdf's own label rows, and the line they are given. Our eighth
 *  (ComputerPlusDisplayLabel) is not here: it is laid over the tree AFTER `buildRoot` and
 *  states its own Height in its file (src/overrides/ui/AdvancedOptionsDisplay.fdf). */
const DISPLAY_ROWS = [
  "LockTeamsLabel", "TeamsTogetherLabel", "AdvSharedControlLabel", "RandomRacesLabel",
  "RandomHeroLabel", "ObserversLabel", "MapVisibilityLabel",
];
const DISPLAY_TITLE_H = 0.016;
const DISPLAY_ROW_H = 0.012;
/** GameChatroom.fdf gives AdvancedOptionsContainer 0.125 for seven rows; ours has eight. */
const DISPLAY_H = 0.138;

/** GameChatroom.fdf's own ChatTextArea box, how far the chrome's top rail runs into it, and
 *  the margin it keeps off the left one. */
const CHAT_W = 0.461875;
const CHAT_H = 0.094375;
const CHAT_RAIL = 0.016;
const CHAT_INSET = 0.006;

/** How far left the map panel's contents move to sit inside the 3D chrome. */
const MAP_INFO_NUDGE = 0.052;

/** Start Game / Cancel: the ornate base's width, and the button's share of it (the FDF's own
 *  0.168 / 0.24 — see fdfSkirmish for why the share must not grow with the base). */
const BOTTOM_BUTTON_BASE_W = 0.3;
const BUTTON_TO_BASE = 0.168 / 0.24;
