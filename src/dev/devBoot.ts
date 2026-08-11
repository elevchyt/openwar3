import { loadProfile } from "../vfs/loader";
import { DEFAULT_PROFILE } from "../vfs/profiles";
import type { InstallFiles } from "../assets/opfs";
import type { ByteReader, CascFiles } from "../vfs/casc";
import type { GateLoad } from "../ui/gate";
import type { FogMode, MeleeConfig, SlotConfig } from "../ui/lobby";
import { parseMapInfo, type MapInfo } from "../world/mapInfo";
import { RACES, type Race } from "../data/races";
import { LanLobby, type LobbyState } from "../net/lobby";
import { WebSocketTransport } from "../net/transport";
import type { StartMatch as StartMatchMsg } from "../net/protocol";
import { toConfig } from "../ui/fdfLan";
import { buildStart, newSetup, seatPeers } from "../net/lobbySetup";
import { matchLinkFrom, type MatchLinkSetup } from "../game/matchLink";

/**
 * Scripted boot for automated testing — the load gate without the human
 * (docs/multiplayer.md Phase D item 1).
 *
 * **This file only ever runs in a dev server.** `main.ts` imports it dynamically behind
 * `import.meta.env.DEV`, which Vite folds to `false` in a build, so the whole branch and this
 * module with it are dropped from the bundle. It talks to `tools/vite-plugin-dev-install.ts`,
 * which carries `apply: "serve"` and likewise cannot exist in a build. Two independent gates,
 * both structural: OpenWar3 ships zero Blizzard bytes (CLAUDE.md).
 *
 * Fog is invisible to every headless test — `sim:test` cannot tell a correct vision refactor
 * from one that shows an enemy base through the fog. So Phase D is verified by driving the
 * real game, and this is what lets that be driven twice at once.
 *
 * URL:
 *   ?dev                                    boot to the main menu, install mounted
 *   ?dev&map=EchoIsles                      …and start the first map whose path contains that
 *   ?dev&map=EchoIsles&player=1&seed=7      …as slot 1, on a seed shared with the other client
 *   ?dev&map=EchoIsles&fog=unexplored       …with normal WC3 fog rather than start-explored
 *   ?dev&map=EchoIsles&race=nightelf        …with the local player seated as that race
 *   ?dev&chapter=NightElfX01                start a CAMPAIGN chapter (&difficulty=easy|normal|hard)
 *
 * `player` and `seed` are what make two-client testing possible: point two browser contexts at
 * the same map and seed with different slots and they are in the same world looking at it from
 * different eyes, which is the only way to see that a viewpoint is actually per-player.
 *
 * `chapter` is the campaign's twin of `map`, and it needs its own switch because a chapter is
 * not reachable through `map` at all: campaign maps live INSIDE War3xLocal.mpq, not in the
 * install's Maps\ folder that the manifest lists, and they start on the campaign's config
 * rather than a lobby's. The chapters are where the cinematics, the transports and the
 * neutral/rescuable players are, so they are exactly what needs driving.
 */

export interface DevBootHooks {
  /** Everything the gate does on a successful load EXCEPT showing the menu. */
  mountInstall(load: GateLoad): void;
  /** Show the main menu over its 3D scene — skipped when a map was asked for. */
  showMenu(load: GateLoad): void;
  startGame(file: File, info: MapInfo, config: MeleeConfig, link?: MatchLinkSetup): Promise<void>;
  /** Start a CAMPAIGN chapter by the name in its map path (`?chapter=`, see devBoot).
   *  Separate from `startGame` because a chapter is a different start: its map comes out of
   *  the ARCHIVES rather than the install's Maps\ folder, and it runs on the campaign's own
   *  config (single player in the map's own first human slot, unexplored fog, a difficulty). */
  startChapter(name: string, difficulty: string): Promise<void>;
}

interface CascManifest {
  buildInfo: string;
  config: string[];
  idx: string[];
  data: Record<number, string>;
}

interface Manifest {
  archives: string[];
  maps: string[];
  /** Present when the served install is 1.30+ (issue #102); null for a 1.27a one. */
  casc: CascManifest | null;
}

const log = (msg: string): void => console.info(`[dev-boot] ${msg}`);

async function fetchFile(path: string): Promise<File> {
  const res = await fetch(`/wc3/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  const name = path.split("\\").pop() ?? path;
  return new File([await res.blob()], name);
}

const fetchBytes = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await (await fetchFile(path)).arrayBuffer());

const fetchText = async (path: string): Promise<string> => (await fetchFile(path)).text();

/**
 * A `data.NNN` read over HTTP instead of off disk. The dev server honours `Range`
 * (tools/vite-plugin-dev-install.ts), so the mount slices a gigabyte file the same way it
 * slices a picked `File` — the alternative, downloading 1.7 GB per boot, is not one.
 */
async function remoteReader(path: string): Promise<ByteReader> {
  const head = await fetch(`/wc3/file?path=${encodeURIComponent(path)}`, { method: "HEAD" });
  if (!head.ok) throw new Error(`${path}: ${head.status} ${head.statusText}`);
  const size = Number(head.headers.get("content-length") ?? 0);
  return {
    size,
    slice: async (start, end) => {
      const res = await fetch(`/wc3/file?path=${encodeURIComponent(path)}`, {
        headers: { Range: `bytes=${start}-${end - 1}` },
      });
      if (!res.ok) throw new Error(`${path} [${start},${end}): ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Fetch the CASC pieces the mount needs. The `data.NNN` files stay remote and ranged. */
async function fetchCasc(manifest: CascManifest): Promise<CascFiles> {
  const casc: CascFiles = {
    buildInfo: await fetchText(manifest.buildInfo),
    config: new Map(),
    idx: new Map(),
    data: new Map(),
  };
  const base = (p: string): string => (p.split("\\").pop() ?? p).toLowerCase();
  for (const p of manifest.config) casc.config.set(base(p), await fetchText(p));
  for (const p of manifest.idx) casc.idx.set(base(p), await fetchBytes(p));
  for (const [n, p] of Object.entries(manifest.data)) casc.data.set(Number(n), await remoteReader(p));
  return casc;
}

/**
 * Seat every slot the map declares, with `player` at the wheel. Deliberately NOT the skirmish
 * screen's `toConfig`: that one rolls a fresh seed per match, and two clients that rolled
 * their own seeds are not in the same match. Here the seed is an input.
 */
function meleeConfigFor(info: MapInfo, player: number, seed: number, fog: FogMode, race: Race | null): MeleeConfig {
  // …plus the map's neutral/rescuable players, which no seating ever covers (MapInfo.neutralPlayers).
  const slots: SlotConfig[] = [...info.slots, ...info.neutralPlayers].map((s) => ({
    id: s.id,
    // Every seat a human could take is filled by one, so a second client can walk into any of
    // them. Slots the MAP owns as computers stay computers — that is the map's call, not the
    // lobby's (see PlayerSlot.controller).
    controller: s.controller,
    // `?race=` forces the PLAYABLE seats to one race. A melee map hands every slot
    // "random", so without this there is no way to boot straight into the race you are
    // working on — you reload until the dice agree. Neutral/rescuable seats keep theirs.
    race: race && s.id === player ? race : s.defaultRace,
    team: s.team,
    startX: s.startX,
    startY: s.startY,
    name: s.name,
  }));
  return { slots, fog, seed, localPlayer: player, forces: info.forces.map((f) => ({ allied: f.allied, sharedVision: f.sharedVision })) };
}

/** Ceiling on `?maps=`. Each map is a fetch and a mount; twenty is plenty to fill a list and
 *  still boots in seconds, where the install's full Maps\ folder would take minutes. Applies to
 *  the named form too — twenty deliberate choices is already more than a test needs. */
const MAX_DEV_MAPS = 20;

export async function devBoot(hooks: DevBootHooks): Promise<void> {
  const params = new URLSearchParams(location.search);
  const want = params.get("map") ?? params.get("dev");
  const wantMap = want && want !== "" && want !== "1" ? want : null;
  const wantChapter = params.get("chapter");
  const player = Number(params.get("player") ?? 0);
  const seed = Number(params.get("seed") ?? 1);
  // The lobby's three fog modes, because Phase D is ABOUT fog and a boot path that
  // could only ever start "explored" could not show the difference between them.
  const fog = (params.get("fog") ?? "explored") as FogMode;
  // `?race=nightelf` — seat the local player as that race instead of the map's default.
  const wantRace = params.get("race");
  const race: Race | null = wantRace && (RACES as string[]).includes(wantRace) ? (wantRace as Race) : null;

  log("fetching manifest…");
  const res = await fetch("/wc3/manifest.json");
  if (!res.ok) throw new Error("no dev install served — is OPENWAR3_INSTALL set?");
  const manifest = (await res.json()) as Manifest;

  // Only the archives the profile actually mounts, plus the one map we intend to play. The
  // install's Maps\ folder holds hundreds and fetching them all would add minutes to a boot
  // that already costs 2–4 under swiftshader. A 1.30.4 install has no archives at all — its
  // content store is mounted instead, and the maps beside it are still ordinary files.
  const wanted = DEFAULT_PROFILE.archives;
  const archives = manifest.casc ? [] : manifest.archives.filter((a) => wanted.includes(a.toLowerCase()));
  const mapPath = wantMap
    ? manifest.maps.find((m) => m.toLowerCase().includes(wantMap.toLowerCase()))
    : undefined;
  if (wantMap && !mapPath) throw new Error(`no map matching "${wantMap}" in the install`);

  // `?maps=N` — mount a HANDFUL of maps so the lobby has a list to choose FROM.
  //
  // Without this the dev boot could only ever mount a map you had already named, which meant
  // the one screen it could never exercise was the screen where you pick one: Create Game's
  // map list came up empty and its button stayed greyed, and there was no way to tell that
  // apart from the feature being broken. That is not a hypothetical — it is exactly how this
  // was found, while checking whether a LAN game could be created at all.
  //
  // A COUNT rather than "all" on purpose: the install holds hundreds of maps and fetching them
  // is minutes, which would make the boot useless for the thing it exists for. The default is
  // still zero, so every committed harness URL boots exactly as fast as it did.
  //
  // `?maps=` takes EITHER a count or a comma-separated list of names, and the second form is
  // there for the same reason the first one is. A count can only ever reach the first N maps of
  // an install that holds hundreds — so "test it on Lost Temple" was unreachable, and a harness
  // that cannot reach the map it was asked for reports the wrong thing about it. `?maps=8` is a
  // sample of the list; `?maps=LostTemple,EchoIsles` is a choice from it. Names match the same
  // way `?map=` does (case-insensitive substring), Frozen Throne first where both editions ship
  // one, and the count is still capped because fetching is the slow part either way.
  const mapsArg = (params.get("maps") ?? "").trim();
  const asCount = Number(mapsArg);
  // Frozen Throne first — they are what a LAN game is played on, and they are the ones whose
  // player counts and previews the lobby actually renders.
  const pool = manifest.maps
    .filter((m) => m !== mapPath)
    .sort((a, b) => Number(b.includes("FrozenThrone")) - Number(a.includes("FrozenThrone")));
  const listed = mapsArg && Number.isNaN(asCount)
    ? mapsArg
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => {
          const hit = pool.find((m) => m.toLowerCase().includes(name.toLowerCase()));
          if (!hit) throw new Error(`no map matching "${name}" in the install`);
          return hit;
        })
        .slice(0, MAX_DEV_MAPS)
    : pool.slice(0, Math.max(0, Math.min(MAX_DEV_MAPS, asCount || 0)));

  const extra = listed.length ? ` + ${listed.length} map(s) for the lobby list` : "";
  const store = manifest.casc ? "the CASC content store" : `${archives.length} archives`;
  log(`fetching ${store}${mapPath ? ` + ${mapPath}` : ""}${extra}…`);
  const files: InstallFiles = new Map();
  for (const name of archives) files.set(name.toLowerCase(), await fetchFile(name));
  if (mapPath) files.set(mapPath, await fetchFile(mapPath));
  for (const name of listed) files.set(name, await fetchFile(name));
  const casc = manifest.casc ? await fetchCasc(manifest.casc) : null;

  const load = await loadProfile({ files, casc }, DEFAULT_PROFILE, (msg) => log(msg));
  log(`mounted ${load.mounted.join(", ")} — ${load.fileCount.toLocaleString()} files`);
  hooks.mountInstall(load);

  // Re-entry, for automation. `?dev` starts ONE match, and a match is otherwise only
  // reachable through a menu a human clicks — so a harness that wants to check what LEAVING
  // one does (MapViewerScene.dispose: nothing a match puts on the page may outlive it) could
  // never play the second game that would show it. Reloading is no substitute: it resets the
  // very page state the check is about. So publish the starts the boot itself uses.
  // `devStartMap` takes any map mounted by `?map=`/`?maps=`, because the thing worth watching
  // is the change of map: a second game on the SAME one cannot show the first one's terrain
  // still on screen. Dev-server-only with the rest of this module — see the header.
  const api = ((window as unknown as { openwar3: Record<string, unknown> }).openwar3 ??= {});
  api.devStartChapter = (name: string, difficulty = "normal"): Promise<void> =>
    hooks.startChapter(name, difficulty);
  api.devStartMap = async (name: string): Promise<void> => {
    const path = [...load.maps.keys()].find((m) => m.toLowerCase().includes(name.toLowerCase()));
    const mapFile = path ? load.maps.get(path) : undefined;
    if (!mapFile) throw new Error(`no mounted map matching "${name}" — mount it with ?maps=`);
    const info = parseMapInfo(new Uint8Array(await mapFile.arrayBuffer()), path!);
    await hooks.startGame(mapFile, info, meleeConfigFor(info, player, seed, fog, race));
  };

  // A campaign chapter comes out of the archives we just mounted, so it needs no map file and
  // no manifest entry — only the name of one.
  if (wantChapter) {
    log(`starting chapter ${wantChapter}`);
    await hooks.startChapter(wantChapter, params.get("difficulty") ?? "normal");
    return;
  }

  if (!mapPath) {
    hooks.showMenu(load);
    return;
  }

  const file = load.maps.get(mapPath);
  if (!file) throw new Error(`${mapPath} did not survive the mount`);
  const info = parseMapInfo(new Uint8Array(await file.arrayBuffer()), mapPath);

  // Two-client LAN mode (docs/multiplayer.md Phase E item 10b-harness): the ONLY committed
  // path that carries a match through a real relay and a real `MatchLink`, so the snapshot
  // stream can be driven and watched between two browser contexts. `?dev` alone bypasses the
  // lobby — which is exactly why it builds no link — so this is a separate branch.
  const lan = params.get("lan"); // "host" | "join"
  if (lan === "host" || lan === "join") {
    await devLanBoot(hooks, lan, mapPath, info, file, seed, fog);
    return;
  }

  log(`starting ${info.name} as player ${player}, seed ${seed}`);
  await hooks.startGame(file, info, meleeConfigFor(info, player, seed, fog, race));
}

/** Resolve once the lobby's state satisfies `ready`, or reject after `timeoutMs`. */
function waitForLobby(lobby: LanLobby, ready: (s: LobbyState) => boolean, timeoutMs = 15000): Promise<LobbyState> {
  return new Promise((resolve, reject) => {
    const check = (s: LobbyState): boolean => (ready(s) ? (resolve(s), true) : false);
    if (check(lobby.snapshot)) return;
    const prev = lobby.onChange;
    const timer = setTimeout(() => reject(new Error("dev-LAN: timed out waiting for the lobby")), timeoutMs);
    lobby.onChange = (s) => {
      prev(s);
      if (check(s)) {
        clearTimeout(timer);
        lobby.onChange = prev;
      }
    };
  });
}

/**
 * Drive one side of a two-client LAN match over the real relay.
 *
 * The host creates the room, waits for the joiner, pins the match on the seed both were given,
 * and starts. The joiner finds the room, joins, and waits for the start message. BOTH then
 * assemble their `MatchLink` through `matchLinkFrom` — the same call `fdfLan` makes — so what
 * this proves is the production wiring, not a stand-in. Needs a relay: `node server/relay.mjs`.
 */
async function devLanBoot(
  hooks: DevBootHooks,
  side: "host" | "join",
  mapPath: string,
  info: MapInfo,
  file: File,
  seed: number,
  fog: FogMode,
): Promise<void> {
  const lobby = new LanLobby(() => new WebSocketTransport());
  log(`LAN ${side}: connecting to the relay…`);
  await lobby.connect(); // ws://<page host>:8787 — node server/relay.mjs

  let start: StartMatchMsg;
  if (side === "host") {
    lobby.host("dev-lan", "Host", info.name, mapPath, info.slots.length);
    await waitForLobby(lobby, (s) => s.phase === "hosting" && s.you !== null);
    log("LAN host: waiting for a joiner…");
    // Generous on purpose: the joiner may be a second browser cold-booting the whole
    // install fetch, which takes well past the default 15 s on the harness machine.
    await waitForLobby(lobby, (s) => s.peers.length >= 2, 180000);
    // The seating the GAME LOBBY would have produced, without the lobby screen: every peer
    // auto-seated in join order (src/net/lobbySetup.ts, the same call fdfLanLobby makes), and
    // every seat nobody took filled with a computer — the harness wants a full map, where a
    // human host would have picked Open or Computer per row.
    const seated = seatPeers(newSetup(mapPath, info.name, "dev-lan", info), lobby.snapshot.peers).setup;
    for (const slot of seated.slots) if (slot.kind === "open") slot.kind = "computer";
    start = buildStart(seated, seed);
    lobby.startMatch(start); // tell the joiner
    log(`LAN host: started, seed ${seed}`);
  } else {
    // Wait for a JOINABLE room, not merely a listed one: the relay holds a dropped match's
    // room open for reconnect (item 11a), so after a harness restart `rooms[0]` can be a
    // full zombie whose join is refused — which read as "the lobby is broken" three times
    // before the filter said otherwise.
    const joinable = (s: LobbyState) => s.rooms.find((r) => r.players < r.maxPlayers);
    await waitForLobby(lobby, (s) => joinable(s) !== undefined, 60000);
    lobby.join(joinable(lobby.snapshot)!.id, "Joiner");
    // 60 s, not the 15 s default: two game tabs booting at once saturate the harness
    // machine, and a timer that fires before the ack's onChange has run reads as a dead lobby.
    await waitForLobby(lobby, (s) => s.phase === "joined" && s.you !== null, 60000);
    log("LAN join: in the room, waiting for start…");
    start = await new Promise<StartMatchMsg>((resolve) => (lobby.onStart = resolve));
    log("LAN join: start received");
  }

  const me = lobby.snapshot.you?.id;
  const hostPeer = lobby.snapshot.peers.find((p) => p.host)?.id ?? 1;
  const link = matchLinkFrom(lobby, lobby.isHost, start.slots, me, hostPeer);
  const config = { ...toConfig(start, me), fog };
  await hooks.startGame(file, info, config, link);
}
