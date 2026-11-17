// The F10 Game Menu, built from the game's own `UI\FrameDef\UI\EscMenuMainPanel.fdf`.
//
// The file is not one screen but FIVE, stacked at the same place and shown one at a time —
// which is why every one of them anchors its contents to `EscMenuMainPanel` (the dialog
// area) rather than to itself:
//
//     Frame "FRAME" "EscMenuMainPanel" {  SetAllPoints,
//         Frame "FRAME" "MainPanel"        { Width 0.288, Height 0.384, … }
//         Frame "FRAME" "EndGamePanel"     { Width 0.288, Height 0.384, … }
//         Frame "FRAME" "ConfirmQuitPanel" { Width 0.336, Height 0.192, … }
//         Frame "FRAME" "HelpPanel"        { Width 0.432, Height 0.384, … }
//         Frame "FRAME" "TipsPanel"        { Width 0.432, Height 0.284, … } }
//
// and why the stone frame behind them is declared OUTSIDE all five, with a comment in the
// shipped file saying so ("the following frames are created within the escmenu itself"):
// there is one backdrop and it is resized to whichever panel is up. So we synthesize the
// root the engine builds — a frame named `EscMenuMainPanel`, sized to the ACTIVE panel,
// holding `EscMenuBackdrop` stretched over it plus that panel's own children — and rebuild
// it when the panel changes. Every button, offset, font, hotkey and caption below is the
// file's; the only thing this module adds is which button does what.
//
// The captions are `GlobalStrings.fdf` keys, so a localized install says what it says, and
// the hotkey letters come with them ("Pause Ga|Cffffffffm|Re" — the M is the accelerator,
// and `ControlShortcutKey "M"` in the FDF is what binds it).
//
// Restart is DISABLED, not hidden: WC3 greys what can't be used and the FDF ships the greyed
// face for exactly that (ControlDisabledBackdrop). Save Game and Load Game (issue #159,
// docs/save-games.md) open FOUR more panels on the same stack, out of the game's own
// `UI\FrameDef\UI\EscMenuSaveGamePanel.fdf`: one file that is the Save panel and the Load panel
// at once (its `SaveOnly` / `LoadOnly` halves over a shared `SaveAndLoad` file list) plus the two
// questions Save asks — `OverwriteOnly` and `DeleteOnly`. Save is greyed where the match cannot
// be saved (`EscMenuActions.saveRefusal` — a multiplayer game, a replay).
//
// OPTIONS is four more panels on the same stack, and they are in another file — the game's own
// `UI\FrameDef\UI\EscMenuOptionsPanel.fdf`, loaded into this screen's library beside the main
// one (`includeFdf`) exactly as the engine has both in scope at once. Its panels anchor to a
// root called `EscMenuOptionsPanel` rather than to `EscMenuMainPanel`, so the root this file
// synthesizes takes the name the active panel expects. What those panels' controls DO is
// ui/escOptions.ts's; the stack, the chrome and the buttons are here.

import { loadHelpText, loadTips } from "../data/uiStrings";
import type { DataSource } from "../vfs/types";
import type { SoundBoard } from "../audio/sounds";
import type { Arg, FdfFrame, FdfProp } from "./fdf/parser";
import { numProp, type FdfLibrary } from "./fdf/library";
import { mountFdfScreen, playFdfClick, type FdfScreen } from "./fdf/render";
import { ESC_OPTIONS_OVERRIDE, ESC_TEMPLATES_OVERRIDE, OW3_STRINGS } from "../overrides";
import { EscOptions } from "./escOptions";
import { DEFAULT_GAME_SPEED, type GameSpeed } from "../data/gameSpeed";
import { gamepadButtonPressed } from "./gamepad";
import { voiceDownloadPressed } from "./voiceOptions";
import { adopt, findFrame, setProp } from "./mapBrowser";
import type { ListItem } from "./fdf/widgets";
import { SAVE_EXT, type SaveSink } from "../game/save/saveSink";

const ESC_MENU_FDF = "UI\\FrameDef\\UI\\EscMenuMainPanel.fdf";
const ESC_OPTIONS_FDF = "UI\\FrameDef\\UI\\EscMenuOptionsPanel.fdf";
const ESC_SAVE_FDF = "UI\\FrameDef\\UI\\EscMenuSaveGamePanel.fdf";
const LIST_FDF = "UI\\FrameDef\\Glue\\ListBoxWar3.fdf";

/** Which of the two files' nine panels is up. */
type PanelId = "main" | "endgame" | "confirmquit" | "help" | "tips" | "options" | "optgameplay" | "optvideo" | "optsound" | SavePanel;

/** The four faces of `EscMenuSaveGamePanel.fdf` (see the header). */
type SavePanel = "save" | "load" | "overwrite" | "delete";

/** Each save face: the container that sizes it and the frames of the file it shows. */
const SAVE_PANELS: Record<SavePanel, { container: string; parts: string[] }> = {
  save: { container: "EscMenuSaveLoadContainer", parts: ["SaveAndLoad", "SaveOnly"] },
  load: { container: "EscMenuSaveLoadContainer", parts: ["SaveAndLoad", "LoadOnly"] },
  overwrite: { container: "EscMenuOverwriteContainer", parts: ["OverwriteOnly"] },
  delete: { container: "EscMenuDeleteContainer", parts: ["DeleteOnly"] },
};
const isSavePanel = (p: PanelId): p is SavePanel => p in SAVE_PANELS;

const PANEL_FRAME: Record<PanelId, string> = {
  main: "MainPanel",
  endgame: "EndGamePanel",
  confirmquit: "ConfirmQuitPanel",
  help: "HelpPanel",
  tips: "TipsPanel",
  options: "OptionsPanel",
  optgameplay: "GameplayPanel",
  optvideo: "VideoPanel",
  optsound: "SoundPanel",
  save: "EscMenuSaveGamePanel",
  load: "EscMenuSaveGamePanel",
  overwrite: "EscMenuSaveGamePanel",
  delete: "EscMenuSaveGamePanel",
};

/** The four panels that come out of `EscMenuOptionsPanel.fdf`, and which of the three settings
 *  panels each of the last three is (ui/escOptions.ts binds by that). */
const OPTIONS_PANELS: Partial<Record<PanelId, "gameplay" | "video" | "sound" | null>> = {
  options: null,
  optgameplay: "gameplay",
  optvideo: "video",
  optsound: "sound",
};

/**
 * The size of the Options panel — the ONE thing about it that is not in the file.
 *
 * `EscMenuMainPanel.fdf` gives each of its five panels a Width and a Height; the options file
 * gives its four none at all, because in the engine they are laid inside a frame the game sizes
 * for them. The file still says what that size is, twice over: the OK/Cancel row is inset
 * 0.028125 from the left and is 0.112 + 0.00625 + 0.112 wide, which comes to 0.286625 plus the
 * same inset on the right — and `EscMenuBackdrop`, the shared stone frame, declares exactly the
 * 0.288 x 0.384 that MainPanel does. The tallest of the four (Gameplay) ends 0.007 above the OK
 * button at that height, so it is the size the panels were authored against.
 */
const OPTIONS_PANEL_SIZE = { width: 0.288, height: 0.384 };

/**
 * …and how much TALLER the Gameplay one is than that. Ours: the 2003 panel's rows filled it to
 * the OK button, and OpenWar3's Gameplay panel carries one more than it ever did — the Voice
 * Control row (src/voice/), which with "Detect Gamepad" in the band above OK/Cancel has nowhere
 * left to stand. One checkbox step (0.024 box + the panel's 0.00375 tuck, rounded up to 0.03 so
 * the band keeps its own clearance). The stone frame is a nine-slice and stretches; the other
 * three panels keep the authored height.
 */
const GAMEPLAY_PANEL_EXTRA = 0.03;

const num = (v: number): Arg => ({ s: String(v), n: v, str: false });
const prop = (key: string, ...args: Arg[]): FdfProp => ({ key, args });

export interface EscMenuActions {
  /** Close the menu and resume (the Return to Game button, and Escape). */
  onReturn(): void;
  /** Leave the match for the main menu — Quit Mission, and the End Game button's point. */
  onEndGame(): void;
  /** Exit Program, once confirmed: close the GAME, not just the match. Absent falls back to
   *  `onEndGame`, which is also what a page that cannot close itself should do. */
  onExitProgram?(): void;
  /** Pause Game / Resume Game: close the menu and TOGGLE the match's own pause — the one
   *  button on the panel that does not simply put the world back the way it found it. */
  onPause?(): void;
  /** Is the match stopped by a PLAYER right now (as opposed to merely by this menu being
   *  open)? Decides which of the file's two captions the button wears. Absent reads as
   *  "never paused", which is what a screen with no pause to offer wants. */
  isPaused?(): boolean;
  /** Is there a Pause Game button at all? A PLAYER's pause is a MULTIPLAYER feature — it
   *  exists to stop the clock for the other people on it (timeouts, the "%s paused the game"
   *  notice) — so in a single-player game (`bj_isSinglePlayer`: one human seat — a campaign,
   *  a skirmish, a custom game) the button is not on the panel at all. Opening this menu
   *  already stops a single-player world (docs/pause.md). Absent reads as "yes". */
  canPause?(): boolean;
  /** The live SoundBoard, so the Options screen's Sound panel is audible as it is dragged. */
  sounds?(): SoundBoard | null;
  /** The match's game speed, and whether it is LOCKED — every multiplayer game is, because the
   *  host picked it for every machine (src/data/gameSpeed.ts). Absent reads as Fast, locked. */
  gameSpeed?(): { speed: GameSpeed; locked: boolean };
  /** Change the speed of a single-player match, live (Gameplay panel's slider). */
  setGameSpeed?(speed: GameSpeed): void;
  /** SAVED GAMES (issue #159): where they are kept. Absent greys Save Game and Load Game. */
  saves?(): SaveSink | null;
  /** Why this match cannot be saved right now, or null — Save Game is greyed while it says. */
  saveRefusal?(): string | null;
  /** The name the Save panel offers (the map's and the time — two saves never land on one). */
  suggestedSaveName?(): string;
  /** Save the match under a name. Resolves when it is on disk; rejects with why it is not. */
  onSaveGame?(name: string): Promise<void>;
  /** Load the named save — the match on screen ends and that one takes its place. */
  onLoadGame?(name: string): void;
}

export class EscMenu {
  private screen: FdfScreen | null = null;
  private scrim: HTMLElement | null = null;
  private panel: PanelId = "main";
  private shown = false;
  private mounting = false;
  private help: string[] = [];
  private tips: string[] = [];
  private tip = 0;
  private lib: FdfLibrary | null = null;
  private readonly options: EscOptions;
  private onEscape: (e: KeyboardEvent) => void;
  /** The Save/Load panels' state: the saves on disk, the name in the box, a write under way. */
  private saveFiles: string[] = [];
  private saveName = "";
  private saving = false;

  /** `skin` is the war3skins.txt section the chrome is decorated from — WC3 gives the
   *  in-game panels the LOCAL player's race, so an Orc player's menu is Orc-bordered. */
  constructor(
    private container: HTMLElement,
    private vfs: DataSource,
    private skin: string,
    private actions: EscMenuActions,
  ) {
    this.options = new EscOptions({
      sounds: () => this.actions.sounds?.() ?? null,
      gameSpeed: () => this.actions.gameSpeed?.() ?? { speed: DEFAULT_GAME_SPEED, locked: true },
      setGameSpeed: (speed) => this.actions.setGameSpeed?.(speed),
      // Where Voice Control's download dialog goes up when it is asked for mid-match.
      dialogDoor: () => ({ container: this.container, vfs: this.vfs }),
    });
    // Escape closes the menu, captured ahead of the HUD's own Escape handler. From a
    // sub-panel it steps BACK one level instead — the same thing its Previous Menu /
    // Cancel button does, and what the reference does with the key.
    this.onEscape = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !this.shown) return;
      e.preventDefault();
      e.stopPropagation();
      // Whichever button this key is standing in for — Return to Game on the main panel,
      // Previous Menu / Cancel on a sub-panel — it makes that button's sound.
      playFdfClick();
      if (this.panel === "main") this.actions.onReturn();
      else this.go(this.stepBack());
    };
  }

  /** Which panel a Previous Menu / Cancel — or the Escape key standing in for one — goes back
   *  to from here. One level up the stack, every time. */
  private stepBack(): PanelId {
    if (this.panel === "confirmquit") return "endgame";
    if (this.panel === "overwrite" || this.panel === "delete") return "save";
    if (this.panel in OPTIONS_PANELS) {
      // Escape on a settings panel is its CANCEL button, so it undoes the visit exactly as the
      // button does — anything applied live along the way included.
      if (this.panel !== "options") {
        this.options.cancel();
        return "options";
      }
    }
    return "main";
  }

  get visible(): boolean {
    return this.shown;
  }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.panel = "main";
    // A setting changed from the glue Options screen since the last visit is what these panels
    // should show, so the store is re-read rather than remembered from last time.
    this.options.reload();
    document.body.classList.add("game-menu-open"); // HUD hotkeys check this and stand down
    window.addEventListener("keydown", this.onEscape, true);
    void this.build();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    document.body.classList.remove("game-menu-open");
    window.removeEventListener("keydown", this.onEscape, true);
    this.teardown();
  }

  /** Flip visibility; returns the new visible state. */
  toggle(): boolean {
    if (this.shown) this.hide();
    else this.show();
    return this.shown;
  }

  dispose(): void {
    this.hide();
    this.teardown();
  }

  private teardown(): void {
    this.screen?.dispose();
    this.screen = null;
    this.scrim?.remove();
    this.scrim = null;
  }

  /** Switch panels — a full rebuild, because the backdrop is sized to the panel. */
  private go(panel: PanelId): void {
    this.panel = panel;
    void this.build();
  }

  private async build(): Promise<void> {
    if (this.mounting) return;
    this.mounting = true;
    try {
      // The prose pages are read once, on the first panel that needs them.
      if (this.panel === "help" && !this.help.length) this.help = await loadHelpText(this.vfs);
      if (this.panel === "tips" && !this.tips.length) this.tips = await loadTips(this.vfs);
      if (!this.shown) return; // closed while we were reading

      // The SCRIM first, and the panel mounted INSIDE it — not beside it. `modalOver` (ui/modal.ts)
      // is the one answer to "is a modal over this screen", and what it asks is whether a scrim
      // CONTAINS the screen: a panel that is its scrim's sibling is read as having a modal over
      // itself and stands its own keyboard down, which is exactly what killed every accelerator on
      // this panel — Pause Game's M, Help's H, Quit Mission's Q (issue #147). Modal, as in the
      // game: the world behind must not take the click that missed a button. The scrim is
      // invisible — WC3 does not dim the map under the Esc menu.
      if (!this.scrim) {
        this.scrim = document.createElement("div");
        this.scrim.className = "fdf-dialog-scrim";
        this.container.appendChild(this.scrim);
      }
      const prev = this.screen;
      const screen = await mountFdfScreen({
        container: this.scrim,
        vfs: this.vfs,
        fdfPath: ESC_MENU_FDF,
        // The Options panels are four more faces of this same screen, and they are in the
        // game's other in-game FrameDef file — so it is loaded into the same library, which is
        // also what puts `EscMenuTemplates.fdf` in scope for both. The Save/Load faces are a
        // third file, with the glue's own list box laid into its empty `FileListFrame`.
        includeFdf: [ESC_OPTIONS_FDF, ESC_SAVE_FDF, LIST_FDF],
        rootFrame: "EscMenuMainPanel",
        overlayClass: "fdf-ingame fdf-dialog",
        skin: this.skin,
        centerRoot: true,
        overrides: [OW3_STRINGS, ESC_TEMPLATES_OVERRIDE, ESC_OPTIONS_OVERRIDE],
        buildRoot: (lib) => this.rootFrame(lib),
        handlers: this.handlers(),
        onBuild: (built) => this.onBuild(built),
      });
      // Closed while we were mounting? Then this panel is already gone as far as everything
      // else is concerned, and showing it now would strand it on screen with nothing left to
      // close it. Mounting an FDF screen is ASYNC (it reads and decodes the panel's BLPs), so
      // the window is real: a cinematic that starts on the frame after the player hit F10
      // hides the menu, and the mount lands afterwards. (Same guard in the other three
      // panels — see mapViewer.closePanels.)
      if (!this.shown) {
        screen.dispose();
        return;
      }
      prev?.dispose();
      this.screen = screen;
    } catch (err) {
      console.warn("[escmenu] could not mount the FDF panel:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
    }
  }

  /**
   * The root the engine builds: a frame named `EscMenuMainPanel` — the name every panel's
   * contents anchor to — sized to the ACTIVE panel, wearing the shared `EscMenuBackdrop`.
   *
   * The backdrop's own Width/Height are dropped: it declares MainPanel's 0.288 × 0.384, but
   * it is the frame that stretches to fit whichever panel is up (ConfirmQuit is wider and
   * half as tall), and SetAllPoints is how the engine does that.
   */
  private rootFrame(lib: FdfLibrary): FdfFrame {
    this.lib = lib; // captured so the Options panels' readouts resolve through GlobalStrings
    if (this.panel in OPTIONS_PANELS) return this.optionsRoot(lib);
    if (isSavePanel(this.panel)) return this.saveRoot(lib, this.panel);
    const panel = lib.resolveRoot(PANEL_FRAME[this.panel]);
    const backdrop = lib.resolveRoot("EscMenuBackdrop");
    if (!panel) throw new Error(`FDF: frame "${PANEL_FRAME[this.panel]}" not found`);

    const children: FdfFrame[] = [];
    if (backdrop) {
      children.push({
        ...backdrop,
        props: [
          ...backdrop.props.filter((p) => p.key !== "Width" && p.key !== "Height"),
          prop("SetAllPoints"),
        ],
      });
    }
    const noPause = this.panel === "main" && this.actions.canPause?.() === false ? dropPause(panel) : null;
    children.push(...(noPause?.children ?? panel.children).map((c) => this.captionPause(c)));

    return {
      type: "FRAME",
      name: "EscMenuMainPanel",
      inherits: null,
      withChildren: false,
      props: [
        prop("Width", num(numProp(panel, "Width") ?? 0.288)),
        prop("Height", num((numProp(panel, "Height") ?? 0.384) - (noPause?.shrink ?? 0))),
      ],
      children,
    };
  }

  /**
   * The same root, for the four panels of `EscMenuOptionsPanel.fdf`.
   *
   * Three things make it its own function rather than a branch of `rootFrame`. The root has to
   * be NAMED `EscMenuOptionsPanel`, because that is the frame every control in that file
   * anchors to. Its size is not in the file (see `OPTIONS_PANEL_SIZE`). And the panel frame is
   * kept as a CHILD, stretched over the root, rather than having its children hoisted the way
   * the main file's are: `GameplayPanel` is what our own override hangs its two extra rows
   * inside (`add: { into: "GameplayPanel" }`), so the container has to still be there when the
   * override edits the built tree.
   *
   * The three settings panels also take `BottomButtonPanel` — the file's OK / Cancel row, which
   * is declared outside all four panels because it belongs to whichever one is up, exactly as
   * the backdrop is.
   */
  private optionsRoot(lib: FdfLibrary): FdfFrame {
    const panel = lib.resolveRoot(PANEL_FRAME[this.panel]);
    const backdrop = lib.resolveRoot("EscMenuBackdrop");
    if (!panel) throw new Error(`FDF: frame "${PANEL_FRAME[this.panel]}" not found`);

    const stretch = (f: FdfFrame): FdfFrame => ({
      ...f,
      props: [...f.props.filter((p) => p.key !== "Width" && p.key !== "Height"), prop("SetAllPoints")],
    });

    const children: FdfFrame[] = [];
    if (backdrop) children.push(stretch(backdrop));
    children.push(stretch(panel));
    if (this.panel !== "options") {
      const buttons = lib.resolveRoot("BottomButtonPanel");
      if (buttons) children.push(stretch(buttons));
    }

    return {
      type: "FRAME",
      name: "EscMenuOptionsPanel",
      inherits: null,
      withChildren: false,
      props: [
        prop("Width", num(OPTIONS_PANEL_SIZE.width)),
        prop("Height", num(OPTIONS_PANEL_SIZE.height + (this.panel === "optgameplay" ? GAMEPLAY_PANEL_EXTRA : 0))),
      ],
      children,
    };
  }

  /**
   * The root for a face of `EscMenuSaveGamePanel.fdf` — named `EscMenuSaveGamePanel`, which is
   * what every control in that file anchors to, sized by the face's own container (0.432 × 0.288
   * for Save and Load, 0.336 × 0.192 for the two questions) and wearing the shared stone frame.
   * The file's `FileListFrame` is an EMPTY box the engine fills, so the game's own list box
   * (`ListBoxWar3`) goes into it, as every file list in the glue does.
   */
  private saveRoot(lib: FdfLibrary, which: SavePanel): FdfFrame {
    const file = lib.resolveRoot("EscMenuSaveGamePanel");
    const backdrop = lib.resolveRoot("EscMenuBackdrop");
    if (!file) throw new Error("FDF: frame \"EscMenuSaveGamePanel\" not found");
    const spec = SAVE_PANELS[which];
    const box = findFrame(file, spec.container);
    const children: FdfFrame[] = [];
    if (backdrop) {
      children.push({ ...backdrop, props: [...backdrop.props.filter((p) => p.key !== "Width" && p.key !== "Height"), prop("SetAllPoints")] });
    }
    for (const part of spec.parts) {
      const f = box ? findFrame(box, part) : undefined;
      if (!f) continue;
      const copy: FdfFrame = structuredClone(f);
      if (part === "SaveAndLoad") {
        const listBox = lib.resolveRoot("ListBoxWar3");
        if (listBox) {
          const list: FdfFrame = { ...structuredClone(listBox), name: "SaveGameList" };
          setProp(list, "SetAllPoints", []);
          adopt(copy, "FileListFrame", [list]);
        }
      }
      children.push(copy);
    }
    return {
      type: "FRAME",
      name: "EscMenuSaveGamePanel",
      inherits: null,
      withChildren: false,
      props: [
        prop("Width", num((box && numProp(box, "Width")) ?? 0.432)),
        prop("Height", num((box && numProp(box, "Height")) ?? 0.288)),
      ],
      children,
    };
  }

  /** The Save/Load face's list and buttons, as they stand (the files are read on the way in). */
  private paintSave(screen: FdfScreen): void {
    const bare = (f: string): string => f.replace(/\.o3s$/i, "");
    const fileOf = (name: string): string => (name.toLowerCase().endsWith(SAVE_EXT) ? name : name + SAVE_EXT);
    const list = screen.list("SaveGameList");
    if (list) {
      list.setItems(this.saveFiles.map((n): ListItem => ({ value: n, label: bare(n) })));
      const match = this.saveFiles.find((n) => n.toLowerCase() === fileOf(this.saveName).toLowerCase());
      if (match) list.select(match);
      list.onChange = (value) => {
        this.saveName = bare(value);
        const box = screen.editBox("SaveGameFileEditBox");
        if (box) box.value = this.saveName;
        this.paintSave(screen);
      };
      list.onActivate = (value) => {
        this.saveName = bare(value);
        if (this.panel === "load") this.loadPicked();
        else this.savePicked();
      };
    }
    const exists = this.saveFiles.some((n) => n.toLowerCase() === fileOf(this.saveName.trim()).toLowerCase());
    screen.setEnabled("SaveGameSaveButton", !this.saving && this.saveName.trim() !== "");
    screen.setEnabled("SaveGameDeleteButton", !this.saving && exists);
    screen.setEnabled("LoadGameLoadButton", exists);
  }

  /** Save, or — when that name is taken — ask first (OVERWRITE_MESSAGE, the game's own face). */
  private savePicked(): void {
    const name = this.saveName.trim();
    if (!name || this.saving) return;
    const taken = this.saveFiles.some((n) => n.toLowerCase() === (name + SAVE_EXT).toLowerCase());
    if (taken && this.panel !== "overwrite") return this.go("overwrite");
    void this.writeSave(name);
  }

  private async writeSave(name: string): Promise<void> {
    const save = this.actions.onSaveGame;
    if (!save || this.saving) return;
    this.saving = true;
    try {
      await save(name);
      this.saving = false;
      // Saved: back to the game, as the game does.
      this.actions.onReturn();
    } catch (err) {
      this.saving = false;
      console.warn("[save] could not save:", err);
      this.go("save");
    }
  }

  private loadPicked(): void {
    const name = this.saveName.trim();
    const file = this.saveFiles.find((n) => n.toLowerCase() === (name + SAVE_EXT).toLowerCase());
    if (file) this.actions.onLoadGame?.(file);
  }

  private async deletePicked(): Promise<void> {
    const file = this.saveFiles.find((n) => n.toLowerCase() === (this.saveName.trim() + SAVE_EXT).toLowerCase());
    if (file) await this.actions.saves?.()?.remove(file).catch(() => false);
    this.saveName = "";
    this.go("save");
  }

  /** Read the saves folder, then repaint whichever save face is up. */
  private async listSaves(): Promise<void> {
    const sink = this.actions.saves?.();
    const all = sink ? await sink.list().catch(() => []) : [];
    this.saveFiles = all.map((f) => f.name);
    if (this.screen && (this.panel === "save" || this.panel === "load")) this.paintSave(this.screen);
  }

  /** Open the Save (or Load) face, the name box primed with a fresh name / the newest save. */
  private openSave(which: "save" | "load"): void {
    this.saveName = which === "save" ? this.actions.suggestedSaveName?.() ?? "" : "";
    this.go(which);
    void this.listSaves();
  }

  /**
   * **One button, two captions.** `PauseButton` ships `Text "KEY_PAUSE_GAME"`, and
   * `GlobalStrings.fdf` ships its twin right beside it:
   *
   *     KEY_PAUSE_GAME    "Pause Ga|Cffffffffm|Re"   KEY_PAUSE_GAME_SHORTCUT   "m"
   *     KEY_RESUME_GAME   "Resume Ga|Cffffffffm|Re"  KEY_RESUME_GAME_SHORTCUT  "m"
   *
   * Same accelerator, same slot on the panel, no second button anywhere in the FDF — which is
   * how we know the engine swaps the CAPTION rather than showing another control. So this
   * rewrites the key on the way through `rootFrame`, leaving the string table to localize it
   * exactly as it localizes the other one.
   *
   * Keyed on the PLAYER's pause, not on "is the world stopped": the menu being open stops it
   * too in single-player, and a panel whose pause button read "Resume Game" the moment it
   * appeared would offer to undo something nobody did.
   */
  private captionPause(f: FdfFrame): FdfFrame {
    if (!this.actions.isPaused?.()) return f;
    if (f.name === "PauseButtonText") {
      return { ...f, props: f.props.map((p) => (p.key === "Text" ? prop("Text", { s: "KEY_RESUME_GAME", n: null, str: true }) : p)) };
    }
    if (!f.children.length) return f;
    return { ...f, children: f.children.map((c) => this.captionPause(c)) };
  }

  /** Every button on every panel. A name that isn't on the panel currently built simply
   *  never binds — the renderer only wires handlers for frames it actually drew. */
  private handlers(): Record<string, () => void> {
    return {
      // --- MainPanel
      PauseButton: () => (this.actions.onPause ?? this.actions.onReturn)(),
      HelpButton: () => this.go("help"),
      TipsButton: () => this.go("tips"),
      EndGameButton: () => this.go("endgame"),
      ReturnButton: () => this.actions.onReturn(),
      // --- EndGamePanel. "Quit Mission" leaves the match; "Exit Program" asks first, as in
      // the game, and then closes the program (`onExitProgram` — in a browser, which cannot
      // close a tab it did not open, the nearest honest thing is leaving the match).
      QuitButton: () => this.actions.onEndGame(),
      ExitButton: () => this.go("confirmquit"),
      PreviousButton: () => this.go("main"),
      // --- ConfirmQuitPanel
      ConfirmQuitQuitButton: () => (this.actions.onExitProgram ?? this.actions.onEndGame)(),
      ConfirmQuitCancelButton: () => this.go("endgame"),
      // --- OptionsPanel, and the three settings panels behind it (ui/escOptions.ts). Every
      // one of these buttons steps the same stack the panels above it do.
      OptionsButton: () => this.go("options"),
      GameplayButton: () => this.go("optgameplay"),
      VideoButton: () => this.go("optvideo"),
      SoundButton: () => this.go("optsound"),
      OptionsPreviousButton: () => this.go("main"),
      // OK and Cancel go back ONE level, to the category list they were opened from — the same
      // step Previous Menu and Cancel take everywhere else on this stack.
      OptionsOKButton: () => { this.options.ok(); this.go("options"); },
      GamepadButton: () => gamepadButtonPressed(), // detect / unpair, issue #162 — ui/gamepad.ts
      // Voice Control's speech model (src/voice/), mid-match as well as from the menus.
      VoiceDownloadButton: () => voiceDownloadPressed(this.container, this.vfs),
      OptionsCancelButton: () => { this.options.cancel(); this.go("options"); },
      // --- HelpPanel / TipsPanel
      HelpOKButton: () => this.go("main"),
      TipsOKButton: () => this.go("main"),
      TipsBackButton: () => this.stepTip(-1),
      TipsNextButton: () => this.stepTip(1),
      // --- Save Game / Load Game (EscMenuSaveGamePanel.fdf)
      SaveGameButton: () => this.openSave("save"),
      LoadGameButton: () => this.openSave("load"),
      SaveGameSaveButton: () => this.savePicked(),
      SaveGameDeleteButton: () => this.go("delete"),
      SaveGameCancelButton: () => this.go("main"),
      LoadGameLoadButton: () => this.loadPicked(),
      LoadGameCancelButton: () => this.go("main"),
      OverwriteOverwriteButton: () => void this.writeSave(this.saveName.trim()),
      OverwriteCancelButton: () => this.go("save"),
      DeleteDeleteButton: () => void this.deletePicked(),
      DeleteCancelButton: () => this.go("save"),
    };
  }

  /** Fill the panel's contents and grey what we can't do yet. Runs on every build —
   *  including the rebuild a RESIZE triggers, which is why it can't be done inline. */
  private onBuild(screen: FdfScreen): void {
    // No way to restart a match from inside it; Save and Load are live where they can be used.
    screen.setEnabled("RestartButton", false);
    const sink = this.actions.saves?.() ?? null;
    screen.setEnabled("SaveGameButton", !!sink && !!this.actions.onSaveGame && !this.actions.saveRefusal?.());
    screen.setEnabled("LoadGameButton", !!sink && !!this.actions.onLoadGame);
    if (this.panel === "save" || this.panel === "load") {
      const box = screen.editBox("SaveGameFileEditBox");
      if (box) {
        box.value = this.saveName;
        box.onChange = (v) => {
          this.saveName = v;
          this.paintSave(screen);
        };
        box.onSubmit = () => this.savePicked();
        box.focus();
      }
      this.paintSave(screen);
    } else if (this.panel === "overwrite" || this.panel === "delete") {
      const key = this.panel === "overwrite" ? "OVERWRITE_MESSAGE" : "DELETE_MESSAGE";
      const fallback = this.panel === "overwrite"
        ? "Are you sure you want to overwrite the existing save game file '%s'?"
        : "Are you sure you want to delete the saved game '%s'?";
      const text = this.lib?.string(key);
      screen.setText(this.panel === "overwrite" ? "OverwriteMessageText" : "DeleteMessageText", (text && text !== key ? text : fallback).replace("%s", this.saveName.trim()));
    }
    const settings = OPTIONS_PANELS[this.panel];
    if (settings) this.options.bind(screen, settings, this.lib);
    if (this.panel === "help") {
      screen.textArea("HelpTextArea")?.setLines(this.help);
    } else if (this.panel === "tips") {
      // One tip per page — that is what Back and Next are for. Its number is not in the
      // FDF (the panel's title is the flat "Warcraft III Tips"), so the page counter is ours.
      screen.textArea("TipsTextArea")?.setLines(this.tips.length ? [this.tips[this.tip]] : []);
      screen.setEnabled("TipsBackButton", this.tip > 0);
      screen.setEnabled("TipsNextButton", this.tip < this.tips.length - 1);
    }
  }

  private stepTip(by: number): void {
    const next = this.tip + by;
    if (next < 0 || next >= this.tips.length) return;
    this.tip = next;
    if (this.screen) this.onBuild(this.screen);
  }
}

/**
 * MainPanel WITHOUT its Pause Game button (`EscMenuActions.canPause`), laid out as if it had
 * never been there. The layout is OURS — the FDF has one MainPanel and no single-player twin —
 * and it is the least it can be: Save Game takes the Pause button's own anchor (and its
 * TabFocusDefault), everything chained under Save rides up with it, and the panel loses exactly
 * the height that moved, so Return to Game (anchored to the panel's BOTTOM) keeps its spacing
 * rather than leaving a hole above it.
 */
function dropPause(panel: FdfFrame): { children: FdfFrame[]; shrink: number } {
  const pause = findFrame(panel, "PauseButton");
  const save = findFrame(panel, "SaveGameButton");
  if (!pause || !save) return { children: panel.children, shrink: 0 };
  const pointOf = (f: FdfFrame): FdfProp | undefined => f.props.find((p) => p.key === "SetPoint");
  const yOf = (f: FdfFrame): number => pointOf(f)?.args[4]?.n ?? 0;
  const shrink = Math.max(0, yOf(pause) - yOf(save)); // -0.067 − -0.104 = 0.037
  const pausePoint = pointOf(pause);
  const strip = (f: FdfFrame): FdfFrame | null => {
    if (f.name === "PauseButton") return null;
    let out = f;
    if (f.name === "SaveGameButton" && pausePoint) {
      out = { ...f, props: [...f.props.map((p) => (p.key === "SetPoint" ? pausePoint : p)), prop("TabFocusDefault")] };
    }
    if (!out.children.length) return out;
    return { ...out, children: out.children.map(strip).filter((c): c is FdfFrame => !!c) };
  };
  return { children: panel.children.map(strip).filter((c): c is FdfFrame => !!c), shrink };
}
