import { MpqDataSource } from "./mpq";
import { LayeredDataSource } from "./layered";
import { CascDataSource, isCascInstall } from "./casc";
import type { DataSource } from "./types";
import type { ContentProfile } from "./profiles";
import { installMaps, type PickedInstall } from "../assets/opfs";
import { checkVersion } from "./version";
import { setCustomKeys } from "../data/customKeys";

// Turn a picked install into a mounted VFS (plan §1 exit: "enumerate/extract any file by path
// from a real install").
//
// Two storages, one mount (issue #102). A 1.30.4 folder is a CASC content store, and that is
// the version OpenWar3 targets — it is the one whose UI is built for widescreen. An MPQ-era
// folder is four MPQs, and that path stays: it is what the engine was first written against,
// and an install nobody has patched is still a perfectly good install. Which one a folder is
// is not a question the player gets asked — `.build.info` beside the exe answers it.

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
}

export async function loadProfile(
  install: PickedInstall,
  profile: ContentProfile,
  onProgress?: (message: string) => void,
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
  setCustomKeys(install.customKeys);

  const maps = installMaps(install.files);

  if (isCascInstall(install.casc)) {
    const vfs = await CascDataSource.open(install.casc, onProgress);
    return { vfs, mounted: vfs.mounted, missing: [], fileCount: vfs.list().length, maps };
  }

  const sources: DataSource[] = [];
  const mounted: string[] = [];
  const missing: string[] = [];

  // Build lowest→highest as declared; skip archives the folder doesn't have.
  for (const name of profile.archives) {
    const file = install.files.get(name.toLowerCase());
    if (!file) {
      missing.push(name);
      continue;
    }
    onProgress?.(`Mounting ${name}…`);
    const buffer = new Uint8Array(await file.arrayBuffer());
    sources.push(new MpqDataSource(name, buffer));
    mounted.push(name);
  }

  if (!sources.length) {
    throw new Error(
      `No ${profile.name} archives and no Data\\ content store. Is this your Warcraft III folder?`,
    );
  }

  // LayeredDataSource wants highest priority first, so reverse the mount order.
  const vfs = new LayeredDataSource(sources.slice().reverse());
  return { vfs, mounted, missing, fileCount: vfs.list().length, maps };
}
