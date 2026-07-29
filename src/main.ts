import "./style.css";
import { AssetResolver } from "./assets/resolver";
import { decodeBlp } from "./assets/blp";
import { mountMainMenu } from "./ui/mainMenu";
import { mountFdfMainMenu } from "./ui/fdfMainMenu";
import { mountSinglePlayerMenu } from "./ui/fdfSinglePlayerMenu";
import { mountSkirmish } from "./ui/fdfSkirmish";
import { mountCampaignScreen, type CampaignScreenState } from "./ui/fdfCampaign";
import { loadCampaigns, type Campaign } from "./data/campaigns";
import {
  loadDifficulty, markMissionComplete, saveDifficulty, type Difficulty,
} from "./data/campaignProgress";
import { mountLanScreen, savedPlayerName } from "./ui/fdfLan";
import { mountLanCreateScreen } from "./ui/fdfLanCreate";
import { mountLanLobbyScreen } from "./ui/fdfLanLobby";
import { LanLobby } from "./net/lobby";
import { WebSocketTransport } from "./net/transport";
import { mountOptions } from "./ui/fdfOptions";
import { applyAudioOptions, loadOptions } from "./data/options";
import { GlueManager, type GlueScreenDef } from "./ui/glue";
import { mountLoadGate, type GateLoad } from "./ui/gate";
import { setFdfClickSound, type FdfScreen } from "./ui/fdf/render";
import { GlueAudio } from "./ui/glueAudio";
import { SoundBoard } from "./audio/sounds";
import type { DataSource } from "./vfs/types";
import type { MeleeConfig, SlotConfig } from "./ui/lobby";
import { parseMapInfo, type MapInfo, type NeutralPlayer, type PlayerSlot } from "./world/mapInfo";
import { TerrainScene } from "./render/scene";
import { buildTerrainMesh } from "./render/terrainMesh";
import { makePlaceholderTerrain } from "./world/placeholderTerrain";
import { loadMapBytes } from "./world/map";
import { ModelViewerScene, type SequenceInfo } from "./render/modelViewer";
import { MapViewerScene } from "./render/mapViewer";
import type { MatchLinkSetup } from "./game/matchLink";
import { MenuScene } from "./render/menuScene";
import { applyMenuCursor } from "./ui/cursor";
import { applyGameFont } from "./ui/gameFont";

// Entry point (plan §6). WebGL scenes, one visible at a time:
//   #menubg — the animated main-menu glue scene (issue #54), behind the FDF menu
//   #bg     — Phase 2 placeholder terrain (WebGL2), the zero-asset fallback
//   #model  — Phase 3 single animated MDX unit (mdx-m3-viewer)
//   #map    — authentic full map + our sim (War3MapViewer)
// Boot shows nothing (an empty black background under the load gate) until the game
// files are imported — the menu's 3D scene is one of those files.
const bgCanvas = document.getElementById("bg") as HTMLCanvasElement;
const menuBgCanvas = document.getElementById("menubg") as HTMLCanvasElement;
const modelCanvas = document.getElementById("model") as HTMLCanvasElement;
const mapCanvas = document.getElementById("map") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

const resolver = new AssetResolver(null);

// Placeholder terrain is now only the zero-asset map fallback (kept idle until then),
// not the menu background — the menu uses the real MainMenu3D glue scene once loaded.
const terrain = new TerrainScene(bgCanvas);
terrain.setTerrain(buildTerrainMesh(makePlaceholderTerrain()));
terrain.setDoodads([]);

let modelScene: ModelViewerScene | null = null;
let mapScene: MapViewerScene | null = null;
let menuScene: MenuScene | null = null;
let menuDebug: { dispose(): void } | null = null;
// The page's audio. Built once the archives are mounted (every sound is read out of them)
// and handed on to the match, so the menu and the game share one AudioContext.
let sounds: SoundBoard | null = null;
let glueAudio: GlueAudio | null = null;
let meleeConfig: MeleeConfig | null = null; // consumed by the melee initializer (next)
// The LIVE match's end of the wire, held here because the match outlives the screen that
// assembled it and something has to close it when the match ends (docs/multiplayer.md F4).
let matchLink: MatchLinkSetup | null = null;
let installMaps: Map<string, File> = new Map(); // the install's Maps\ folder (Custom Game)

// The glue-screen stack (issue #61): main menu → Single Player → Custom Game, each
// leaving and arriving the way the reference does.
const glue = new GlueManager(null);

type Which = "none" | "menubg" | "bg" | "model" | "map";
function show(which: Which): void {
  menuBgCanvas.hidden = which !== "menubg";
  bgCanvas.hidden = which !== "bg";
  modelCanvas.hidden = which !== "model";
  mapCanvas.hidden = which !== "map";
  if (which !== "menubg") menuScene?.stop();
  if (which !== "bg") terrain.stop();
  if (which !== "model") modelScene?.stop();
  if (which !== "map") mapScene?.stop();
}

/** Show the animated main-menu 3D scene behind the menu (built on first use). Falls
 *  back to an empty background if the glue model is missing/fails to load. */
async function showMenuBackground(vfs: DataSource | null): Promise<void> {
  if (!vfs) { show("none"); return; }
  try {
    if (!menuScene) {
      menuScene = new MenuScene(menuBgCanvas, vfs);
      // The panel chrome's slide carries its own whooshes as SND events keyed into the clip
      // (ui/glueAudio.ts) — play them as they come due.
      menuScene.onSound = (code) => glueAudio?.event(code);
      await menuScene.load();
    }
    show("menubg");
    menuScene.start();
    glueAudio?.start(); // the main-screen theme + the wind under it
    // Opt-in on-screen framing controls (?menudebug) — tune the camera/panel, then
    // "Log values" to print numbers to bake into MenuScene.tuning.
    if (menuScene && !menuDebug && new URLSearchParams(location.search).has("menudebug")) {
      const { mountMenuDebug } = await import("./ui/menuDebug");
      menuDebug = mountMenuDebug(ui, menuScene);
    }
  } catch (err) {
    console.warn("[OpenWar3] main-menu 3D scene unavailable:", err);
    show("none"); // empty background
  }
}

/** Load a map's bytes into the right scene (authentic with an install, else placeholder). */
async function enterMap(bytes: Uint8Array, name: string): Promise<string> {
  const vfs = resolver.installSource;
  document.body.classList.add("in-game"); // hide the main-menu panel over the map
  if (vfs) {
    show("map");
    if (!mapScene) mapScene = await MapViewerScene.create(mapCanvas, vfs, sounds);
    mapScene.onExit = () => exitToMenu(); // F10 → End Game leaves the match
    // A campaign chapter is completed when its script declares the local player the winner —
    // that, and only that, opens the next one.
    mapScene.onLocalVictory = () => {
      if (pendingCampaign) markMissionComplete(pendingCampaign.key, pendingCampaign.index);
    };
    mapScene.loadMap(bytes);
    mapScene.start();
    return `${name} — authentic render (textures & models stream in)`;
  }
  show("bg");
  const { terrain: data, doodads } = loadMapBytes(bytes, name);
  terrain.setTerrain(buildTerrainMesh(data));
  terrain.setDoodads(doodads);
  terrain.start();
  return `${name}: placeholder terrain (import an install for authentic assets)`;
}

// --- the glue screens (issue #61) -------------------------------------------------
//
// Each is a GlueScreenDef: which chrome the panel model wears, and how to build the DOM.
// GlueManager runs the transition between them (every button goes disabled → contents fade
// out and the panel slides away → beat → the next panel drops in and its contents fade up),
// all of it timed off the chrome's own Birth/Death clips.

function mainMenuScreen(vfs: DataSource): { chrome: "MainMenu"; mount: () => Promise<FdfScreen> } {
  return {
    chrome: "MainMenu",
    mount: () => mountFdfMainMenu(ui, vfs, {
      onSinglePlayer: () => void glue.goTo(singlePlayerScreen(vfs)),
      onLan: () => void glue.goTo(lanScreen(vfs)),
      onOptions: () => void glue.goTo(optionsScreen(vfs)),
      onQuit: () => window.close(),
    }),
  };
}

/** The Options screen (issue #81), built from the game's own OptionsMenu.fdf. Its chrome is
 *  the panel model's own "Options" sequence triple. OK/Cancel both return to the main menu;
 *  the live SoundBoard is handed in so the Sound panel is audible as it's dragged. */
function optionsScreen(vfs: DataSource): { chrome: "Options"; mount: () => Promise<FdfScreen> } {
  return {
    chrome: "Options",
    mount: () => mountOptions(ui, vfs, {
      sounds,
      onClose: () => void glue.goTo(mainMenuScreen(vfs)),
    }),
  };
}

// --- the LAN screens (issue #77) ---------------------------------------------------
//
// Three screens over ONE relay connection: the game list (LocalMultiplayerJoin.fdf), the
// create screen that picks a map (LocalMultiplayerCreate.fdf), and the game LOBBY every
// player ends up in (GameChatroom.fdf). The connection is held HERE rather than by any of
// them, because it has to survive the transitions between them — and because at Start it is
// handed to the match, which outlives all three (LanLobby.handOff).

/** The live relay connection, and the promise that says whether it came up. Null while we
 *  are nowhere near the LAN screens. */
let lan: { lobby: LanLobby; connected: Promise<void> } | null = null;

function lanSession(): { lobby: LanLobby; connected: Promise<void> } {
  if (!lan) {
    const lobby = new LanLobby(() => new WebSocketTransport());
    // Swallowed here so an unhandled rejection is never logged twice; each screen attaches
    // its own `catch` to put the reason on screen.
    const connected = lobby.connect();
    connected.catch(() => {});
    lan = { lobby, connected };
  }
  return lan;
}

/** Leaving the LAN flow entirely (Cancel back to the main menu). A hand-off to a match has
 *  already made `dispose` a no-op, which is the point — see LanLobby.handedToMatch. */
function endLanSession(): void {
  lan?.lobby.dispose();
  lan = null;
}

/** Local Area Network: the relay-backed game list (src/net/, docs/multiplayer.md).
 *
 *  Chrome `BattlenetCustom` — read out of the panel model's own sequence table. The game
 *  has no LAN-specific chrome: LocalMultiplayerJoin.fdf is the transport-swapped twin of
 *  BattleNetCustomJoinPanel.fdf and they share this triple (see menuScene.ts). */
function lanScreen(vfs: DataSource): { chrome: "BattlenetCustom"; mount: () => Promise<FdfScreen> } {
  return {
    chrome: "BattlenetCustom",
    mount: () => {
      const { lobby, connected } = lanSession();
      return mountLanScreen(ui, vfs, installMaps, lobby, connected, {
        onCancel: () => { endLanSession(); void glue.goTo(mainMenuScreen(vfs)); },
        onCreateGame: () => void glue.goTo(lanCreateScreen(vfs)),
        // The relay confirmed a join: everyone in a room sits in the lobby, host or not.
        onJoined: (path, info) => void glue.goTo(lanLobbyScreen(vfs, { path, info })),
      });
    },
  };
}

/** "Create Game" on the LAN screen: pick the map to host, then announce the room and drop
 *  into the lobby — which is where the real client puts the host too. */
function lanCreateScreen(vfs: DataSource): { chrome: "BattlenetCustom"; mount: () => Promise<FdfScreen> } {
  return {
    chrome: "BattlenetCustom",
    mount: () => mountLanCreateScreen(ui, vfs, installMaps, {
      onCreate: (path, info, gameName) => {
        const { lobby, connected } = lanSession();
        // WAIT for the socket: a `LanLobby` with no transport yet drops a send on the floor
        // without a word, and this runs well before `connect()` has resolved.
        void connected.then(() => {
          lobby.host(gameName, savedPlayerName(), info.name, path, info.slots.length);
        }).catch(() => {}); // the failure is already on screen, on the list we came from
        void glue.goTo(lanLobbyScreen(vfs, { path, info }));
      },
      onCancel: () => void glue.goTo(lanScreen(vfs)),
    }),
  };
}

/** The game lobby — UI\FrameDef\Glue\GameChatroom.fdf, one row per player slot, with the
 *  chat area under it. Its chrome is the panel model's own "MultiplayerPreGameChat" triple. */
function lanLobbyScreen(
  vfs: DataSource,
  map: { path: string; info: MapInfo },
): { chrome: "MultiplayerPreGameChat"; mount: () => Promise<FdfScreen> } {
  return {
    chrome: "MultiplayerPreGameChat",
    mount: () => mountLanLobbyScreen(ui, vfs, installMaps, lanSession().lobby, map, {
      onCancel: () => void glue.goTo(lanScreen(vfs)),
      onStart: (path, info, config, link) => void startGame(mapFileFor(path), info, config, link),
    }),
  };
}

/** The install's own file for a map path — every client opens the map out of its own
 *  install, so a LAN start carries the path and each side resolves it here. */
function mapFileFor(path: string): File {
  const file = installMaps.get(path);
  if (!file) throw new Error(`No such map in this install: ${path}`);
  return file;
}

function singlePlayerScreen(vfs: DataSource): { chrome: "SinglePlayer"; mount: () => Promise<FdfScreen> } {
  return {
    chrome: "SinglePlayer",
    mount: () => mountSinglePlayerMenu(ui, vfs, {
      onCampaign: () => void openCampaignScreen(vfs),
      onCustomGame: () => void glue.goTo(skirmishScreen(vfs)),
      onCancel: () => void glue.goTo(mainMenuScreen(vfs)),
    }),
  };
}

// --- the Campaign screens (issue #101) ---------------------------------------------
//
// One screen in two modes — pick a campaign, then pick a chapter of it — over a full-screen
// 3D backdrop instead of the panel chrome every other glue screen wears (ui/fdfCampaign.ts,
// and MenuScene.showBackdrop for the scene half). The campaign index is read once and kept:
// it is one small text file, and both modes and every backdrop swap are views of it.

let campaigns: Campaign[] = [];
/** Which campaign the Campaign screen is on, and which of its two modes. Survives the trips
 *  into a mission and back, so returning lands on the chapter list you left. */
let campaignState: CampaignScreenState | null = null;

/** Open the Campaign screen — on the chapter list of the campaign the player last touched,
 *  else on the campaign list. */
async function openCampaignScreen(vfs: DataSource): Promise<void> {
  if (!campaigns.length) campaigns = await loadCampaigns(vfs);
  if (!campaigns.length) {
    // A Reign-of-Chaos-only install: UI\CampaignStrings_exp.txt is a TFT file, and RoC's
    // same-named predecessor is a different format we don't read yet (data/campaigns.ts).
    console.warn("[OpenWar3] no TFT campaign index in this install — Campaign unavailable");
    return;
  }
  campaignState ??= { campaign: campaigns[0], chapters: false, difficulty: loadDifficulty() };
  await glue.goTo(campaignScreen(vfs));
}

function campaignScreen(vfs: DataSource): GlueScreenDef {
  const state = campaignState!;
  return {
    // No chrome: the panel models carry no Campaign sequence triple, because the reference
    // hides the screen edges here entirely. `chrome` is unread while `backdrop` is set.
    chrome: "SinglePlayer",
    backdrop: state.campaign.background
      ? { path: state.campaign.background, fog: state.campaign.fog }
      : undefined,
    mount: () => {
      applyMenuCursor(vfs, state.campaign.cursor); // the campaign's own racial cursor
      setCampaignAmbience(state.campaign);
      return mountCampaignScreen(ui, vfs, campaigns, state, {
        onSelectCampaign: (c) => {
          state.campaign = c;
          state.chapters = true;
          void glue.goTo(campaignScreen(vfs)); // the backdrop changes with the campaign
        },
        onPlayMission: (c, index) => void startCampaignMission(vfs, c, index, state.difficulty),
        onBack: () => {
          if (state.chapters) { state.chapters = false; void glue.goTo(campaignScreen(vfs)); return; }
          leaveCampaignScreen(vfs);
          void glue.goTo(singlePlayerScreen(vfs));
        },
        onDifficulty: (d) => saveDifficulty(d),
      });
    },
  };
}

/** The loop under the campaign screen: the campaign's own `AmbientSound` row, in place of the
 *  main menu's wind. Both are AmbienceSounds.slk keys, so this is a swap, not a new channel. */
function setCampaignAmbience(c: Campaign): void {
  if (campaignAmbience && campaignAmbience !== c.ambientSound) sounds?.setAmbienceLoop(campaignAmbience, false);
  if (c.ambientSound) {
    glueAudio?.stopAmbience(); // the main screen's wind gives way to the campaign's
    sounds?.setAmbienceLoop(c.ambientSound, true);
  }
  campaignAmbience = c.ambientSound;
}
let campaignAmbience: string | null = null;

/** Leaving the Campaign screen for another menu: the main menu's cursor and wind come back. */
function leaveCampaignScreen(vfs: DataSource): void {
  applyMenuCursor(vfs);
  if (campaignAmbience) sounds?.setAmbienceLoop(campaignAmbience, false);
  campaignAmbience = null;
  glueAudio?.startAmbience();
}

/** Play a chapter. Campaign maps live INSIDE the archives (Maps\FrozenThrone\Campaign\*.w3x in
 *  War3x/War3xLocal), not in the install's `Maps\` folder the Custom Game screen browses, so
 *  the bytes come from the VFS. Everything after that is the ordinary custom-map path: the map
 *  is not melee-flagged, so its own triggers set the mission up — which is the point of the
 *  campaign as a test bed, since these maps are where WC3's cinematics actually live. */
async function startCampaignMission(vfs: DataSource, c: Campaign, index: number, difficulty: Difficulty): Promise<void> {
  const mission = c.missions[index];
  if (!mission || !vfs.exists(mission.file)) {
    console.warn(`[OpenWar3] campaign map missing from this install: ${mission?.file}`);
    return;
  }
  leaveCampaignScreen(vfs);
  const bytes = await vfs.read(mission.file);
  const info = parseMapInfo(bytes, mission.name);
  // The mission is finished the moment its own script declares victory — that is what opens
  // the next chapter (data/campaignProgress.ts).
  pendingCampaign = { key: c.key, index };
  await startGame(bytes, info, campaignConfig(info, difficulty, mission.name));
}

/** The chapter the player is IN, so a victory can be credited to it. */
let pendingCampaign: { key: string; index: number } | null = null;

/** The `?dev&chapter=` boot (src/dev/devBoot.ts): start the campaign chapter whose map path
 *  contains `name`, straight out of the mounted archives and on the campaign's own config.
 *  The chapters are where the cinematics and the scripted set-pieces are, and there is no
 *  other way for automation to reach one — the campaign screen needs a human. */
async function startChapter(name: string, difficulty: string): Promise<void> {
  const vfs = resolver.installSource;
  if (!vfs) throw new Error("no install mounted");
  const campaigns = await loadCampaigns(vfs);
  for (const c of campaigns) {
    const index = c.missions.findIndex((m) => m.playable && m.file.toLowerCase().includes(name.toLowerCase()));
    if (index < 0) continue;
    await startCampaignMission(vfs, c, index, difficulty as Difficulty);
    return;
  }
  throw new Error(`no campaign chapter matching "${name}"`);
}

/** A campaign map's lobby config. A campaign is single-player: the local player takes the
 *  first slot the map declares a human, and every other slot stays what the MAP made it —
 *  these maps seat their own AI (and their own neutral-hostile), and the start locations are
 *  the map's. Nothing here is a choice the player was offered EXCEPT the difficulty, because
 *  that is the only one the reference's campaign screen offers — and the map reads it:
 *  Terror of the Tides gates waves on `GetGameDifficulty()`. */
function campaignConfig(info: MapInfo, difficulty: Difficulty, title: string): MeleeConfig {
  const local = Math.max(0, info.slots.findIndex((s) => s.controller === "user"));
  const seat = (s: PlayerSlot | NeutralPlayer, i: number): SlotConfig => ({
    id: s.id,
    controller: i === local ? "user" : s.controller === "user" ? "computer" : s.controller,
    race: s.defaultRace,
    team: s.team,
    startX: s.startX,
    startY: s.startY,
    name: s.name, // the map's own name for the side ("Illidan's Naga"), for the hover tooltip
  });
  // The map's neutral/rescuable players ride along at the end, keeping the controller the map
  // gave them — they are nobody's AI and nobody's seat, but they own units and the mission
  // names them ("Prisoners", "Night Elf Villagers"). See MapInfo.neutralPlayers.
  const slots: SlotConfig[] = [
    ...info.slots.map(seat),
    ...info.neutralPlayers.map((s) => seat(s, -1)),
  ];
  return {
    slots,
    // A campaign chapter starts BLACK. "explored" is the Custom Game screen's convenience
    // default and was inherited here by accident; no campaign map has ever begun with its
    // terrain handed to you. It matters beyond looks — a chapter's own script is what parts
    // the mask (`CreateFogModifierRect`, `FogMaskEnable`, the cinematic reveals), and Rise of
    // the Naga's intro even wipes the map back to MASKED when the cinematic is skipped, which
    // only makes sense against a map that was never explored to begin with.
    fog: "unexplored",
    // What each force grants — and chapter one's grant "allied, no shared vision" is the whole
    // reason this travels: without it the Watchers, the Villagers and the Prisoners lit their
    // half of the map from the first frame (see MapInfo.ForceGrants).
    forces: info.forces.map((f) => ({ allied: f.allied, sharedVision: f.sharedVision })),
    // The chapter's title, because the map's own w3i name is the file's ("NightElfX01").
    mapName: title,
    seed: 1 + Math.floor(Math.random() * 2147483645),
    difficulty: DIFFICULTY_INDEX[difficulty],
    // A mission, not a game off a list — which is what makes the console's Allies and Chat
    // buttons dead: there is nobody to ally with and nobody to talk to.
    campaign: true,
  };
}

/** The campaign screen's choice as common.j's `gamedifficulty` index — MAP_DIFFICULTY_EASY 0 /
 *  NORMAL 1 / HARD 2 (INSANE 3 exists in common.j but no screen offers it). */
const DIFFICULTY_INDEX: Record<Difficulty, number> = { easy: 0, normal: 1, hard: 2 };

function skirmishScreen(vfs: DataSource): { chrome: "SinglePlayerSkirmish"; mount: () => Promise<FdfScreen> } {
  return {
    chrome: "SinglePlayerSkirmish",
    mount: () => mountSkirmish(ui, vfs, installMaps, {
      onCancel: () => void glue.goTo(singlePlayerScreen(vfs)),
      onStart: (file, info, config) => void startGame(file, info, config),
    }),
  };
}

/** Leave the menus and play: load the map, then melee or custom setup as the map asks.
 *
 *  The map arrives either as a FILE the player browsed to (the install's `Maps\` folder, which
 *  is what the Custom Game and LAN screens pick from) or as BYTES already read out of the
 *  archives — a campaign chapter lives inside War3x/War3xLocal and never touches the disk. */
async function startGame(
  map: File | Uint8Array,
  info: MapInfo,
  config: MeleeConfig,
  link?: MatchLinkSetup,
): Promise<void> {
  meleeConfig = config;
  matchLink = link ?? null;
  glue.dispose(); // the menus are done; the match owns the screen now — including its wire,
                  // which the LAN screen handed over before calling us (LanLobby.handOff)
  glueAudio?.stop(); // …and the music channel: the map's own script cues its music from here
  const bytes = map instanceof Uint8Array ? map : new Uint8Array(await map.arrayBuffer());
  await enterMap(bytes, info.name);
  // Melee maps get the standard setup (town hall + workers, melee rules);
  // custom/scenario maps run their own triggers instead (see mapKind.ts).
  if (info.isMelee) await mapScene?.startMelee(config);
  else await mapScene?.startCustom(config);
  // A LAN match hands over the match's end of the wire (docs/multiplayer.md item 10b-note); a
  // skirmish passes none, and the controller runs exactly as it always has. Attach it AFTER
  // setup so the world it snapshots exists.
  if (link) {
    mapScene?.attachMatchLink(link);
    // v1 has no host migration, so the room closing IS the end of the match — and this message
    // is the only evidence a client gets (docs/multiplayer.md Phase F item 6). Without it the
    // wire simply goes quiet and the client keeps simulating a world nobody owns any more.
    link.channel.onRoomClosed = () => mapScene?.showMatchOver();
  }
}

/** Enumerable unit models from the mounted install (portraits excluded). */
function listModels(): string[] {
  const vfs = resolver.installSource;
  if (!vfs) return [];
  return vfs
    .list()
    .filter((p) => /^units\\.*\.mdx$/i.test(p) && !/portrait/i.test(p))
    .sort();
}

async function viewModel(path: string): Promise<SequenceInfo[]> {
  const vfs = resolver.installSource;
  if (!vfs) throw new Error("Import a Warcraft III install first (click the menu status text).");
  show("model");
  if (!modelScene) modelScene = new ModelViewerScene(modelCanvas, vfs);
  const sequences = await modelScene.load(path);
  modelScene.start();
  return sequences;
}

function showTerrain(): void {
  show("bg");
  terrain.start();
}

/** Leave the current match (F10 → End Game): tear down the map scene and return to
 *  the main menu over its animated 3D scene. A fresh scene is built next game. */
function exitToMenu(): void {
  mapScene?.dispose();
  mapScene = null;
  meleeConfig = null;
  // The match owned the relay connection from the moment the LAN screen handed it over, so
  // leaving the match is what closes it. Skipping this would leave the room listed and the
  // socket open behind a player who is back at the main menu.
  matchLink?.channel.close?.();
  matchLink = null;
  lan = null; // the wire the match owned is closed; a fresh LAN session opens a fresh one
  document.body.classList.remove("in-game"); // reveal the main-menu panel again
  const vfs = resolver.installSource;
  // A campaign chapter returns to the chapter LIST it was started from — the reference drops
  // you back on the campaign screen, with the chapter you just finished now behind you.
  const campaign = pendingCampaign;
  pendingCampaign = null;
  void showMenuBackground(vfs).then(() => {
    if (!vfs) return;
    // glue.show() plays the chrome's Birth itself, so the DOM and the panel arrive together.
    if (campaign && campaignState) void glue.show(campaignScreen(vfs));
    else void glue.show(mainMenuScreen(vfs));
  });
}

// Boot flow (issue #54): the WC3 menus are constructed from the install's own
// UI\FrameDef\*.fdf files, so we gate on loading the game files first — a single
// button over the flying terrain — then build the FDF main menu and continue.
let gate: { dispose(): void } | null = null;

/** Build the authentic FDF-driven main menu; fall back to the flat skin if the install
 *  lacks the glue files or the FDF fails to construct. Every screen the game can reach is
 *  now built from the FrameDef — the Custom Game screen included — so the flat menu is a
 *  diagnostic, not a second way to play: it can only tell the player what's missing. */
async function showMainMenu(vfs: DataSource): Promise<void> {
  try {
    await glue.show(mainMenuScreen(vfs));
  } catch (err) {
    console.warn("[OpenWar3] FDF main menu unavailable, using flat menu:", err);
    mountMainMenu(ui, resolver, {
      onSinglePlayer: () => window.alert(
        "This install is missing the UI\\FrameDef\\Glue files the menus are built from, " +
        "so the game can't be set up. Re-import a complete Warcraft III (TFT 1.27a) folder.",
      ),
    });
  }
}

/** Everything mounting an install sets up EXCEPT showing the menu: the resolver, the map list,
 *  the cursor and the audio. Split out from onFilesLoaded because a scripted boot that goes
 *  straight into a match (src/dev/devBoot.ts) needs all of this and none of the menu. */
function mountInstall(load: GateLoad): void {
  resolver.setInstall(load.vfs);
  installMaps = load.maps; // the Custom Game screen's map list
  ((window as unknown as { openwar3: Record<string, unknown> }).openwar3 ??= {}).vfs = load.vfs;
  gate?.dispose();
  gate = null;
  applyMenuCursor(load.vfs); // WC3 human hand cursor in the menus
  applyGameFont(load.vfs); // Friz Quadrata TT, out of the install's own Fonts\ (issue #72)
  // Audio: every sound comes out of the archives, so this is the first moment it can exist.
  // The gate button the player just pressed is also the gesture that opens the browser's
  // autoplay gate, so the theme can start with the menu.
  sounds = new SoundBoard(load.vfs);
  // Honour the volumes/toggles the player saved last time (issue #81) from the very first
  // sound — before the menu theme starts below, so it comes up at the chosen music volume.
  applyAudioOptions(sounds, loadOptions());
  glueAudio = new GlueAudio(sounds, load.vfs);
  setFdfClickSound(() => glueAudio?.click()); // every FDF button, menu and in-game alike
  // Open the audio context NOW, on the gesture that got us here, and not at the first sound.
  // Resuming it is asynchronous, and the first sound the menu makes is the whoosh on the very
  // first frame of the main menu's Birth — ask for the context only then and that whoosh is
  // played into a context that is still suspended, i.e. dropped. The model load below buys the
  // resume all the time it needs.
  sounds.unlock();
}

/** Bring up the main menu over its animated 3D scene. The scene has to exist before the menus
 *  do: it owns the panel chrome whose Birth/Death clips time their transitions (ui/glue.ts). */
function showMenu(load: GateLoad): void {
  void showMenuBackground(load.vfs).then(() => {
    glue.setScene(menuScene);
    void showMainMenu(load.vfs);
  });
}

/** Hand off from the load gate to the main menu once the archives are mounted. */
function onFilesLoaded(load: GateLoad): void {
  mountInstall(load);
  showMenu(load);
}

// The right mouse button belongs to the GAME (it is the move/attack order), and a game has no
// browser context menu — anywhere, on any surface: the 3D canvas, the HUD, the menus. The
// individual canvases already swallowed it; this closes the rest of the page.
window.addEventListener("contextmenu", (e) => e.preventDefault());

// Boot. Normally the load gate: a human picks their Warcraft III folder, because that gesture
// is also what opens the browser's autoplay gate. Under `?dev` on a DEV SERVER ONLY, a scripted
// boot fetches the install over HTTP instead, so the game can be driven — and driven twice at
// once, from two player slots — by automation. `import.meta.env.DEV` is a compile-time constant
// that Vite folds to `false` for `pnpm build`, so this branch and the dynamic import inside it
// are dropped from the bundle entirely; there is no path from a shipped artifact to an asset
// route. See src/dev/devBoot.ts and tools/vite-plugin-dev-install.ts.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("dev")) {
  void import("./dev/devBoot")
    .then((m) => m.devBoot({ mountInstall, showMenu, startGame, startChapter }))
    .catch((err) => {
      console.error("[dev-boot] failed:", err);
      gate = mountLoadGate(ui, onFilesLoaded); // fall back to the human path
    });
} else {
  gate = mountLoadGate(ui, onFilesLoaded);
}

// Console hooks for the phase exit criteria (see README "Testing manually").
(window as unknown as { openwar3: Record<string, unknown> }).openwar3 = {
  resolver,
  decodeBlp,
  listModels,
  viewModel,
  setSequence: (index: number) => modelScene?.setSequence(index),
  showTerrain,
  loadMap: async (file: File) => enterMap(new Uint8Array(await file.arrayBuffer()), file.name),
  meleeConfig: () => meleeConfig,
  mainMenu: () => glue.screen,
  menuScene: () => menuScene,
  mapScene: () => mapScene, // the live match, for the two-client LAN harness's eval probes
};
