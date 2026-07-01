// Virtual filesystem contract (plan §1 "DataSource layered VFS", §5).
// Every asset lookup in the engine goes through a DataSource, so MPQ, a layered
// stack, OPFS, or (later) CASC are all interchangeable behind this interface.

export interface DataSource {
  /** Human-readable name for diagnostics (e.g. "war3x.mpq"). */
  readonly label: string;
  /** Case-insensitive, slash-insensitive existence check. */
  exists(path: string): boolean;
  /** Read a file's bytes. Rejects if the path is absent. */
  read(path: string): Promise<Uint8Array>;
  /** Known file paths. Requires a listfile for MPQ sources (WC3's MPQs ship one). */
  list(): string[];
}

/**
 * Normalize a logical path to MPQ form: backslash separators, no leading slash.
 * MPQ hashing upper-cases names (so lookups are case-insensitive) but does NOT
 * convert '/' to '\', so we must do that here.
 */
export function normalizeMpqPath(path: string): string {
  return path.replace(/\//g, "\\").replace(/^\\+/, "");
}
