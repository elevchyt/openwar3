import { loadProfile } from "../vfs/loader";
import { DEFAULT_PROFILE } from "../vfs/profiles";
import type { InstallFiles } from "../assets/opfs";
import type { GateLoad } from "../ui/gate";
import type { FogMode, MeleeConfig, SlotConfig } from "../ui/lobby";
import { parseMapInfo, type MapInfo } from "../world/mapInfo";
import { LanLobby, type LobbyState } from "../net/lobby";
import { WebSocketTransport } from "../net/transport";
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

/** Ceiling on `?maps=`. Each map is a fetch and a mount; twenty is plenty to fill a list and
 *  still boots in seconds, where the install's full Maps\ folder would take minutes. Applies to
 *  the named form too — twenty deliberate choices is already more than a test needs. */
const MAX_DEV_MAPS = 20;

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
  log(`fetching ${archives.length} archives${mapPath ? ` + ${mapPath}` : ""}${extra}…`);
  const files: InstallFiles = new Map();
  for (const name of archives) files.set(name.toLowerCase(), await fetchFile(name));
  if (mapPath) files.set(mapPath, await fetchFile(mapPath));
  for (const name of listed) files.set(name, await fetchFile(name));

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
    start = buildStart(mapPath, info.name, info, lobby.snapshot, seed);
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
