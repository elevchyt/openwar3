import type { FdfFrame } from "../ui/fdf/parser";
import type { FdfLibrary } from "../ui/fdf/library";
import advancedOptionsFdf from "./ui/AdvancedOptionsPane.fdf?raw";
import globalStringsFdf from "./ui/GlobalStrings.fdf?raw";
import optionsMenuFdf from "./ui/OptionsMenu.fdf?raw";

// OpenWar3's own layer on top of the game's UI files (issue #124). Read `README.md` first.
//
// The rule this exists to keep: **`UI\FrameDef\` is the player's install and we never write to
// it.** A control OpenWar3 needs that the 2003 UI has no frame for is declared HERE, in a small
// file in the game's own FrameDef language, and laid over the screen at mount time. Nothing in
// this repository is a copy of a Blizzard file, and no Blizzard file is edited.
//
// A layer is two things, because an FDF screen is built in two stages:
//   · `layer` runs ONCE, at mount, and puts the override's frames and strings into the screen's
//     `FdfLibrary` — where they win over the install's if a name collides;
//   · `applyOverride` runs on EVERY build (a screen rebuilds its whole tree on resize) and
//     edits the resolved tree: it drops the frames the override retires and adopts the ones it
//     adds into a named container.
// Both are wired into `mountFdfScreen`'s `overrides` option, so a screen opts in with one line.

export interface FdfOverride {
  /** A stable id — the library layers each override at most once. */
  readonly id: string;
  /** The override's own FDF source: new frames, new strings. */
  readonly source: string;
  /** Frames this override RETIRES, with everything under them. FDF is a declaration language
   *  and has no syntax for deleting, so the list lives here rather than in the file — the file
   *  says why each one goes. */
  readonly remove?: readonly string[];
  /** New frames to hang inside an existing container, IN ORDER — a row's label anchors to its
   *  checkbox, so the checkbox has to be adopted first. */
  readonly add?: ReadonlyArray<{ frame: string; into: string }>;
}

/** Strings the game has no key for. Layered by both screens below — a screen's own override
 *  carries frames, and the labels those frames name live in one place. */
export const OW3_STRINGS: FdfOverride = { id: "ow3-strings", source: globalStringsFdf };

/**
 * Options → Gameplay: out with the Game Port and the Chat Support gateway, in with the
 * Computer+ default (issue #124).
 *
 * The four retired frames are the label/control pairs of two settings this engine has no
 * meaning for; nothing else in the panel anchors to any of them, so the panel just ends a row
 * earlier. See `ui/OptionsMenu.fdf` for the reasons.
 */
export const OPTIONS_MENU_OVERRIDE: FdfOverride = {
  id: "ow3-options-menu",
  source: optionsMenuFdf,
  remove: ["GamePortLabel", "GamePortEditBox", "ChatSupportLabel", "ChatSupportBackdrop"],
  add: [
    { frame: "ComputerPlusDefaultCheckBox", into: "GameplayPanel" },
    { frame: "ComputerPlusDefaultLabel", into: "GameplayPanel" },
  ],
};

/** Custom Game → Advanced Options: the "Computer+ (Improved AI)" switch, at the bottom of the
 *  pane where issue #124 asks for it. */
export const ADVANCED_OPTIONS_OVERRIDE: FdfOverride = {
  id: "ow3-advanced-options",
  source: advancedOptionsFdf,
  add: [
    { frame: "ComputerPlusLabel", into: "AdvancedOptionsPane" },
    { frame: "ComputerPlusCheckBox", into: "AdvancedOptionsPane" },
  ],
};

/**
 * Put an override's frames and strings into the library, over the install's.
 *
 * Idempotent by `id`, because `mountFdfScreen` may be handed the same override twice (both
 * screens layer `OW3_STRINGS`) and a screen's library outlives its builds.
 */
export function layer(lib: FdfLibrary, override: FdfOverride): void {
  lib.loadOverride(override.id, override.source);
}

/**
 * Edit one built frame tree: drop what the override retires, adopt what it adds.
 *
 * Silently does nothing for a frame that is not in this tree, which is the right no-op in two
 * real cases: the Custom Game screen builds its Advanced Options pane only while that face of
 * the column is up, and a screen may be mounted against an install whose FDF differs.
 */
export function applyOverride(lib: FdfLibrary, root: FdfFrame, override: FdfOverride): void {
  for (const name of override.remove ?? []) dropFrame(root, name);
  for (const { frame, into } of override.add ?? []) {
    const target = findFrame(root, into);
    if (!target) continue;
    if (findFrame(root, frame)) continue; // already adopted (a re-applied override)
    const built = lib.resolveRoot(frame);
    if (built) target.children.push(built);
  }
}

/** Remove a named frame from wherever it sits in the tree, subtree and all. */
function dropFrame(root: FdfFrame, name: string): void {
  (function walk(f: FdfFrame): void {
    const at = f.children.findIndex((c) => c.name === name);
    if (at >= 0) f.children.splice(at, 1);
    f.children.forEach(walk);
  })(root);
}

/** The first frame in `f`'s subtree with this name. (A local copy of ui/mapBrowser.ts's, so
 *  the overrides layer does not depend on a screen module.) */
function findFrame(f: FdfFrame, name: string): FdfFrame | undefined {
  if (f.name === name) return f;
  for (const c of f.children) {
    const hit = findFrame(c, name);
    if (hit) return hit;
  }
  return undefined;
}
