import type { DataSource } from "../vfs/types";
import type { ChromeClips, PanelSide } from "../render/menuScene";
import {
  activeProfile, adoptOrphanedData, canCreateProfile, createProfile, deleteProfile,
  loadProfiles, MAX_PROFILE_NAME, selectProfile,
} from "../data/profiles";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { fadePanels } from "./fdf/anim";
import { showGlueDialog } from "./glueDialog";
import { adopt, findFrame, nudgeX, setProp } from "./mapBrowser";

// The Single Player menu (issues #61, #80), built from the game's own
// UI\FrameDef\Glue\SinglePlayerMenu.fdf. That file holds BOTH halves of the screen, as the
// original does, and this mounts both:
//
//   * `MainPanel` — the button column on the right (Campaign / Load Saved Game / View Replay /
//     Custom Campaign / Custom Game), the name of the profile in play above it, and the lens
//     button beside that name;
//   * `ProfilePanel` — "Single Player Profiles" on the left: the New Profile box with its
//     Create button, the Profile List, and Delete / Select under it;
//   * `CancelPanel` — Cancel, in its own frame at the bottom right.
//
// WHEN THE PROFILE HALF IS UP: when the lens is pressed, and whenever there are no profiles at
// all. With none it is the only thing on the right-hand side too — there is no profile to run a
// campaign under, so the button column is not there to be pressed, and the screen the player is
// stuck on is the one that gets them out of it. Cancel stays either way.
//
// --- THE CHROME ------------------------------------------------------------------------
//
// The two halves are TWO SEPARATE ENTRIES in the panel models' sequence table, not one, and
// they come and go independently. Measured by driving each of the 62 clips in
// TopLeftPanel-Expansion.mdx / TopRightPanel-Expansion.mdx on the live screen and looking at
// where every one of them parks its panel:
//
//   * LEFT, the profile panel: "RealmSelection Birth/Stand/Death". No "SinglePlayer" clip
//     moves the left panel at all — that side is empty for the whole triple — and
//     RealmSelection's is the only pose that matches the reference's "Single Player Profiles"
//     frame: a two-chain panel down the left third whose interior lands exactly on the box
//     this FDF puts its profile contents in (title at 0.02625/-0.109, Select at 0.207/-0.370).
//     The realm picker is the OTHER screen shaped like a name list with a Select under it, so
//     the two share a panel — the same reuse that puts the LAN screens on Battle.net's chrome.
//   * RIGHT, the button column: "SinglePlayer Birth/Stand/Death" — and the model carries a
//     HALF-arrival for it as well, "SinglePlayer Birth Alternate" / "…Death Alternate", which
//     land the column while leaving the Cancel panel exactly where it is. That is the pair for
//     the first profile being created and the last one being deleted, the only times the column
//     comes or goes without the rest of the screen. With no profiles the right side is on
//     "MainCancelPanel", whose pose is that Cancel panel alone.
//
// The DOM does not travel with any of it — it fades across the clip's own window, as every
// glue screen's contents do (ui/fdf/anim.ts).

/** The left panel's profile-half triple (see the chrome note above). */
const PROFILE_PANEL: ChromeClips = {
  birth: "RealmSelection Birth",
  stand: "RealmSelection Stand",
  death: "RealmSelection Death",
};

/** The right panel with the button column gone — the Cancel panel on its own. */
const CANCEL_ONLY: ChromeClips = {
  birth: "MainCancelPanel Birth",
  stand: "MainCancelPanel Stand",
  death: "MainCancelPanel Death",
};

/** The column arriving / leaving on its own, with the Cancel panel staying put. */
const COLUMN_ARRIVES = "SinglePlayer Birth Alternate";
const COLUMN_LEAVES = "SinglePlayer Death Alternate";

const LIST_FDF = "UI\\FrameDef\\Glue\\ListBoxWar3.fdf";

/**
 * How far right the profile name moves to sit inside the 3D bar that frames it.
 *
 * The same widescreen correction every glue screen's right-hand column needs (ui/mapBrowser.ts
 * `nudgeX`), only in the other direction. `ProfileNameText` is anchored to `CampaignBackdrop`'s
 * TOPLEFT, and that backdrop is a good deal wider on its left than the chrome slot it is drawn
 * in — so the name landed 5px LEFT of the bar's interior, printing over its border. Measured
 * against the live render: the bar's interior starts 0.045 in from the backdrop's left edge and
 * the FDF puts the name at 0.04, and the reference sets the name a further ~0.011 inside that.
 */
const NAME_NUDGE = 0.016;

/** Move one of the 3D chrome panels and say how long the clip runs — `MenuScene.sidePanel`,
 *  handed in so this screen never reaches into the renderer itself. */
export type MovePanel = (side: PanelSide, play: string, wearing: ChromeClips | null) => number;

/**
 * Which clips the screen ARRIVES on, for `GlueScreenDef.sides`. Read fresh each time: a player
 * who deletes their last profile and comes back must land on the create-one screen.
 */
export function singlePlayerSides(): Partial<Record<PanelSide, ChromeClips>> {
  return activeProfile() !== null
    ? {} // the screen's own "SinglePlayer" triple on the right, nothing on the left
    : { left: PROFILE_PANEL, right: CANCEL_ONLY };
}

export interface SinglePlayerHandlers {
  onCampaign?: () => void;
  onLoadSaved?: () => void;
  onViewReplay?: () => void;
  onCustomCampaign?: () => void;
  onCustomGame: () => void;
  onCancel: () => void;
  /** Drives the two sprite-layer panels as the halves open and close. Omitted in a headless
   *  mount — the DOM then simply appears and disappears. */
  movePanel?: MovePanel;
}

export function mountSinglePlayerMenu(
  container: HTMLElement,
  vfs: DataSource,
  h: SinglePlayerHandlers,
): Promise<FdfScreen> {
  const log = (name: string) => () => console.log(`[OpenWar3] single player: ${name}`);
  const move: MovePanel = h.movePanel ?? (() => 0);
  let lib: FdfLibrary | null = null;
  /** The screen, once built — and again after every resize rebuild. */
  let screen: FdfScreen | null = null;
  /** Is the profile half up? With no profile there is nothing else to be on. */
  let profilesUp = activeProfile() === null;
  /** …and is the button column? Tracked rather than re-derived from the profile state, because
   *  it outlives it by one animation: the last profile is gone the moment it is deleted and the
   *  column is still on screen sliding away. */
  let columnUp = activeProfile() !== null;
  /** Which row of the Profile List is picked — not the same thing as the profile IN PLAY. */
  let picked: string | null = activeProfile();
  /** Guards a toggle while the chrome is mid-flight, as GlueManager guards a screen change. */
  let moving = false;

  return mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\SinglePlayerMenu.fdf",
    rootFrame: "SinglePlayerMenu",
    includeFdf: [LIST_FDF],
    buildRoot: (l) => { lib = l; return buildSinglePlayerRoot(l); },
    // The chain panel is a widescreen-wide slot; the 4:3-authored buttons are widened to
    // fill it, exactly as the main menu does.
    buttonWidthScale: 1.35,
    // The screen's three panels, one per piece of chrome that carries them. Their contents
    // fade out and in as one when the screen changes (ui/fdf/anim.ts).
    panels: ["ProfilePanel", "MainPanel", "CancelPanel"],
    handlers: {
      CampaignButton: h.onCampaign ?? log("Campaign"),
      LoadSavedButton: h.onLoadSaved ?? log("Load Saved Game"),
      ViewReplayButton: h.onViewReplay ?? log("View Replay"),
      CustomCampaignButton: h.onCustomCampaign ?? log("Custom Campaign"),
      SkirmishButton: h.onCustomGame,
      CancelButton: h.onCancel,
      ProfileButton: () => toggleProfiles(),
      AddProfileButton: () => create(),
      DeleteProfileButton: () => confirmDelete(),
      SelectProfileButton: () => select(),
    },
    onBuild: (s) => wire(s),
  });

  // --- the screen, rebuilt on every resize -------------------------------------------
  //
  // A rebuild throws the DOM away, so everything below runs again against the new elements and
  // puts the state back (FdfScreenOptions.onBuild).

  function wire(s: FdfScreen): void {
    screen = s;

    const box = s.editBox("NewProfileEditBox");
    if (box) {
      // The FDF sets no EditTextLength; the cap is ours (data/profiles.ts MAX_PROFILE_NAME).
      const input = s.frame("NewProfileEditBox")?.querySelector("input");
      if (input) input.maxLength = MAX_PROFILE_NAME;
      box.onChange = () => refresh(s);
      box.onSubmit = () => create();
    }

    const list = s.list("ProfileList");
    if (list) {
      list.onChange = (v) => { picked = v; refresh(s); };
      list.onActivate = () => select(); // double-click a row is Select, as it is on the map list
    }

    refresh(s);
    // Whichever half is up stays up across a resize, and without an animation — the panel it
    // belongs to has not moved, only the window has.
    show(s.frame("ProfilePanel"), profilesUp);
  }

  /** Put the profiles, the selection and every enabled/disabled state back on the screen. */
  function refresh(s: FdfScreen): void {
    const profiles = loadProfiles();
    const active = activeProfile();
    if (picked && !profiles.some((p) => p.name === picked)) picked = active;

    const list = s.list("ProfileList");
    if (list) {
      const scroll = list.scrollTop;
      list.setItems(profiles.map((p) => ({ value: p.name, label: p.name })));
      if (picked) list.select(picked);
      list.scrollTop = scroll;
    }

    // The name above the button column is the profile IN PLAY, not the row under the cursor.
    s.setText("ProfileNameText", active ?? "");
    // No profile ⇒ no column: nothing on it can be pressed until there is one to press it as.
    show(s.frame("MainPanel"), columnUp);

    const typed = s.editBox("NewProfileEditBox")?.value ?? "";
    // Create is dead for an empty name (PROFILE_NEEDS_A_NAME) and for one already in the list —
    // which is what the reference shows, greyed, with a duplicate typed into the box.
    s.setEnabled("AddProfileButton", canCreateProfile(typed));
    s.setEnabled("DeleteProfileButton", picked !== null);
    // Selecting the profile already in play is a no-op, so it is offered only for another one.
    s.setEnabled("SelectProfileButton", picked !== null && picked !== active);
  }

  // --- the two halves coming and going ------------------------------------------------

  function show(el: HTMLElement | null, on: boolean): void {
    if (el) el.style.display = on ? "" : "none";
  }

  /** Show or hide the profile half: its chrome moves, its contents fade across that window. */
  async function setProfilesUp(up: boolean): Promise<void> {
    const s = screen;
    if (moving || up === profilesUp || !s) return;
    moving = true;
    profilesUp = up;
    const panel = s.frame("ProfilePanel");
    try {
      if (up) {
        const ms = move("left", PROFILE_PANEL.birth, PROFILE_PANEL);
        show(panel, true);
        if (panel) await fadePanels([panel], "in", ms);
      } else {
        const ms = move("left", PROFILE_PANEL.death, null);
        if (panel) await fadePanels([panel], "out", ms);
        show(panel, false);
      }
    } finally {
      moving = false;
    }
  }

  function toggleProfiles(): void {
    // With no profile the half is not dismissible — there is nothing to go back to.
    if (profilesUp && activeProfile() === null) return;
    void setProfilesUp(!profilesUp);
  }

  /** The button column arriving (the first profile) or leaving (the last one deleted). */
  async function setColumnUp(up: boolean): Promise<void> {
    if (up === columnUp) return;
    columnUp = up;
    const panel = screen?.frame("MainPanel");
    if (up) {
      const ms = move("right", COLUMN_ARRIVES, null);
      show(panel ?? null, true);
      if (panel) await fadePanels([panel], "in", ms);
    } else {
      const ms = move("right", COLUMN_LEAVES, CANCEL_ONLY);
      if (panel) await fadePanels([panel], "out", ms);
      show(panel ?? null, false);
    }
  }

  // --- the three buttons on the profile half -----------------------------------------

  function create(): void {
    const s = screen;
    const box = s?.editBox("NewProfileEditBox");
    if (!s || !box || !canCreateProfile(box.value)) return;
    const first = loadProfiles().length === 0;
    const name = createProfile(box.value);
    if (!name) return;
    // The very first profile inherits whatever was played before profiles existed, rather than
    // the player watching it vanish behind the screen that now insists on one (data/profiles.ts).
    if (first) adoptOrphanedData(name);
    box.value = "";
    picked = name;
    refresh(s);
    // …and the button column drops in beside the picker, which stays up with the new profile on it.
    if (first) void setColumnUp(true);
  }

  function select(): void {
    const s = screen;
    if (!s || !picked || picked === activeProfile()) return;
    selectProfile(picked);
    refresh(s);
    void setProfilesUp(false); // picking one is done with the picker
  }

  function confirmDelete(): void {
    const s = screen;
    const name = picked;
    if (!s || !name) return;
    // "Are you sure you want to delete the single-player profile '%s'?" — GlobalStrings.fdf's
    // DELETE_PROFILE_MESSAGE, with its own %s filled in, on the menus' own message box.
    const message = (lib?.string("DELETE_PROFILE_MESSAGE") ?? "Delete the profile '%s'?")
      .replace("%s", name);
    void showGlueDialog({
      container,
      vfs,
      text: message,
      buttons: "yesno",
      onConfirm: () => remove(name),
    });
  }

  function remove(name: string): void {
    const s = screen;
    if (!s) return;
    deleteProfile(name);
    picked = activeProfile();
    refresh(s);
    // The last one gone: the column leaves, and the picker (already up — Delete is on it) is
    // all that is left until another profile exists.
    if (activeProfile() === null) void setColumnUp(false);
  }
}

/** SinglePlayerMenu + the list box dropped into the empty container the FDF leaves for it —
 *  the same composition the engine does, and the Custom Campaign screen's own (ui/mapBrowser). */
function buildSinglePlayerRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("SinglePlayerMenu");
  if (!root) throw new Error("SinglePlayerMenu.fdf: no SinglePlayerMenu frame");

  const listBox = lib.resolveRoot("ListBoxWar3");
  if (listBox) {
    // Renamed on the way in: "ListBoxWar3" is a shared template and other screens mount their
    // own from the same file, so the list this screen asks for by name has to be its own.
    const profileList: FdfFrame = { ...listBox, name: "ProfileList" };
    setProp(profileList, "SetAllPoints", []); // fill the container the FDF already sized
    adopt(root, "ProfileListContainer", [profileList]);
  }

  nudgeX(findFrame(root, "ProfileNameText"), NAME_NUDGE);
  return root;
}
