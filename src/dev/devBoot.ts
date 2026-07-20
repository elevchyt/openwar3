import { loadProfile } from "../vfs/loader";
import { DEFAULT_PROFILE } from "../vfs/profiles";
import type { InstallFiles } from "../assets/opfs";
import type { GateLoad } from "../ui/gate";
import type { FogMode, MeleeConfig, SlotConfig } from "../ui/lobby";
import { parseMapInfo, type MapInfo } from "../world/mapInfo";
import { LanLobby, type LobbyState } from "../net/lobby";
import type { StartMatch as StartMatchMsg } from "../net/protocol";
import { buildStart, toConfig } from "../ui/fdfLan";
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
 *
 * `player` and `seed` are what make two-client testing possible: point two browser contexts at
 * the same map and seed with different slots and they are in the same world looking at it from
 * different eyes, which is the only way to see that a viewpoint is actually per-player.
 */

export interface DevBootHooks {
  /** Everything the gate does on a successful load EXCEPT showing the menu. */
  mountInstall(load: GateLoad): void;
  /** Show the main menu over its 3D scene — skipped when a map was asked for. */
  showMenu(load: GateLoad): void;
  startGame(file: File, info: MapInfo, config: MeleeConfig, link?: MatchLinkSetup): Promise<void>;
}

interface Manifest {
  archives: string[];
  maps: string[];
}

const log = (msg: string): void => console.info(`[dev-boot] ${msg}`);

async function fetchFile(path: string): Promise<File> {
  const res = await fetch(`/wc3/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  const name = path.split("\\").pop() ?? path;
  return new File([await res.blob()], name);
}

/**
 * Seat every slot the map declares, with `player` at the wheel. Deliberately NOT the skirmish
 * screen's `toConfig`: that one rolls a fresh seed per match, and two clients that rolled
 * their own seeds are not in the same match. Here the seed is an input.
 */
function meleeConfigFor(info: MapInfo, player: number, seed: number, fog: FogMode): MeleeConfig {
  const slots: SlotConfig[] = info.slots.map((s) => ({
    id: s.id,
    // Every seat a human could take is filled by one, so a second client can walk into any of
    // them. Slots the MAP owns as computers stay computers — that is the map's call, not the
    // lobby's (see PlayerSlot.controller).
    controller: s.controller,
    race: s.defaultRace,
    team: s.team,
    startX: s.startX,
    startY: s.startY,
  }));
  return { slots, fog, seed, localPlayer: player };
}

export async function devBoot(hooks: DevBootHooks): Promise<void> {
  const params = new URLSearchParams(location.search);
  const want = params.get("map") ?? params.get("dev");
  const wantMap = want && want !== "" && want !== "1" ? want : null;
  const player = Number(params.get("player") ?? 0);
  const seed = Number(params.get("seed") ?? 1);
  // The lobby's three fog modes, because Phase D is ABOUT fog and a boot path that
  // could only ever start "explored" could not show the difference between them.
  const fog = (params.get("fog") ?? "explored") as FogMode;

  log("fetching manifest…");
  const res = await fetch("/wc3/manifest.json");
  if (!res.ok) throw new Error("no dev install served — is OPENWAR3_INSTALL set?");
  const manifest = (await res.json()) as Manifest;

  // Only the archives the profile actually mounts, plus the one map we intend to play. The
  // install's Maps\ folder holds hundreds and fetching them all would add minutes to a boot
  // that already costs 2–4 under swiftshader.
  const wanted = DEFAULT_PROFILE.archives;
  const archives = manifest.archives.filter((a) => wanted.includes(a.toLowerCase()));
  const mapPath = wantMap
    ? manifest.maps.find((m) => m.toLowerCase().includes(wantMap.toLowerCase()))
    : undefined;
  if (wantMap && !mapPath) throw new Error(`no map matching "${wantMap}" in the install`);

  log(`fetching ${archives.length} archives${mapPath ? ` + ${mapPath}` : ""}…`);
  const files: InstallFiles = new Map();
  for (const name of archives) files.set(name.toLowerCase(), await fetchFile(name));
  if (mapPath) files.set(mapPath, await fetchFile(mapPath));

  const load = await loadProfile(files, DEFAULT_PROFILE);
  log(`mounted ${load.mounted.join(", ")} — ${load.fileCount.toLocaleString()} files`);
  hooks.mountInstall(load);

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
  await hooks.startGame(file, info, meleeConfigFor(info, player, seed, fog));
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
  const lobby = new LanLobby();
  log(`LAN ${side}: connecting to the relay…`);
  await lobby.connect(); // ws://<page host>:8787 — node server/relay.mjs

  let start: StartMatchMsg;
  if (side === "host") {
    lobby.host("dev-lan", "Host", info.name, mapPath, info.slots.length);
    await waitForLobby(lobby, (s) => s.phase === "hosting" && s.you !== null);
    log("LAN host: waiting for a joiner…");
    await waitForLobby(lobby, (s) => s.peers.length >= 2);
    start = buildStart(mapPath, info.name, info, lobby.snapshot, seed);
    lobby.startMatch(start); // tell the joiner
    log(`LAN host: started, seed ${seed}`);
  } else {
    await waitForLobby(lobby, (s) => s.rooms.length > 0);
    lobby.join(lobby.snapshot.rooms[0].id, "Joiner");
    await waitForLobby(lobby, (s) => s.phase === "joined" && s.you !== null);
    log("LAN join: in the room, waiting for start…");
    start = await new Promise<StartMatchMsg>((resolve) => (lobby.onStart = resolve));
    log("LAN join: start received");
  }

  const me = lobby.snapshot.you?.id;
  const link = matchLinkFrom(lobby, lobby.isHost, start.slots, me);
  const config = { ...toConfig(start, me), fog };
  await hooks.startGame(file, info, config, link);
}
