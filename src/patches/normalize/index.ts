import type { FileEdits } from "../tables";

// The builds OpenWar3 turns into 1.30.4 at the mount, and how each one is recognised
// (src/vfs/normalize.ts, docs/versions.md).
//
// Every file beside this one is made — and proved to leave no cell of difference — by
//
//     node tools/version-survey.mjs --install <folder> --label <version>      (an MPQ build)
//     node tools/patch-extract.mjs --normalize .cdn-cache/extract/<version>
//
// and is loaded only by the install that needs it.

export interface Normalization {
  from: string;
  to: string;
  /** Tables the build does not have at all: path → the SLK's header row ([] for a TXT). */
  create?: Record<string, string[]>;
  files: Record<string, FileEdits>;
}

type Loader = () => Promise<unknown>;

/** Version → its edits. A version is the label its file is named after. */
const LOADERS: Record<string, Loader> = {
  "1.21a": () => import("./1.21a.json"),
  "1.28.5": () => import("./1.28.5.json"),
  "1.29.1": () => import("./1.29.1.json"),
  "1.29.2": () => import("./1.29.2.json"),
  "1.31.1": () => import("./1.31.1.json"),
};

/** `buildFingerprint` (src/vfs/mpqEra.ts) of every MPQ build there is a normalization for. */
export const FINGERPRINTS: Record<string, string> = {
  "06e9df81": "1.21a",
  fe1f0690: "1.28.5",
  "20cae893": "1.29.1",
  "047ff9b0": "1.29.2",
};

export const hasNormalization = (version: string): boolean => version in LOADERS;

export async function loadNormalization(version: string): Promise<Normalization | null> {
  const load = LOADERS[version];
  if (!load) return null;
  const mod = (await load()) as { default?: Normalization } & Normalization;
  return mod.default ?? mod;
}
