// The in-game console — ALL of it — built from the game's own FrameDef: `ConsoleUI.fdf` for
// the chrome, `UpperButtonBar.fdf` for the Quests/Menu/Allies/Chat buttons and
// `ResourceBar.fdf` for the gold/lumber/supply/upkeep readout.
//
// `ConsoleUI.fdf` is ONE frame carrying two runs of `Texture`, told apart only by their own
// anchors. The top edge is five slices:
//
//     ConsoleTexture01  0.256 wide  Anchor TOPLEFT  0,      0     →  0.000 … 0.256
//     ConsoleTexture02  0.087 wide  Anchor TOPLEFT  0.256,  0     →  0.256 … 0.343
//     ConsoleTexture02  0.053 wide  Anchor TOPRIGHT -0.288, 0     →  0.459 … 0.512
//     ConsoleTexture03  0.256 wide  Anchor TOPRIGHT -0.032, 0     →  0.512 … 0.768
//     ConsoleTexture04  0.032 wide  Anchor TOPRIGHT  0,      0     →  0.768 … 0.800
//
// — two runs of chrome with a deliberate GAP between them (0.343 … 0.459). And the bottom is
// four more (`BOTTOMLEFT`/`BOTTOMRIGHT`, `TexCoord` v 0.3125 … 1), which tile the full 0.8
// with no gap: that band is the console proper — the minimap frame, the portrait arch, the
// inventory and the command card, all drawn as one piece of art with the sockets punched
// through it as transparency. The HUD hangs its widgets in those holes (`CONSOLE_ZONES` in
// ui/hud.ts); the art itself is entirely this file's business.
//
// **Where the two bars go is not in any of those files** — each declares a size and no
// SetPoint, because `CGameUI` places them, exactly as it places the leaderboard. The strip is
// what gives the answer away: the bars are 0.34 and 0.338 wide, one console section each,
// with the gap left for the time-of-day indicator that hangs there. So the buttons sit hard
// left, the resources hard right, and the clock in the hole between them.
//
// **The whole console is held at the 4:3 box it was authored for, centred**, rather than
// stretched to the viewport the way the rest of the FDF layer spreads a menu (fdf/layout.ts
// fitBox). 1.27a itself did stretch — measured off the real client at 1424×720, its command
// cells come out 78 × 52.5 px, a 1.49× horizontal smear — and the game stopped doing it: at
// 1.30.4 the console is exactly `height × 4/3` centred (cells 78 × 78, square) with filler
// panels either side. That is the version we follow, and it is also what the art wants, since
// the top strip's five slices are a fixed run with a hole that only stays medallion-sized at
// the proportions they were drawn at. `SIDE_FILLER` below is the leftover width.

import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame, FdfProp } from "./fdf/parser";
import { type FdfLibrary } from "./fdf/library";
import { UI_HEIGHT, UI_WIDTH } from "./fdf/layout";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";

const CONSOLE_FDF = "UI\\FrameDef\\UI\\ConsoleUI.fdf";
const UPPER_BAR_FDF = "UI\\FrameDef\\UI\\UpperButtonBar.fdf";
const RESOURCE_BAR_FDF = "UI\\FrameDef\\UI\\ResourceBar.fdf";

/** The bottom band's height, from `ConsoleUI.fdf`'s own `Height 0.176` — the tallest of its
 *  four bottom slices, which is the one that sets the band. Exported because the HUD sizes the
 *  box it hangs the minimap/portrait/command card in off exactly this (ui/hud.ts). */
export const CONSOLE_BAND_H = 0.176;

/**
 * Where we knowingly do NOT do what `ConsoleUI.fdf` says, in one place so it can be seen and
 * argued with. Everything else about the console is the file's and `war3skins.txt`'s.
 */
const CONSOLE_OVERRIDES = {
  /**
   * Hold the console at the 4:3 box it was drawn for instead of stretching it to the
   * viewport, and fill the leftover width either side.
   *
   * The FDF has no opinion here — it is written in a 0.8 × 0.6 space and something else
   * decides what that maps to. 1.27a maps 0.8 to the whole screen, which on 16:9 smears every
   * command icon 1.49× wide (measured: 78 × 52.5 px cells). 1.30.4 stopped, and draws filler
   * panels in the gap instead. We follow 1.30.4.
   */
  holdAspect: true,
} as const;

/**
 * How far up the band the console ART reaches — the LOWEST top edge it has anywhere across
 * its width, measured off the decoded tiles (the two ends reach 0.1633, the middle section
 * with the arch and the info panel only 0.1317).
 *
 * It is the height of the flat black the game paints behind the whole console. The art is
 * full of holes — the minimap, the portrait arch, the info panel, the inventory and the
 * command card are all cut out of it as transparency — and no world ever shows through any of
 * them: they read as pure black behind the frame. Taking the lowest edge is what keeps that
 * backing from poking out ABOVE the art at the ends, where the world does show.
 */
const CONSOLE_ART_TOP = 0.1317;

/** The strip's frames are 0.032 tall, but the ART only fills the top 77% of that — measured
 *  off the decoded slice, whose last opaque row is 48 of 64. The remaining quarter is
 *  transparent, so centring the bars in the FRAME hangs them below the chrome you can see. */
const STRIP_ART = 0.032 * (49 / 64);

/** How far down the visible chrome the two bars sit: centred in the ART, not in the frame.
 *  Both bars are ~0.022 tall. */
const BAR_TOP = -(STRIP_ART - 0.022) / 2;

/** One screen pixel, in world units, at the height the UI is laid out for (0.6 world = the
 *  viewport's height; ~1042 px/world at 625 px tall). Nudges below are expressed through it
 *  so they stay the same visual size at any resolution instead of drifting. */
const PX = 0.6 / 625;

/** The button bar reads a hair right and low against the console art it sits in — the plates
 *  are drawn with their own shadow, so geometric centring is not visual centring. Trimmed by
 *  eye against the chrome: one pixel left, one up. */
const BUTTON_NUDGE_X = -1 * PX;
const BUTTON_NUDGE_Y = 1 * PX;

const s = (v: string): Arg => ({ s: v, n: null, str: true });
const word = (v: string): Arg => ({ s: v, n: null, str: false });
const num = (v: number): Arg => ({ s: String(v), n: v, str: false });
const prop = (key: string, ...args: Arg[]): FdfProp => ({ key, args });

/** The four panels the button bar opens — the same ones F9…F12 open. */
export type ConsolePanel = "quests" | "menu" | "allies" | "chat";

const BUTTONS: Array<{ frame: string; panel: ConsolePanel }> = [
  { frame: "UpperButtonBarQuestsButton", panel: "quests" },
  { frame: "UpperButtonBarMenuButton", panel: "menu" },
  { frame: "UpperButtonBarAlliesButton", panel: "allies" },
  { frame: "UpperButtonBarChatButton", panel: "chat" },
];

export interface ConsoleUiActions {
  openPanel(panel: ConsolePanel): void;
  /** Put the day/night medallion in the slot the strip leaves for it (render/timeIndicator.ts).
   *  Returns false when there is no install to render the model from. */
  mountClock(slot: HTMLElement): boolean;
}

/** What the resource readout shows. Formatted by the caller — the bar only places it. */
export interface ConsoleResources {
  gold: string;
  lumber: string;
  supply: string;
  upkeep: string;
  /** Upkeep's colour band (WC3 turns the label orange at low, red at high upkeep). */
  upkeepColor: string;
}

export class ConsoleUi {
  private screen: FdfScreen | null = null;
  private mounting = false;
  private shown = true;
  private last: ConsoleResources | null = null;

  /** `skin` is the war3skins.txt section the chrome is decorated from — the console art and
   *  the button atlas are per-RACE (`orc-console-buttonstates2.blp`, `OrcUITile01`). */
  constructor(
    private container: HTMLElement,
    private vfs: DataSource,
    private skin: string,
    private actions: ConsoleUiActions,
  ) {
    void this.build();
  }

  /** The element the strip is drawn into, so the host can hang the clock in its gap. */
  element(): HTMLElement | null {
    return this.screen?.element ?? null;
  }

  setVisible(on: boolean): void {
    this.shown = on;
    const el = this.screen?.element;
    if (el) el.style.display = on ? "" : "none";
  }

  /** Push the current resource figures. Cheap to call every frame: it only writes the four
   *  strings when one of them actually changed. */
  update(next: ConsoleResources): void {
    const prev = this.last;
    if (prev && prev.gold === next.gold && prev.lumber === next.lumber
      && prev.supply === next.supply && prev.upkeep === next.upkeep
      && prev.upkeepColor === next.upkeepColor) return;
    this.last = next;
    this.paint();
  }

  /** `screen` is passed in rather than read off `this`, because the build hook fires from
   *  inside `mountFdfScreen` — before the field it would read has been assigned. */
  private paint(screen: FdfScreen | null = this.screen): void {
    const r = this.last;
    if (!screen || !r) return;
    screen.setText("ResourceBarGoldText", r.gold);
    screen.setText("ResourceBarLumberText", r.lumber);
    screen.setText("ResourceBarSupplyText", r.supply);
    screen.setText("ResourceBarUpkeepText", r.upkeep);
    const upkeep = screen.frame("ResourceBarUpkeepText")?.querySelector("span");
    if (upkeep) upkeep.style.color = r.upkeepColor;
  }

  /**
   * Hang the day/night medallion in the hole the strip leaves for it.
   *
   * The indicator is a MODEL rather than a frame, so it is not in the FrameDef and something
   * has to place it — and only the strip knows where the hole is. It lives INSIDE this
   * overlay rather than in the HUD for one reason: the game stage is a TRANSFORMED element,
   * so viewport coordinates mean nothing to an absolutely-positioned child of the HUD, and
   * neither `absolute` nor `fixed` there lands on a rect measured out here. Sharing the
   * overlay makes the two the same coordinate space and the question disappears.
   *
   * Rebuilt with the strip, so a resize re-places it.
   */
  private mountClock(screen: FdfScreen | null = this.screen): void {
    const overlay = screen?.element;
    const filler = this.gapFiller(screen);
    if (!overlay || !filler) return;
    const gap = filler.getBoundingClientRect();
    const host = overlay.getBoundingClientRect();

    // Re-use the slot across rebuilds. Emptying the overlay DETACHES it but does not destroy
    // it, so appending the same element back moves it — and the medallion's canvas, and the
    // live WebGL context and loaded model with it. Building a fresh one instead would make the
    // host re-read the MDX on every resize, which blanks the indicator for as long as that
    // takes and thrashes badly while a window edge is being dragged.
    const reused = this.clockSlot !== null;
    const slot = this.clockSlot ?? document.createElement("div");
    if (!reused) {
      slot.className = "hud-clock hud-clock-skinned";
      slot.title = "Day/night cycle";
    }
    slot.style.left = `${gap.left - host.left}px`;
    slot.style.top = `${gap.top - host.top}px`;
    slot.style.width = `${gap.width}px`;
    overlay.appendChild(slot);
    if (reused) return;
    if (this.actions.mountClock(slot)) this.clockSlot = slot;
    else slot.remove();
  }

  /** The medallion's slot, kept across rebuilds so its model is loaded once. */
  private clockSlot: HTMLElement | null = null;

  /** The frame that spans the hole — the same rect the medallion wants. */
  private gapFiller(screen: FdfScreen | null = this.screen): HTMLElement | null {
    const el = screen?.element;
    if (!el) return null;
    // The bridge is the only unnamed TEXTURE placed by two opposing SetPoints, so it is the
    // one strip child whose left edge is not the screen's and whose right edge is not either.
    const bars = el.querySelectorAll<HTMLElement>('[data-frame="UpperButtonBarFrame"], [data-frame="ResourceBarFrame"]');
    if (bars.length < 2) return null;
    const leftEnd = bars[0].getBoundingClientRect().right;
    const rightStart = bars[1].getBoundingClientRect().left;
    for (const f of el.querySelectorAll<HTMLElement>(".fdf-frame")) {
      const r = f.getBoundingClientRect();
      if (Math.abs(r.left - leftEnd) < 12 && Math.abs(r.right - rightStart) < 12 && r.width > 8) return f;
    }
    return null;
  }

  dispose(): void {
    this.screen?.dispose();
    this.screen = null;
    // The host owns the clock object itself and tears it down with the match; this only
    // drops our hold on its slot, so a new bar builds a new one.
    this.clockSlot?.remove();
    this.clockSlot = null;
  }

  private async build(): Promise<void> {
    if (this.mounting) return;
    this.mounting = true;
    try {
      const handlers: Record<string, () => void> = {};
      for (const b of BUTTONS) handlers[b.frame] = () => this.actions.openPanel(b.panel);
      const prev = this.screen;
      const screen = await mountFdfScreen({
        container: this.container,
        vfs: this.vfs,
        fdfPath: CONSOLE_FDF,
        includeFdf: [UPPER_BAR_FDF, RESOURCE_BAR_FDF],
        rootFrame: "ConsoleUI",
        overlayClass: "fdf-ingame fdf-topbar",
        skin: this.skin,
        // Centred at the root's own 0.8×0.6, so the console keeps the proportions it was drawn
        // at and the fillers take the leftover width (see rootFrame + CONSOLE_OVERRIDES).
        centerRoot: CONSOLE_OVERRIDES.holdAspect,
        buildRoot: (lib) => this.rootFrame(lib),
        handlers,
        // A resize REBUILDS the whole screen — the overlay is emptied and every frame is made
        // again — so anything the strip put there by hand has to go back. That is the numbers,
        // and the medallion: left out, the clock's canvas was thrown away on the first resize
        // while the renderer kept drawing into the detached one, and the indicator simply went
        // blank. Both are restored here rather than after the mount, because this is the hook
        // that runs on EVERY build instead of only the first.
        onBuild: (built) => {
          this.backing(built);
          this.paint(built);
          this.mountClock(built);
        },
      });
      prev?.dispose();
      this.screen = screen;
      this.setVisible(this.shown);
    } catch (err) {
      console.warn("[topbar] could not mount the FDF strip:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
    }
  }

  /**
   * The whole console: every `Texture` `ConsoleUI` declares — the top strip AND the bottom
   * band — plus the medallion bridge, the two bars anchored to the strip's ends, and the side
   * fillers that carry both bands out to a 16:9 screen's edges.
   */
  private rootFrame(lib: FdfLibrary): FdfFrame {
    const console = lib.resolveRoot("ConsoleUI");
    if (!console) throw new Error('FDF: frame "ConsoleUI" not found');
    const children = console.children.slice();

    // Close the seam behind the medallion. The two runs stop either side of a 0.116-wide
    // hole, and the TimeIndicator model that hangs there does NOT square it off — its frame
    // is an arch, narrower at the top and inset from the canvas it renders into, so bare map
    // showed in two slivers beside it. The file has the piece: `ConsoleTexture02` appears
    // TWICE, once as its left end (TexCoord 0 … 0.34) and once as its right (0.793 … 1), and
    // the middle those two are the ends OF is what belongs between them. It is 0.116 wide and
    // sits entirely UNDER the medallion, so nothing about it reads as stretched.
    children.push({
      type: "TEXTURE",
      name: "",
      inherits: null,
      withChildren: false,
      props: [
        prop("File", s("ConsoleTexture02")),
        prop("TexCoord", num(0.33984375), num(0.79296875), num(0), num(0.125)),
        prop("AlphaMode", s("ALPHAKEY")),
        prop("Height", num(0.032)),
        // Opposing points, so it solves to exactly the hole: the left run ends at
        // 0.256 + 0.087, the right one starts 0.288 + 0.053 in from the right edge.
        prop("SetPoint", word("TOPLEFT"), s("ConsoleUI"), word("TOPLEFT"), num(0.343), num(0)),
        prop("SetPoint", word("TOPRIGHT"), s("ConsoleUI"), word("TOPRIGHT"), num(-0.341), num(0)),
      ],
      children: [],
    });

    const bar = (name: string, point: "TOPLEFT" | "TOPRIGHT", dx: number, dy: number): void => {
      const frame = lib.resolveRoot(name);
      if (!frame) return;
      children.push({
        ...frame,
        props: [
          ...frame.props.filter((p) => p.key !== "SetPoint"),
          prop("SetPoint", word(point), s("ConsoleUI"), word(point), num(dx), num(dy)),
        ],
      });
    };
    bar("UpperButtonBarFrame", "TOPLEFT", BUTTON_NUDGE_X, BAR_TOP + BUTTON_NUDGE_Y);
    bar("ResourceBarFrame", "TOPRIGHT", 0, BAR_TOP);


    // Give the console the 4:3 box the file was authored for, CENTRED, rather than letting it
    // fill the viewport. The rest of the FDF layer deliberately stretches to the screen's
    // edges (fdf/layout.ts fitBox), and that is right for a menu; it is wrong here, because
    // this art does not tile — pulling the two runs apart to the screen's corners opens a
    // hole in the middle that nothing in the file is meant to cover, and it smears every
    // command icon sideways. Held at its own proportions it sits centred with the fillers
    // either side, the gap between the runs comes out exactly the width of the medallion that
    // hangs in it, and the command card's cells stay square (they are 0.0438 × 0.0437 in the
    // file — square in WORLD units, so only an isotropic fit keeps them square on screen).
    return {
      ...console,
      props: [
        ...console.props.filter((p) => p.key !== "Width" && p.key !== "Height"),
        prop("Width", num(UI_WIDTH)),
        prop("Height", num(UI_HEIGHT)),
      ],
      children,
    };
  }

  /**
   * Lay the flat black in behind the console — and, either side of it, in place of the
   * console.
   *
   * Both bands run the FULL width of the game frame, which does two jobs at once. Behind the
   * 4:3 box it is what every socket the art punches through reads as: no world ever shows
   * through the minimap, the portrait arch, the info panel or the command card. Outside the
   * box it is the panel the later game fills the widescreen gap with — 1.30.4 has a texture
   * for that and 1.27a has none, so rather than smear the console's own edge sideways (which
   * looks like exactly what it is) these are simply left blank, at the console's own height.
   *
   * They belong to THIS overlay rather than to the HUD, and that is not a preference: the HUD
   * is built after the console and stacks over it (render/mapViewer.ts says so), so a black
   * rect put there would cover the stone instead of backing it.
   */
  private backing(screen: FdfScreen): void {
    const overlay = screen.element;
    for (const [cls, h] of [["console-backing", CONSOLE_ART_TOP], ["console-backing-top", STRIP_ART]] as const) {
      const el = document.createElement("div");
      el.className = cls;
      el.style.height = `${(h / UI_HEIGHT) * 100}%`;
      overlay.prepend(el);
    }
  }
}
