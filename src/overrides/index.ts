import type { FdfFrame } from "../ui/fdf/parser";
import type { FdfLibrary } from "../ui/fdf/library";
import advancedOptionsFdf from "./ui/AdvancedOptionsPane.fdf?raw";
import advancedOptionsDisplayFdf from "./ui/AdvancedOptionsDisplay.fdf?raw";
import globalStringsFdf from "./ui/GlobalStrings.fdf?raw";
import gameChatroomFdf from "./ui/GameChatroom.fdf?raw";
import joinAddressDialogFdf from "./ui/JoinAddressDialog.fdf?raw";
import localMultiplayerCreateFdf from "./ui/LocalMultiplayerCreate.fdf?raw";
import localMultiplayerJoinFdf from "./ui/LocalMultiplayerJoin.fdf?raw";
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
   *
   * `only` narrows that to the named frames. A retired row is anchored to by exactly the row
   * under it, so the sweeping rewrite is right for it; a row SPLICED INTO the chain is not —
   * its anchor frame stays put and keeps its own label hanging off it, and only the row it
   * pushed down is to follow the new one.
   */
  readonly repoint?: ReadonlyArray<{ from: string; to: string; dx?: number; dy?: number; only?: readonly string[] }>;
  /**
   * Change the size of a frame the INSTALL declares — the one thing a name collision cannot do.
   *
   * `layer` wins a collision for frames the library RESOLVES BY NAME, which is how a template
   * or a root is replaced. A frame declared inline inside its parent is not looked up at all:
   * the tree already carries it, so a same-named declaration of ours is simply never consulted.
   * Discovered by restating `GameListContainer` twice and measuring no change either time.
   *
   * So a screen that has to give one of its own frames some room says so here, and the edit is
   * made on the resolved tree like `repoint`'s. Sizes only: an anchor is `repoint`'s business,
   * and a frame that needs to MOVE is usually a frame that should be re-anchored instead.
   */
  readonly resize?: ReadonlyArray<{ frame: string; width?: number; height?: number }>;
}

/** Strings the game has no key for. Layered by both screens below — a screen's own override
 *  carries frames, and the labels those frames name live in one place. */
export const OW3_STRINGS: FdfOverride = { id: "ow3-strings", source: globalStringsFdf };

/**
 * Options → Gameplay: out with the Game Port and the Chat Support gateway, in with the
 * Computer+ default (issue #124) and the "Healthbars:" pulldown (issue #141).
 *
 * The four retired frames are the label/control pairs of two settings this engine has no
 * meaning for; nothing else in the panel anchors to any of them, so the panel just ends a row
 * earlier. See `ui/OptionsMenu.fdf` for the reasons.
 */
export const OPTIONS_MENU_OVERRIDE: FdfOverride = {
  id: "ow3-options-menu",
  source: optionsMenuFdf,
  remove: ["GamePortLabel", "GamePortEditBox", "ChatSupportLabel", "ChatSupportBackdrop"],
  // The "Healthbars:" pulldown is SPLICED IN under "Always show Health Bars" (issue #141), so
  // the row beneath it — and only that row — re-anchors to the new one. `HealthBarsLabel`
  // hangs off the same checkbox and must not move, which is what `only` is for.
  //
  // The dy is the pulldown's overhang. Its backdrop is 0.053 tall and centred on a
  // 0.013-tall label (ui/fdf/layout.ts `textBoxHeight`: a one-line TEXT frame is exactly its
  // font size), so it reaches 0.053 / 2 − 0.013 / 2 = 0.020 below the label's own bottom edge;
  // the −0.005 the checkbox already carried is then the gap under the pulldown.
  repoint: [
    { from: "HealthBarsCheckBox", to: "HealthBarStyleLabel", dy: -0.02, only: ["AutosaveReplayCheckBox"] },
  ],
  add: [
    { frame: "HealthBarStyleLabel", into: "GameplayPanel" },
    { frame: "HealthBarStyleBackdrop", into: "GameplayPanel" },
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
 * LAN → Create Game → Advanced Options: ONE row of ours, and the game's "Observers:" row kept.
 *
 * The same pane as the Custom Game screen's, out of the same override file, with the one
 * difference that decides which of the two manifests a screen layers: on a HOSTED game the
 * Observers dropdown is exactly what it says — how other people may watch — so it stays, and
 * only "Computer+ (Improved AI)" is added under the visibility row (issue #124). Nothing is
 * retired, so nothing has to be re-anchored.
 */
export const LAN_ADVANCED_OPTIONS_OVERRIDE: FdfOverride = {
  id: "ow3-lan-advanced-options",
  source: advancedOptionsFdf,
  add: [
    { frame: "ComputerPlusLabel", into: "AdvancedOptionsPane" },
    { frame: "ComputerPlusCheckBox", into: "AdvancedOptionsPane" },
  ],
};

/**
 * The LAN game list: one line saying whether other machines can reach this one, and the Servers
 * List button that opens the set of machines we are watching.
 *
 * Nothing is retired and nothing moves — both frames go into empty space the screen already has,
 * so no anchor chain is touched and there is no `repoint`. See `ui/LocalMultiplayerJoin.fdf` for
 * why the status line cannot simply be more text on the line above it.
 */
export const LAN_JOIN_OVERRIDE: FdfOverride = {
  id: "ow3-lan-join",
  source: localMultiplayerJoinFdf,
  // The list gives up 0.055 of its height so the button has a band to sit in under it. See the
  // FDF for the places it does not fit, and `resize` for why this is not a collision.
  resize: [{ frame: "GameListContainer", height: 0.22 }],
  // Both buttons move right in the panel. Only CREATE GAME is named: it is the install's own
  // frame, anchored to the screen's bottom-left corner, and Servers List hangs off it — so one
  // dx carries the pair and they cannot come apart. `from` and `to` are the same frame, which
  // makes this a pure offset rather than a re-anchoring; `only` keeps it off everything else
  // that measures from that corner (the panel's title, its info line, our status text).
  repoint: [{ from: "LocalMultiplayerJoin", to: "LocalMultiplayerJoin", dx: 0.045, only: ["CreateBackdrop"] }],
  add: [
    { frame: "NetworkStatusText", into: "LocalMultiplayerJoin" },
    { frame: "ServersListBackdrop", into: "GameListPanel" },
  ],
};

/**
 * LAN → Create Game: the Server row — which relay the game is announced on (this computer, the
 * OpenWar3 server, or another server the Servers List watches).
 *
 * Nothing is retired and nothing is re-anchored: both frames hang under the map list, in the
 * settings panel that already holds it. See `ui/LocalMultiplayerCreate.fdf`.
 */
export const LAN_CREATE_OVERRIDE: FdfOverride = {
  id: "ow3-lan-create",
  source: localMultiplayerCreateFdf,
  // The list gives up 0.03 of its 0.29 so the row lands INSIDE the panel: measured in the
  // running screen, the unshortened list put the dropdown straight across the panel's bottom
  // border. Two rows of a list that holds a folder's worth of maps; the same trade, and the same
  // `resize` rather than a collision, as the LAN game list's (LAN_JOIN_OVERRIDE).
  resize: [{ frame: "MapListContainer", height: 0.26 }],
  add: [
    { frame: "HostServerLabel", into: "GameSettingsPanel" },
    { frame: "HostServerMenu", into: "GameSettingsPanel" },
  ],
};

/**
 * OpenWar3's own dialog: the relay addresses this machine watches for games.
 *
 * Not a layer over anything — the install has no FrameDef for it, so the whole frame is ours
 * (`ui/JoinAddressDialog.fdf`, built from the game's templates and art) and it is mounted as a
 * root in its own right rather than adopted into somebody else's screen. It is layered onto
 * `DialogWar3.fdf` purely to be in a library that has the glue templates loaded.
 */
export const JOIN_ADDRESS_DIALOG_OVERRIDE: FdfOverride = {
  id: "ow3-join-address-dialog",
  source: joinAddressDialogFdf,
};

/**
 * The game lobby: the address other players type to reach this game.
 *
 * The other half of the LAN screen's join field — see `ui/GameChatroom.fdf` for why a game
 * needs to be able to state its own address at all, and why the row copies itself rather than
 * growing a button. The row lives in the empty band BETWEEN the two panels at the bottom of
 * the screen, and the chat entry box above it lifts clear of its own panel border.
 */
export const LAN_LOBBY_ADDRESS_OVERRIDE: FdfOverride = {
  id: "ow3-lan-lobby-address",
  source: gameChatroomFdf,
  add: [
    // Into the ROOT, because the band it sits in belongs to neither panel — see the FDF.
    { frame: "JoinAddressLobbyLabel", into: "GameChatroom" },
    { frame: "JoinAddressLobbyValue", into: "GameChatroom" },
  ],
  // The chat entry box lifts clear of the panel's bottom border. It is the install's own frame,
  // anchored under the chat log, so the override nudges that anchor rather than restating it —
  // `only` keeps the nudge off everything else measuring from the same frame.
  repoint: [{ from: "ChatTextArea", to: "ChatTextArea", dy: 0.018, only: ["ChatEditBox"] }],
};

/**
 * The game lobby's Advanced Options SUMMARY (`AdvancedOptionsDisplay.fdf`, under the map on
 * GameChatroom): the Computer+ row, so a joiner reads which AI the match uses alongside the
 * seven rows the game prints. See `ui/AdvancedOptionsDisplay.fdf`.
 */
export const ADVANCED_OPTIONS_DISPLAY_OVERRIDE: FdfOverride = {
  id: "ow3-advanced-options-display",
  source: advancedOptionsDisplayFdf,
  add: [{ frame: "ComputerPlusDisplayLabel", into: "AdvancedOptionsDisplay" }],
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
  for (const r of override.resize ?? []) {
    const f = findFrame(root, r.frame);
    if (!f) continue;
    if (r.width !== undefined) setSize(f, "Width", r.width);
    if (r.height !== undefined) setSize(f, "Height", r.height);
  }
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
function repoint(root: FdfFrame, r: { from: string; to: string; dx?: number; dy?: number; only?: readonly string[] }): void {
  const dx = r.dx ?? 0;
  const dy = r.dy ?? 0;
  (function walk(f: FdfFrame): void {
    if (r.only && !r.only.includes(f.name)) { f.children.forEach(walk); return; }
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

/** Write a Width/Height onto a resolved frame, replacing whatever it declared. */
function setSize(f: FdfFrame, key: "Width" | "Height", value: number): void {
  const prop = f.props.find((p) => p.key === key);
  // `args` is readonly on the prop, so the ARRAY is rewritten in place — the same way `repoint`
  // edits an existing point rather than replacing the property.
  if (prop) (prop.args as Array<{ s: string; n: number | null; str: boolean }>).splice(0, prop.args.length, numArg(value));
  else f.props.push({ key, args: [numArg(value)] });
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
