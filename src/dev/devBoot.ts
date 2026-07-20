import { loadProfile } from "../vfs/loader";
import { DEFAULT_PROFILE } from "../vfs/profiles";
import type { InstallFiles } from "../assets/opfs";
import type { GateLoad } from "../ui/gate";
import type { FogMode, MeleeConfig, SlotConfig } from "../ui/lobby";
import { parseMapInfo, type MapInfo } from "../world/mapInfo";

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
  startGame(file: File, info: MapInfo, config: MeleeConfig): Promise<void>;
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
  log(`starting ${info.name} as player ${player}, seed ${seed}`);
  await hooks.startGame(file, info, meleeConfigFor(info, player, seed, fog));
}
