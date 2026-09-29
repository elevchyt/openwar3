// OpenWar3's own game patches — the balance Blizzard shipped after 1.30.4 (docs/patches.md,
// issue #160).
//
// The install is 1.30.4 and stays 1.30.4. Every later patch is written down HERE, one JSON file
// per release under `data/`, in the game's own terms (a file, a row id, a column or key, a
// value), and `PatchDataSource` (src/vfs/patch.ts) lays the whole chain over the install's
// tables so every reader — the registries, the viewer's own SLKs, the tooltips, the hotkey
// catalog — reads the patched game without knowing a patch exists.
//
// Three rules shape it:
//   • A patch touches ONE corner of the install's four data sets: The Frozen Throne's MELEE
//     tables (the live paths). Blizzard never rebalanced a custom set or Reign of Chaos after
//     1.30 — a campaign chapter plays on the numbers it was written for (docs/editions.md).
//   • The game is ALWAYS on the latest patch. `setPatchLevel` can roll it back to any release
//     in the chain, which is for US — a regression hunt, a test pinning a number — and nothing
//     a player can reach: no option, no lobby row, no saved setting.
//   • The Forsaken Paladin (3.0.0) does not exist. His ids are DENIED here, so no patch can
//     bring him in by accident (tools/patch-check.cjs fails on any mention, and the chain
//     below drops the row even if one slipped through).

import { applyReplace, isReplace, type FileEdits, type PatchValue, type RowEdit } from "./tables";
import { PATCH_FILES } from "./manifest";

/** One line of a patch's notes and the rows it rewrites. */
export interface PatchChange {
  /** The patch-note line, in our words — what a reader of the JSON needs to know WHY. */
  note: string;
  /** Where the line comes from when it is not the patch's own official notes: "liquipedia",
   *  "undocumented" (found in the data, never announced), or a URL. */
  source?: string;
  /** Install path → row id → column/key → value. */
  files?: Record<string, FileEdits>;
  /** Art this change ADDS (our own, src/patches/art/) at the WC3 path it is served from. */
  art?: string[];
}

/** A change that no table carries: engine behaviour the patch changed. Recorded so that code
 *  can ask `patchAtLeast(...)`, and so the ledger says what is still to build. */
export interface EngineChange {
  key: string;
  note: string;
  /** False until the engine models it — the ledger's to-do list. */
  implemented: boolean;
}

export interface GamePatch {
  /** "1.36.2", or "1.36.2.21228" for a hotfix build inside a numbered release. */
  patch: string;
  build: number;
  released: string;
  notes: string[];
  changes: PatchChange[];
  engine?: EngineChange[];
}

/** 1.30.4 — the install itself. The level the chain starts from; not a file. */
export const BASE_PATCH = "1.30.4";

/** Ids of the Forsaken Paladin and everything that is only his (3.0.0). A row keyed on one of
 *  these is dropped from the chain. His ABILITY ids were never published, so a check on the
 *  patch files (tools/patch-check.cjs) also refuses his name in any string. */
export const DENIED_IDS: readonly string[] = ["Npal"];
export const DENIED_WORDS: readonly RegExp[] = [/forsaken\s+paladin/i, /\bNpal\b/];

/** Compare two dotted versions numerically ("1.36.2" < "1.36.2.21214" < "1.36.10"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/** Every patch, oldest first. */
export const PATCHES: readonly GamePatch[] = [...(PATCH_FILES as unknown as GamePatch[])].sort((a, b) => compareVersions(a.patch, b.patch));

/** The newest release in the chain — the level the game plays on. */
export const LATEST_PATCH: string = PATCHES.length ? PATCHES[PATCHES.length - 1].patch : BASE_PATCH;

let level = LATEST_PATCH;
const listeners = new Set<() => void>();

/** The release the game is playing on right now. */
export function patchLevel(): string {
  return level;
}

/**
 * Roll the game back (or forward) to `version` — any release in the chain, or `BASE_PATCH` for
 * the install untouched. For developers only: tests, `?dev&patch=`, a regression hunt. Call it
 * before the install is mounted; a table parsed earlier holds the old level, which is why
 * every listener is a cache that must drop itself.
 */
export function setPatchLevel(version: string): void {
  if (version !== BASE_PATCH && !PATCHES.some((p) => p.patch === version)) {
    throw new Error(`no patch ${version} (have ${BASE_PATCH}, ${PATCHES.map((p) => p.patch).join(", ")})`);
  }
  if (version === level) return;
  level = version;
  resolved = null;
  for (const fn of listeners) fn();
}

/** Subscribe to `setPatchLevel`. Returns the unsubscribe. */
export function onPatchLevelChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Is the game on `version` or later? For ENGINE behaviour a patch changed (`engine` rows). */
export function patchAtLeast(version: string): boolean {
  return compareVersions(level, version) >= 0;
}

/** The patches in force at the current level, oldest first. */
export function activePatches(): readonly GamePatch[] {
  return PATCHES.filter((p) => compareVersions(p.patch, level) <= 0);
}

// ---------------------------------------------------------------------------------------------
// The chain, folded. Every active patch's edits to one file are composed into ONE edit, in
// release order, so a table is parsed and written once however many patches touched it.

interface Resolved {
  /** Lower-cased install path → the composed edits, keyed on the path as the patch spells it. */
  files: Map<string, { path: string; edits: FileEdits }>;
  /** Lower-cased WC3 path → the art's WC3 path. */
  art: Map<string, string>;
}

let resolved: Resolved | null = null;

function denied(id: string): boolean {
  return DENIED_IDS.includes(id);
}

function compose(into: FileEdits, edits: FileEdits): void {
  for (const [id, edit] of Object.entries(edits)) {
    if (denied(id)) continue;
    if (edit === null) {
      into[id] = null;
      continue;
    }
    const prev = into[id];
    const merged: RowEdit = prev ? { ...prev } : {};
    for (const [key, value] of Object.entries(edit)) {
      if (value === undefined) continue;
      if (key === "$base" && merged.$base !== undefined) continue; // the first creator's base stands
      const before = merged[key];
      if (isReplace(value) && typeof before === "string") merged[key] = applyReplace(before, value).text; // a replace on a value a patch SET
      else if (isReplace(value) && isReplace(before)) merged[key] = { replace: [...before.replace, ...value.replace] };
      else merged[key] = value as PatchValue;
    }
    into[id] = merged;
  }
}

function resolve(): Resolved {
  if (resolved) return resolved;
  const files = new Map<string, { path: string; edits: FileEdits }>();
  const art = new Map<string, string>();
  for (const patch of activePatches()) {
    for (const change of patch.changes) {
      for (const [path, edits] of Object.entries(change.files ?? {})) {
        const key = normalize(path);
        let entry = files.get(key);
        if (!entry) files.set(key, (entry = { path, edits: {} }));
        compose(entry.edits, edits);
      }
      for (const path of change.art ?? []) art.set(normalize(path), path);
    }
  }
  return (resolved = { files, art });
}

/** Install paths compare case- and slash-insensitively, as every DataSource does. */
export function normalize(path: string): string {
  return path.replace(/\//g, "\\").replace(/^\\+/, "").toLowerCase();
}

/** The composed edits the chain makes to `path`, or null if no active patch touches it. */
export function patchedEdits(path: string): FileEdits | null {
  return resolve().files.get(normalize(path))?.edits ?? null;
}

/** Every file the active chain rewrites, as the patches spell the paths. */
export function patchedFiles(): string[] {
  return [...resolve().files.values()].map((f) => f.path);
}

/** Every piece of our own art the active chain serves, at its WC3 path. */
export function patchedArt(): string[] {
  return [...resolve().art.values()];
}

/** Does the active chain serve art at `path`? */
export function hasPatchedArt(path: string): boolean {
  return resolve().art.has(normalize(path));
}

/**
 * `Units\MiscGame.txt` `[Misc]` `key` as the active chain leaves it, or undefined when no patch
 * has touched the row. `MISC_GAME` is compiled in (src/data/gameplayConstants.ts), out of the
 * VFS's reach, so `miscGame()` asks this — the same edit, read from the same place.
 */
export function patchedMiscGame(key: string): string | undefined {
  const misc = patchedEdits("Units\\MiscGame.txt")?.Misc;
  if (!misc) return undefined;
  const hit = Object.entries(misc).find(([k]) => k.toLowerCase() === key.toLowerCase());
  return hit && hit[1] !== null && hit[1] !== undefined && !isReplace(hit[1]) ? String(hit[1]) : undefined;
}
