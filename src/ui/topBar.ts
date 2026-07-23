// The in-game top bar, built from the game's own FrameDef: the console's upper strip
// (`ConsoleUI.fdf`), the Quests/Menu/Allies/Chat buttons (`UpperButtonBar.fdf`) and the
// gold/lumber/supply/upkeep readout (`ResourceBar.fdf`).
//
// **Where the two bars go is not in any of those files** — each declares a size and no
// SetPoint, because `CGameUI` places them, exactly as it places the leaderboard. The console
// strip is what gives the answer away. `ConsoleUI.fdf` lays its top edge out as five slices:
//
//     ConsoleTexture01  0.256 wide  Anchor TOPLEFT  0,      0     →  0.000 … 0.256
//     ConsoleTexture02  0.087 wide  Anchor TOPLEFT  0.256,  0     →  0.256 … 0.343
//     ConsoleTexture02  0.053 wide  Anchor TOPRIGHT -0.288, 0     →  0.459 … 0.512   (at 4:3)
//     ConsoleTexture03  0.256 wide  Anchor TOPRIGHT -0.032, 0     →  0.512 … 0.768
//     ConsoleTexture04  0.032 wide  Anchor TOPRIGHT  0,      0     →  0.768 … 0.800
//
// — two runs of chrome with a deliberate GAP between them (0.343 … 0.459). And the two bars
// are 0.34 and 0.338 wide: one console section each, with the gap left for the time-of-day
// indicator that hangs there. So the buttons sit hard left, the resources hard right, and the
// clock in the hole between them, which is where the HUD already keeps it.
//
// The strip is held at that 4:3 box rather than stretched to the viewport, which is the
// opposite of what the rest of the FDF layer does (fdf/layout.ts fitBox spreads a menu to the
// screen's edges). A menu can stretch because its chrome is anchored panels; this art cannot,
// because the five slices are a fixed run with a hole in the middle — pull them to a wide
// screen's corners and the hole opens wider than anything in the file is meant to cover. Held
// at its own proportions the strip sits centred, the leftover width falls away either side,
// and the gap comes out exactly the width of the medallion that hangs in it.

import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame, FdfProp } from "./fdf/parser";
import { type FdfLibrary } from "./fdf/library";
import { UI_HEIGHT, UI_WIDTH } from "./fdf/layout";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";

const CONSOLE_FDF = "UI\\FrameDef\\UI\\ConsoleUI.fdf";
const UPPER_BAR_FDF = "UI\\FrameDef\\UI\\UpperButtonBar.fdf";
const RESOURCE_BAR_FDF = "UI\\FrameDef\\UI\\ResourceBar.fdf";

/** How far down the 0.032-tall strip the two bars sit. They are ~0.022 tall, so this centres
 *  them in the chrome rather than hanging them off its top edge. */
const BAR_TOP = -0.005;

const s = (v: string): Arg => ({ s: v, n: null, str: true });
const word = (v: string): Arg => ({ s: v, n: null, str: false });
const num = (v: number): Arg => ({ s: String(v), n: v, str: false });
const prop = (key: string, ...args: Arg[]): FdfProp => ({ key, args });

/** The four panels the button bar opens — the same ones F9…F12 open. */
export type TopBarPanel = "quests" | "menu" | "allies" | "chat";

const BUTTONS: Array<{ frame: string; panel: TopBarPanel }> = [
  { frame: "UpperButtonBarQuestsButton", panel: "quests" },
  { frame: "UpperButtonBarMenuButton", panel: "menu" },
  { frame: "UpperButtonBarAlliesButton", panel: "allies" },
  { frame: "UpperButtonBarChatButton", panel: "chat" },
];

export interface TopBarActions {
  openPanel(panel: TopBarPanel): void;
}

/** What the resource readout shows. Formatted by the caller — the bar only places it. */
export interface TopBarResources {
  gold: string;
  lumber: string;
  supply: string;
  upkeep: string;
  /** Upkeep's colour band (WC3 turns the label orange at low, red at high upkeep). */
  upkeepColor: string;
}

export class TopBar {
  private screen: FdfScreen | null = null;
  private mounting = false;
  private shown = true;
  private last: TopBarResources | null = null;

  /** `skin` is the war3skins.txt section the chrome is decorated from — the console art and
   *  the button atlas are per-RACE (`orc-console-buttonstates2.blp`, `OrcUITile01`). */
  constructor(
    private container: HTMLElement,
    private vfs: DataSource,
    private skin: string,
    private actions: TopBarActions,
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
  update(next: TopBarResources): void {
    const prev = this.last;
    if (prev && prev.gold === next.gold && prev.lumber === next.lumber
      && prev.supply === next.supply && prev.upkeep === next.upkeep
      && prev.upkeepColor === next.upkeepColor) return;
    this.last = next;
    this.paint();
  }

  private paint(): void {
    const screen = this.screen;
    const r = this.last;
    if (!screen || !r) return;
    screen.setText("ResourceBarGoldText", r.gold);
    screen.setText("ResourceBarLumberText", r.lumber);
    screen.setText("ResourceBarSupplyText", r.supply);
    screen.setText("ResourceBarUpkeepText", r.upkeep);
    const upkeep = screen.frame("ResourceBarUpkeepText")?.querySelector("span");
    if (upkeep) upkeep.style.color = r.upkeepColor;
  }

  dispose(): void {
    this.screen?.dispose();
    this.screen = null;
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
        // Centred at the root's own 0.8×0.6, so the strip keeps the proportions it was drawn
        // at and the leftover width falls away either side (see rootFrame).
        centerRoot: true,
        buildRoot: (lib) => this.rootFrame(lib),
        handlers,
        onBuild: () => this.paint(), // a resize rebuilds the DOM; put the numbers back
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
   * The strip: `ConsoleUI`'s TOP textures only, plus the two bars anchored to the screen's
   * corners.
   *
   * Only the top ones — the same frame carries the console's BOTTOM edge, and the HUD already
   * draws that (its minimap and command card are positioned against it). They are told apart
   * by their own anchors, which is the file's own distinction rather than a guess about order.
   */
  private rootFrame(lib: FdfLibrary): FdfFrame {
    const console = lib.resolveRoot("ConsoleUI");
    if (!console) throw new Error('FDF: frame "ConsoleUI" not found');
    const children = console.children.filter((c) => {
      const anchor = c.props.find((p) => p.key === "Anchor")?.args[0]?.s ?? "";
      return anchor === "TOPLEFT" || anchor === "TOPRIGHT";
    });

    const bar = (name: string, point: "TOPLEFT" | "TOPRIGHT", dx: number): void => {
      const frame = lib.resolveRoot(name);
      if (!frame) return;
      children.push({
        ...frame,
        props: [
          ...frame.props.filter((p) => p.key !== "SetPoint"),
          prop("SetPoint", word(point), s("ConsoleUI"), word(point), num(dx), num(BAR_TOP)),
        ],
      });
    };
    bar("UpperButtonBarFrame", "TOPLEFT", 0);
    bar("ResourceBarFrame", "TOPRIGHT", 0);

    // Give the strip the 4:3 box the file was authored for, CENTRED, rather than letting it
    // fill the viewport. The rest of the FDF layer deliberately stretches to the screen's
    // edges (fdf/layout.ts fitBox), and that is right for a menu; it is wrong here, because
    // this art does not tile — pulling the two runs apart to the screen's corners opens a
    // hole in the middle that nothing in the file is meant to cover. Held at its own
    // proportions it simply sits centred, with empty space either side, and the gap between
    // the runs comes out exactly the width of the medallion that hangs in it.
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
}
