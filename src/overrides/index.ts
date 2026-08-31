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
  /**
   * SetPoint targets to REDIRECT, before anything is removed.
   *
   * A retired row is rarely the last one on a panel, and an FDF panel is a CHAIN: every row
   * anchors to the row above it by name. Drop the Observers row and `MapVisibilityLabel` is
   * left anchored to a frame that no longer exists — which the layout solver reads as
   * "anchored to my parent" and lands at the top of the pane, taking every row below it along.
   *
   * So a replacement row hands its anchors on: each entry rewrites every `SetPoint …, "from",
   * …` in the tree to name `to` instead, and `dx`/`dy` are ADDED to that point's own offsets
   * for what the swap changed about the anchor's box (a dropdown's right edge does not sit
   * where a checkbox's does).
   */
  readonly repoint?: ReadonlyArray<{ from: string; to: string; dx?: number; dy?: number }>;
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

/**
 * Custom Game → Advanced Options: two rows of ours.
 *
 * "Computer+ (Improved AI)" is added at the bottom of the pane, where issue #124 asks for it.
 * "Observer Mode" REPLACES the game's "Observers:" dropdown in place — that row picks how
 * other PEOPLE may watch a hosted game and has nothing to say on a single-player screen, where
 * it stood greyed at "No Observers"; ours is the one form of watching this screen can offer.
 * See `ui/AdvancedOptionsPane.fdf` for the reasons and src/ui/fdfSkirmish.ts for the switch.
 *
 * The dropdown was the anchor of the visibility row under it, so its anchors are handed to the
 * checkbox that takes its place — with the 0.005 the FDF insets a POPUPMENU's right edge by
 * and a checkbox's not, or the visibility menu (and the Computer+ box hanging off it) would
 * step 0.005 out of the column.
 */
export const ADVANCED_OPTIONS_OVERRIDE: FdfOverride = {
  id: "ow3-advanced-options",
  source: advancedOptionsFdf,
  repoint: [
    { from: "ObserversLabel", to: "ObserverModeLabel" },
    { from: "ObserversMenu", to: "ObserverModeCheckBox", dx: 0.005 },
  ],
  remove: ["ObserversLabel", "ObserversMenu"],
  add: [
    { frame: "ObserverModeLabel", into: "AdvancedOptionsPane" },
    { frame: "ObserverModeCheckBox", into: "AdvancedOptionsPane" },
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
  // Before the removals, or the anchors we are redirecting would already be dangling.
  for (const r of override.repoint ?? []) repoint(root, r);
  for (const name of override.remove ?? []) dropFrame(root, name);
  for (const { frame, into } of override.add ?? []) {
    const target = findFrame(root, into);
    if (!target) continue;
    if (findFrame(root, frame)) continue; // already adopted (a re-applied override)
    const built = lib.resolveRoot(frame);
    if (built) target.children.push(built);
  }
}

/**
 * Point every `SetPoint` that names `from` at `to` instead, shifting its offsets by dx/dy.
 *
 * The statement is `SetPoint <myPoint>, "<relFrame>", <relPoint>, <dx>, <dy>` with the last
 * three parts optional, so the offsets are found the way ui/fdf/layout.ts's `readPoints` finds
 * them: step past the relative frame's name and its point, and what is left is the pair. A
 * point that stated no offsets grows them, since it is being moved off a different box.
 */
function repoint(root: FdfFrame, r: { from: string; to: string; dx?: number; dy?: number }): void {
  const dx = r.dx ?? 0;
  const dy = r.dy ?? 0;
  (function walk(f: FdfFrame): void {
    for (const p of f.props) {
      if (p.key !== "SetPoint") continue;
      const at = p.args.findIndex((a) => a.str && a.s === r.from);
      if (at < 0) continue;
      p.args[at] = { s: r.to, n: null, str: true };
      if (!dx && !dy) continue;
      // The relative POINT is optional (it defaults to my own), so the offsets start at
      // whichever of the next two slots is not one.
      let i = at + 1;
      if (p.args[i] && p.args[i].n === null && !p.args[i].str) i++;
      p.args[i] = numArg((p.args[i]?.n ?? 0) + dx);
      p.args[i + 1] = numArg((p.args[i + 1]?.n ?? 0) + dy);
    }
    f.children.forEach(walk);
  })(root);
}

/** A numeric FDF argument, as the parser would have produced it. */
function numArg(v: number): { s: string; n: number; str: boolean } {
  return { s: String(v), n: v, str: false };
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
