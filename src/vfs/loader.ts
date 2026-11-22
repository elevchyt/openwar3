import { isMpqEraInstall, MpqEraDataSource } from "./mpqEra";
import { buildInfoVersion, CascDataSource, isCascInstall } from "./casc";
import type { DataSource, LoadProgress } from "./types";
import type { ContentProfile } from "./profiles";
import { installMaps, type PickedInstall } from "../assets/opfs";
import { checkVersion } from "./version";
import { setCustomKeys } from "../data/customKeys";
import { setMapWriter } from "../assets/downloadedMaps";
import { EditionDataSource } from "./edition";
import { PatchDataSource } from "./patch";
import { DerivedArtDataSource } from "./derivedArt";
import { mpqEraBuild, NormalizeDataSource } from "./normalize";
import { hasNormalization, loadNormalization } from "../patches/normalize";

// Turn a picked install into a mounted VFS (plan §1 exit: "enumerate/extract any file by path
// from a real install").
//
// Two storages, one mount (issues #102, #319). A 1.30+ folder is a CASC content store; every
// build before it is a handful of MPQs beside the exe (src/vfs/mpqEra.ts) — the Legacy install
// Battle.net ships beside Reforged among them, which is the one we recommend. Which one a
// folder is is not a question the player gets asked: the archives beside the exe answer it.
//
// Whatever the build, what comes out is the SAME game: its object tables are turned into
// 1.30.4's (src/vfs/normalize.ts) and the later patches are laid over those (src/vfs/patch.ts),
// so every player reads one set of numbers. See docs/versions.md.

export interface LoadResult {
  vfs: DataSource;
  /** Archives found and mounted, in override order. */
  mounted: string[];
  /** Profile archives not present in the picked folder (e.g. optional patch). */
  missing: string[];
  /** Total resolved file paths across all layers. */
  fileCount: number;
  /** The install's own `Maps\` folder, path → File — what the Custom Game screen lists.
   *  These are files on disk beside the archives, not entries inside them. */
  maps: Map<string, File>;
  /** Which game files this is, as a replay's header names it (game/replay.ts `install`). */
  flavour: string;
}

export async function loadProfile(
  install: PickedInstall,
  profile: ContentProfile,
  onProgress?: LoadProgress,
): Promise<LoadResult> {
  // The version gate, BEFORE a byte is mounted (src/vfs/version.ts). Here rather than at either
  // door, because both go through this function — the browser's picker, the desktop app reading
  // the folder it remembered, and the scripted `?dev` boot — and a check that only one of them
  // runs is a check the others are exempt from. It is also why a player who patches Warcraft III
  // between launches is told on the next one.
  const verdict = checkVersion(install);
  if (!verdict.ok) throw new Error(verdict.message);

  // The player's own `CustomKeys.txt` (issue #142), handed to the data layer HERE for the same
  // reason the version gate is asked here: this is the one function all three doors pass
  // through. It is a loose file in the folder rather than an archive entry, so it cannot arrive
  // through the `DataSource` every other table is read from — see src/data/customKeys.ts.
  setCustomKeys(install.customKeys, install.saveCustomKeys ?? null);
  // …and the writer that keeps a map a LAN game hands us, in `Maps\Download\` — the same one
  // door, for the same reason (src/assets/downloadedMaps.ts).
  setMapWriter(install.saveMap ?? null, install.askMapWrite ?? null);

  const maps = installMaps(install.files);

  // Both storages are handed out through the EDITION overlay (src/vfs/edition.ts): while the
  // client is on Reign of Chaos, an object table with a `Melee_V0\` twin reads the twin. Wrapped
  // here, at the one door, so nothing downstream can read the expansion's tables by accident.
  // An MPQ-era folder FIRST: the Legacy install has a `.build.info` and a `Data\` of its own
  // (the launcher's), and it is the archives beside them that are the game.
  if (isMpqEraInstall(install.files.keys())) {
    const mpq = await MpqEraDataSource.open(install.files, onProgress);
    const build = mpqEraBuild(mpq, mpq.mounted);
    if (!build.exact) {
      console.warn(`[install] this build's tables match no measured version — normalizing it as ${build.version}, the nearest with its archive layout (docs/versions.md)`);
    }
    onProgress?.("Bringing the game data up to date…");
    const edits = await loadNormalization(build.version);
    const store: DataSource = edits ? new NormalizeDataSource(mpq, edits, build.version) : mpq;
    const vfs = new DerivedArtDataSource(new EditionDataSource(new PatchDataSource(store)));
    onProgress?.("Preparing icons…");
    vfs.prepare();
    const missing = profile.archives.filter((a) => !mpq.mounted.some((m) => m.toLowerCase() === a));
    const flavour = `mpq-${build.version}${build.exact ? "" : "~"}-normalized`;
    return { vfs, mounted: mpq.mounted, missing, fileCount: mpq.list().length, maps, flavour };
  }

  if (isCascInstall(install.casc)) {
    const casc = await CascDataSource.open(install.casc, onProgress);
    // A 1.31.1 store (the Internet Archive's copy "Download game files" falls back on) has its
    // game data put back to 1.30.4's before anything reads it (src/vfs/normalize.ts) — UNDER the
    // patches, so they land on the same tables a 1.30.4 install has.
    const version = buildInfoVersion(install.casc.buildInfo);
    const build = version?.split(".").slice(0, 3).join(".") ?? "";
    const downgrade = hasNormalization(build) ? await loadNormalization(build) : null;
    const store: DataSource = downgrade ? new NormalizeDataSource(casc, downgrade, version ?? "") : casc;
    // …and the game's later patches UNDER the edition overlay, so they reach the live melee
    // tables alone (src/vfs/patch.ts, docs/patches.md): the patches are stated against 1.30.4,
    // which a 1.31.1 store has just been turned back into.
    // …and, over everything, the icons the tables name and the install lacks, derived from the
    // ones it has (src/vfs/derivedArt.ts, docs/icons.md) — computed here, once, after the mount.
    const vfs = new DerivedArtDataSource(new EditionDataSource(new PatchDataSource(store)));
    onProgress?.("Preparing icons…");
    vfs.prepare();
    // A 1.31 store carries its maps INSIDE (vfs/casc.ts `storeMaps`) and its folder has no
    // `Maps\` — the Internet Archive's copy is just the store. A loose file of the same name
    // wins, as the player's own folder always does.
    for (const [key, file] of casc.storeMaps()) {
      if (![...maps.keys()].some((k) => k.toLowerCase() === key.toLowerCase())) maps.set(key, file);
    }
    const flavour = `casc-${version ?? "unknown"}${downgrade ? "-downgraded" : ""}`;
    return { vfs, mounted: casc.mounted, missing: [], fileCount: casc.list().length, maps, flavour };
  }

  throw new Error(`No ${profile.name} archives and no Data\\ content store. Is this your Warcraft III folder?`);
}
