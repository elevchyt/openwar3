import { MpqDataSource } from "./mpq";
import { LayeredDataSource } from "./layered";
import type { DataSource } from "./types";
import type { ContentProfile } from "./profiles";
import { installMaps, type InstallFiles } from "../assets/opfs";

// Turn imported install files into a mounted, layered VFS for a content profile
// (plan §1 exit: "enumerate/extract any file by path from a real install").

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
  files: InstallFiles,
  profile: ContentProfile,
): Promise<LoadResult> {
  const sources: DataSource[] = [];
  const mounted: string[] = [];
  const missing: string[] = [];

  // Build lowest→highest as declared; skip archives the folder doesn't have.
  for (const name of profile.archives) {
    const file = files.get(name.toLowerCase());
    if (!file) {
      missing.push(name);
      continue;
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    sources.push(new MpqDataSource(name, buffer));
    mounted.push(name);
  }

  if (!sources.length) {
    throw new Error(
      `No ${profile.name} archives found. Is this your Warcraft III folder?`,
    );
  }

  // LayeredDataSource wants highest priority first, so reverse the mount order.
  const vfs = new LayeredDataSource(sources.slice().reverse());
  return { vfs, mounted, missing, fileCount: vfs.list().length, maps: installMaps(files) };
}
