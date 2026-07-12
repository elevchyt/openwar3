// The cinematic panel (7.24 — issue #33; see docs/triggers.md).
//
// Everything a cinematic puts on the screen that isn't the camera: the **letterbox** bars,
// the **transmission** panel (portrait + speaker + subtitle), and the **fade**. The natives
// live in src/jass/natives/cinematic.ts; this is the surface.
//
// The chrome is the GAME'S OWN — `UI\FrameDef\UI\CinematicPanel.fdf`, sitting right beside
// the LeaderBoard / MultiBoard / TimerDialog FDFs we already mount. It declares exactly the
// three pieces, and its own comment tells us how they relate:
//
//     Frame "FRAME" "CinematicPanel" {  SetAllPoints,
//         Frame "BACKDROP" "CinematicBottomBorder" { Width 0.8, Height 0.14,   … }
//         // --- The "CinematicScenePanel" is shown and hidden as there
//         //     is a cinematic scene to display.
//         Frame "FRAME" "CinematicScenePanel" {
//             Frame "SPRITE"   "CinematicPortrait"       { Width 0.116, Height 0.116, … }
//             Frame "BACKDROP" "CinematicPortraitCover"  { … }
//             Frame "TEXT"     "CinematicSpeakerText"    { … }
//             Frame "TEXT"     "CinematicDialogueText"   { Width 0.55, … } }
//         Frame "BACKDROP" "CinematicTopBorder"    { Width 0.8, Height 0.0275, … } }
//
// **The bars and the scene are independent**, and that comment is why. `ShowInterface(false)`
// brings the letterbox in; `SetCinematicScene` shows the talking head. A transmission during
// normal play — an ally warning you mid-melee — shows the portrait with NO letterbox, and a
// silent camera flythrough shows the letterbox with no portrait. So they toggle separately.
//
// Three adaptations the file cannot state:
//   • **The bars are 0.8 wide**, i.e. exactly a 4:3 screen. On a widescreen that would leave
//     the map showing past both ends of the letterbox, so they are stretched to the full
//     viewport width (the same "FDF is authored for 4:3" adjustment the HUD makes).
//   • **The portrait is a SPRITE** — a live model, not a texture. It gets the same treatment
//     as the HUD's: a canvas, and a ModelViewerScene driving the speaker's `_Portrait.mdx`.
//   • **The unsized-frame trap, for the fourth time** (leaderboard title, timer-dialog title,
//     multiboard title band). `CinematicSpeakerText` declares neither Width nor Height and
//     `CinematicDialogueText` only a Width — our layout solver derives nothing from that, so
//     both collapse to 0×0 and never draw. They get an explicit box here.

import type { CineFilter, CinematicScene } from "../jass/runtime";
import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame } from "./fdf/parser";
import { type FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { UI_HEIGHT } from "./fdf/layout";
import { PLAYER_COLORS } from "./hud";

const CINEMATIC_FDF = "UI\\FrameDef\\UI\\CinematicPanel.fdf";

const word = (v: string): Arg => ({ s: v, n: null, str: false });
const num = (v: number): Arg => ({ s: String(v), n: v, str: false });

/** common.j blendmode → the CSS blend the filter quad is composited with. WC3's fades all
 *  use BLEND (2, plain alpha); the additive/modulate modes exist for the campaign's coloured
 *  washes and map onto the nearest CSS equivalent. */
const BLEND_CSS: Record<number, string> = {
  3: "screen", // BLEND_MODE_ADDITIVE
  4: "multiply", // BLEND_MODE_MODULATE
  5: "multiply", // BLEND_MODE_MODULATE_2X
};

/** A fade in flight. WC3 animates the filter quad from `start` to `end` over `duration` and
 *  then HOLDS the end colour — it does not clear itself. `DisplayCineFilter(false)` is what
 *  takes it off screen, which is why blizzard.j has to arm a timer (FinishCinematicFadeBJ) to
 *  do that at the end of a fade-IN. */
interface LiveFilter {
  filter: CineFilter;
  t: number;
}

export class CinematicPanelOverlay {
  private screen: FdfScreen | null = null;
  private mounting = false;
  /** Bars in (ShowInterface(false)) — the letterbox. */
  private letterbox = false;
  private letterboxFade = 0;
  private barsUp = false; // what the LAST build put on screen (drives the slide-in, once)
  private scene: CinematicScene | null = null;
  private sceneAge = 0;
  private builtFor = "";

  /** The fade quad — our own element, not an FDF frame: WC3's cine filter is a full-screen
   *  quad drawn over the WORLD and under the UI, which is precisely why blizzard.j calls
   *  EnableUserUI(false) before every fade (if the filter covered the interface it wouldn't
   *  have to). So it sits under the panel and over the canvas. */
  private filterEl: HTMLDivElement;
  private live: LiveFilter | null = null;

  /** The portrait canvas we splice into the FDF's SPRITE frame; the host owns the model
   *  viewer that draws into it (mapViewer, exactly as for the HUD's bust). */
  private portraitCanvasEl: HTMLCanvasElement;

  constructor(private container: HTMLElement, private vfs: DataSource, private skin: string) {
    this.filterEl = document.createElement("div");
    this.filterEl.className = "cine-filter";
    this.filterEl.hidden = true;
    container.appendChild(this.filterEl);
    this.portraitCanvasEl = document.createElement("canvas");
    this.portraitCanvasEl.className = "cine-portrait-canvas";
  }

  /** The canvas the speaker's animated bust is rendered into (empty until a scene is up). */
  portraitCanvas(): HTMLCanvasElement {
    return this.portraitCanvasEl;
  }

  /** ShowInterface(flag, fadeDuration) — the bars slide in/out over `fade` seconds. */
  setLetterbox(on: boolean, fade: number): void {
    this.letterbox = on;
    this.letterboxFade = Math.max(0, fade);
    this.sync();
  }

  /** SetCinematicScene / EndCinematicScene. Returns true if this is a NEW speaker (so the
   *  host knows to load a different portrait model). */
  setScene(scene: CinematicScene | null): boolean {
    const changed = (this.scene?.portraitUnitId ?? "") !== (scene?.portraitUnitId ?? "");
    this.scene = scene;
    this.sceneAge = 0;
    this.sync();
    return changed;
  }

  /** DisplayCineFilter(flag) — commit a configured filter, or take the current one down. */
  setFilter(filter: CineFilter | null): void {
    this.live = filter ? { filter, t: 0 } : null;
    if (!this.live) this.filterEl.hidden = true;
  }

  /** Whether a scene is on screen — the host gates the portrait model on it. */
  get sceneActive(): boolean {
    return !!this.scene;
  }

  /** Poll each frame. `dt` is SECONDS.
   *
   *  (`dt` in mapViewer's frame loop is MILLISECONDS — the conversion is the caller's, and it
   *  is the single most expensive mistake in this subsystem's history: 7.23's weather rendered
   *  a field of age-0 particles for an hour because of it.) */
  update(dt: number): void {
    // A scene expires on its own clock — SetCinematicScene's sceneDuration — which is what
    // takes a transmission off the screen when no one calls EndCinematicScene. WC3's own
    // DoTransmissionBasicsXYBJ leans on this: it passes duration + bj_TRANSMISSION_PORT_HANGTIME
    // (1.5 s), so the portrait lingers a beat after the voice line ends.
    if (this.scene) {
      this.sceneAge += dt;
      if (this.scene.sceneDuration > 0 && this.sceneAge >= this.scene.sceneDuration) {
        this.scene = null;
        this.sync();
      }
    }
    this.tickFilter(dt);
  }

  private tickFilter(dt: number): void {
    if (!this.live) return;
    const { filter } = this.live;
    this.live.t = Math.min(filter.duration, this.live.t + dt);
    const x = filter.duration > 0 ? this.live.t / filter.duration : 1;
    const lerp = (a: number, b: number): number => a + (b - a) * x;
    const r = Math.round(lerp(filter.start.r, filter.end.r));
    const g = Math.round(lerp(filter.start.g, filter.end.g));
    const b = Math.round(lerp(filter.start.b, filter.end.b));
    const a = lerp(filter.start.a, filter.end.a) / 255;
    this.filterEl.hidden = false;
    this.filterEl.style.background = `rgba(${r}, ${g}, ${b}, ${a})`;
    this.filterEl.style.mixBlendMode = BLEND_CSS[filter.blendMode] ?? "normal";
  }

  /** Rebuild the FDF panel when what's on screen changes (the bars, or the speaker's lines).
   *  The rest — the fade, the portrait model — is animated on the elements we already have. */
  private sync(): void {
    const key = `${this.letterbox}|${this.scene ? `${this.scene.speaker} ${this.scene.text} ${this.scene.playerColor}` : ""}`;
    if (key === this.builtFor || this.mounting) return;
    this.builtFor = key;
    if (!this.letterbox && !this.scene) {
      this.teardown();
      return;
    }
    void this.build();
  }

  private teardown(): void {
    this.screen?.dispose();
    this.screen = null;
    this.portraitCanvasEl.remove();
  }

  private async build(): Promise<void> {
    this.mounting = true;
    const letterbox = this.letterbox;
    const scene = this.scene;
    // Slide the bars in only when the letterbox is APPEARING. The panel is rebuilt on every
    // new line of subtitle, and without this the bars would re-slide each time someone speaks.
    const slideIn = letterbox && !this.barsUp;
    this.barsUp = letterbox;
    try {
      const prev = this.screen;
      const screen = await mountFdfScreen({
        container: this.container,
        vfs: this.vfs,
        fdfPath: CINEMATIC_FDF,
        rootFrame: "CinematicPanel",
        overlayClass: "fdf-ingame fdf-cinematic",
        skin: this.skin,
        buildRoot: (lib) => this.rootFrame(lib, letterbox, !!scene),
        textOverrides: {
          CinematicSpeakerText: scene?.speaker ?? "",
          CinematicDialogueText: scene?.text ?? "",
        },
      });
      prev?.dispose(); // swap only once the new panel is up, so the bars never blink
      this.screen = screen;
      if (slideIn) {
        for (const name of ["CinematicTopBorder", "CinematicBottomBorder"]) {
          const el = screen.element.querySelector<HTMLElement>(`[data-frame="${name}"]`);
          if (!el) continue;
          el.classList.add("cine-bar-in");
          el.style.animationDuration = `${this.letterboxFade}s`;
        }
      }
      if (scene) this.mountPortrait(screen, scene);
    } catch (err) {
      console.warn("[cinematic] could not mount the FDF panel:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
    }
  }

  /** Put our portrait canvas inside the SPRITE frame and colour the speaker's name. */
  private mountPortrait(screen: FdfScreen, scene: CinematicScene): void {
    const slot = screen.element.querySelector<HTMLElement>('[data-frame="CinematicPortrait"]');
    if (slot) {
      slot.appendChild(this.portraitCanvasEl);
      // With no portrait model (a transmission from a null unit — DoTransmissionBasicsXYBJ
      // passes unit type 0), the frame stays an empty pane rather than a stale face.
      this.portraitCanvasEl.hidden = !scene.portraitUnitId;
    }
    const speaker = screen.element.querySelector<HTMLElement>('[data-frame="CinematicSpeakerText"] span');
    if (speaker) speaker.style.color = PLAYER_COLORS[scene.playerColor] ?? PLAYER_COLORS[0];
  }

  /** The FDF root, adapted: full-width bars, a sized speaker/subtitle, and the two halves
   *  hidden independently. */
  private rootFrame(lib: FdfLibrary, letterbox: boolean, scene: boolean): FdfFrame {
    const base = lib.resolveRoot("CinematicPanel");
    if (!base) throw new Error('FDF: frame "CinematicPanel" not found');
    // The FDF world is 0.8 × 0.6 at 4:3; on any other aspect the screen is WIDER than 0.8
    // (see fitBox), and a 0.8-wide bar would stop short of both edges.
    const worldW = window.innerWidth / (window.innerHeight / UI_HEIGHT);
    const children = base.children.flatMap((c) => {
      if (c.name === "CinematicTopBorder" || c.name === "CinematicBottomBorder") {
        return letterbox ? [letterboxBar(c, worldW)] : [];
      }
      if (c.name === "CinematicScenePanel") return scene ? [sizeSceneText(c)] : [];
      return [c];
    });
    return { ...base, children };
  }

  dispose(): void {
    this.teardown();
    this.filterEl.remove();
  }
}

/** A letterbox bar: stretched to the real screen width (it is anchored by one corner, so only
 *  the width has to change), and taken OFF the BackdropBlendAll path.
 *
 *  BlendAll makes our renderer stretch one texture over the whole frame and skip the edge file
 *  — which is right for the ornate menu buttons it was tuned on, and wrong here: it left the
 *  bars as translucent smears with no border at all. The file wants the 9-slice: the tiled
 *  `EscMenuBackground` stone, and `CinematicBorder` along the one edge its CornerFlags name
 *  (the bottom bar's "UL|UR|T", the top bar's "BL|BR|B" — the inner edge, the only one that
 *  isn't off-screen). */
function letterboxBar(f: FdfFrame, width: number): FdfFrame {
  return {
    ...f,
    props: [
      ...f.props.filter((p) => p.key !== "Width" && p.key !== "BackdropBlendAll"),
      { key: "Width", args: [num(width)] },
    ],
  };
}

/** Give the two TEXT frames a real box — the unsized-frame trap (see the header). The speaker
 *  line is one line tall; the subtitle keeps the file's 0.55 width and gets room for three.
 *  The portrait's ornate frame comes off BackdropBlendAll for the same reason the bars do. */
function sizeSceneText(panel: FdfFrame): FdfFrame {
  const LINE = 0.016; // one line of the EscMenu title font, plus leading
  const children = panel.children.map((c) => {
    if (c.name === "CinematicPortraitCover") {
      // The "cover" is the frame drawn OVER the bust (EscMenuBorder on a blank pane). Under
      // BlendAll our renderer stretches the pane and never draws the border, so the speaker
      // sat in a bare rectangle.
      return { ...c, props: c.props.filter((p) => p.key !== "BackdropBlendAll") };
    }
    if (c.name === "CinematicSpeakerText") {
      return {
        ...c,
        props: [
          ...c.props.filter((p) => p.key !== "Width" && p.key !== "Height"),
          { key: "Width", args: [num(0.55)] },
          { key: "Height", args: [num(LINE)] },
        ],
      };
    }
    if (c.name === "CinematicDialogueText") {
      return {
        ...c,
        props: [
          ...c.props.filter((p) => p.key !== "Height"),
          { key: "Height", args: [num(LINE * 3)] },
          // A TEXT frame is anchored by its TOP-left here, so it has to grow DOWNWARD from
          // the speaker's line — hence a top-anchored box rather than the solver's default.
          { key: "FontJustificationV", args: [word("JUSTIFYTOP")] },
        ],
      };
    }
    return c;
  });
  // The panel itself carries no size and no anchor: it is a bare container whose children all
  // anchor to CinematicPanel by name. Pin it over the whole screen so nothing collapses.
  return {
    ...panel,
    props: [...panel.props, { key: "SetAllPoints", args: [] }],
    children,
  };
}
