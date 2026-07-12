// The script's timer dialogs — the countdown windows (Phase 7.21 — issue #33; see docs/triggers.md).
//
// The little panel WC3 hangs top-right: "Build Town Hall  1:59", "Next Level  0:23". The
// natives live in src/jass/natives/timerdialog.ts; this is the panel.
//
// The chrome is the GAME'S OWN — `UI\FrameDef\UI\TimerDialog.fdf` declares the whole frame,
// and unlike the leaderboard it needs nothing injected: the title and the time are already
// TEXT frames in the file, so we only override their strings.
//
//     Frame "FRAME" "TimerDialog" {  Width 0.17f,  Height 0.03f,
//         Frame "BACKDROP" "TimerDialogBackdrop" { … DecorateFileNames … }
//         Frame "TEXT" "TimerDialogValue" { FontJustificationH JUSTIFYRIGHT, Text "00:00:00", }
//         Frame "TEXT" "TimerDialogTitle" { FontJustificationH JUSTIFYLEFT,  Text "DEFAULTTIMERDIALOGTEXT", } }
//
// Two things the file can't tell us, and the game decides at runtime:
//   • WHERE it sits — the frame carries no SetPoint (CGameUI places it). WC3 puts it
//     top-right under the resource bar, below the leaderboard when there is one.
//   • That there can be SEVERAL. A map can display more than one at once (a wave timer and
//     a hero-revive timer), so we clone the frame per displayed dialog and stack them.
//
// The TIME is not pushed, it is polled: a timerdialog holds no clock of its own, it reads
// the timer it was created over. So the panel is rebuilt only when the set of dialogs or
// their titles change (revision), and every frame we just re-stamp the value text.

import type { TimerDialogObj } from "../jass/runtime";
import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame } from "./fdf/parser";
import { numProp, type FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";

const TIMER_FDF = "UI\\FrameDef\\UI\\TimerDialog.fdf";

// FDF 0.8×0.6 world units.
const MARGIN_X = 0.006; // gap from the right edge — matches the leaderboard's
const MARGIN_Y = 0.052; // gap from the top: clears the resource bar, as in WC3
const GAP = 0.004; // between stacked windows

const s = (v: string): Arg => ({ s: v, n: null, str: true });
const word = (v: string): Arg => ({ s: v, n: null, str: false });
const num = (v: number): Arg => ({ s: String(v), n: v, str: false });

/** Format a countdown the way the engine does. Warcraft III's `Game.dll` carries exactly
 *  two countdown formats — `%d:%02d` and `%02d:%02d:%02d` — so a timer under an hour reads
 *  `1:59` (unpadded minutes) and one at or over an hour reads `01:02:03`. Seconds round UP,
 *  which is why a fresh 120 s timer shows "2:00" rather than flicking straight to "1:59". */
export function formatTimerValue(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** 0xAARRGGBB → a CSS colour (the natives take r/g/b/a 0–255). */
function cssColor(argb: number): string {
  const a = ((argb >>> 24) & 0xff) / 255;
  return `rgba(${(argb >>> 16) & 0xff}, ${(argb >>> 8) & 0xff}, ${argb & 0xff}, ${a})`;
}

export class TimerDialogOverlay {
  private screen: FdfScreen | null = null;
  private mounting = false;
  /** What we last built for — the displayed dialogs and their revisions. */
  private builtFor = "";
  private shown: TimerDialogObj[] = [];
  /** The value <div>s, in the same order as `shown`, so the per-frame tick is a lookup. */
  private valueEls: HTMLElement[] = [];

  private readonly onResize = (): void => {
    this.bindElements();
  };

  /** `skin` is the war3skins.txt section the chrome is decorated from — the local player's
   *  race, as with every other in-game panel. */
  constructor(private container: HTMLElement, private vfs: DataSource, private skin: string) {
    window.addEventListener("resize", this.onResize);
  }

  /** Poll, every frame. `topOffset` pushes the stack down past whatever already occupies
   *  the top-right corner (the leaderboard), so the two never overlap — as in WC3. */
  update(dialogs: ReadonlyArray<TimerDialogObj>, secondsOf: (td: TimerDialogObj) => number, topOffset = 0): void {
    const shown = dialogs.filter((d) => d.displayed);
    const key = shown.map((d) => `${d.handleId}:${d.revision}`).join("|") + `@${topOffset.toFixed(4)}`;
    if (key !== this.builtFor && !this.mounting) {
      this.builtFor = key;
      if (!shown.length) this.teardown();
      else void this.build(shown, topOffset);
    }
    // The time itself is re-stamped every frame regardless — it is read live off the timer,
    // and a rebuild would be absurd once a second.
    for (let i = 0; i < this.valueEls.length && i < this.shown.length; i++) {
      const text = formatTimerValue(secondsOf(this.shown[i]));
      if (this.valueEls[i].textContent !== text) this.valueEls[i].textContent = text;
    }
  }

  private teardown(): void {
    this.screen?.dispose();
    this.screen = null;
    this.shown = [];
    this.valueEls = [];
  }

  private async build(shown: TimerDialogObj[], topOffset: number): Promise<void> {
    this.mounting = true;
    try {
      const overrides: Record<string, string> = {};
      shown.forEach((d, i) => {
        overrides[`TimerDialogTitle${i}`] = d.title;
        overrides[`TimerDialogValue${i}`] = formatTimerValue(0); // re-stamped immediately below
      });
      const prev = this.screen;
      this.screen = await mountFdfScreen({
        container: this.container,
        vfs: this.vfs,
        fdfPath: TIMER_FDF,
        rootFrame: "TimerDialog",
        overlayClass: "fdf-ingame",
        skin: this.skin,
        buildRoot: (lib) => this.rootFrame(lib, shown, topOffset),
        textOverrides: overrides,
      });
      prev?.dispose(); // swap only once the new stack is up, so the windows never blink
      this.shown = shown;
      this.bindElements();
      this.applyColors(shown);
    } catch (err) {
      console.warn("[timerDialog] could not mount the FDF panel:", err);
      this.screen = null;
      this.shown = [];
      this.valueEls = [];
    } finally {
      this.mounting = false;
    }
  }

  /** One clone of the game's TimerDialog frame per displayed dialog, stacked down the
   *  top-right corner. */
  private rootFrame(lib: FdfLibrary, shown: TimerDialogObj[], topOffset: number): FdfFrame {
    const base = lib.resolveRoot("TimerDialog");
    if (!base) throw new Error("FDF: frame \"TimerDialog\" not found");
    const height = numProp(base, "Height") ?? 0.03;
    const width = numProp(base, "Width") ?? 0.17;

    const children = shown.map((_, i) => {
      const clone = sizeText(renameFrame(base, i), i, width);
      // FDF y is UP, so stacking downward means increasingly negative offsets.
      const dy = -(MARGIN_Y + topOffset + i * (height + GAP));
      clone.props = [
        ...clone.props.filter((p) => p.key !== "SetPoint"),
        { key: "SetPoint", args: [word("TOPRIGHT"), s("TimerDialogRoot"), word("TOPRIGHT"), num(-MARGIN_X), num(dy)] },
      ];
      return clone;
    });

    return { type: "FRAME", name: "TimerDialogRoot", inherits: null, withChildren: false, props: [], children };
  }

  private bindElements(): void {
    const root = this.screen?.element;
    this.valueEls = root
      ? this.shown.map((_, i) => root.querySelector<HTMLElement>(`[data-frame="TimerDialogValue${i}"]`)).filter((e): e is HTMLElement => !!e)
      : [];
  }

  /** TimerDialogSetTitleColor / SetTimeColor. Only applied when the script actually set one
   *  — otherwise the FDF's own font colour (which is the game's) must stand. */
  private applyColors(shown: TimerDialogObj[]): void {
    const root = this.screen?.element;
    if (!root) return;
    shown.forEach((d, i) => {
      if (d.titleColor !== null) {
        const el = root.querySelector<HTMLElement>(`[data-frame="TimerDialogTitle${i}"]`);
        if (el) el.style.color = cssColor(d.titleColor);
      }
      if (d.timeColor !== null) {
        const el = root.querySelector<HTMLElement>(`[data-frame="TimerDialogValue${i}"]`);
        if (el) el.style.color = cssColor(d.timeColor);
      }
    });
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.teardown();
  }
}

/** Give the two TEXT frames a real box.
 *
 *  Same trap the leaderboard's title fell into: in WC3 a TEXT frame is one line tall and
 *  sized to its anchors, and neither of these carries a Height. Worse, the FDF sizes the
 *  TITLE purely by *two opposing anchors* (`SetPoint LEFT, "TimerDialogBackdrop", …` +
 *  `SetPoint RIGHT, "TimerDialogValue", …`), which our layout solver doesn't derive a width
 *  from — so the title collapsed to a 0×0 box and simply never drew, while the value (which
 *  does declare `Width 0.06`) rendered fine. That's exactly what the first live run showed:
 *  a window counting down "1:43" with no "Build Town Hall" beside it.
 *
 *  So: pin the title to the backdrop's LEFT and give it the width the two anchors imply
 *  (the window, less the value's column and both insets), and give both a one-line height.
 *  A LEFT/RIGHT anchor is mid-height, so they stay vertically centred, as the file intends. */
function sizeText(f: FdfFrame, i: number, width: number): FdfFrame {
  const LINE = 0.014; // one line of the templates' 0.011 FrameFont, plus leading
  const INSET = 0.01; // the file's own left/right inset
  const VALUE_W = 0.06; // TimerDialogValue's declared Width
  const children = f.children.map((c) => {
    if (c.name === `TimerDialogValue${i}`) {
      return { ...c, props: [...c.props.filter((p) => p.key !== "Height"), { key: "Height", args: [num(LINE)] }] };
    }
    if (c.name === `TimerDialogTitle${i}`) {
      return {
        ...c,
        props: [
          ...c.props.filter((p) => p.key !== "SetPoint" && p.key !== "Width" && p.key !== "Height"),
          { key: "SetPoint", args: [word("LEFT"), s(`TimerDialogBackdrop${i}`), word("LEFT"), num(INSET), num(0)] },
          { key: "Width", args: [num(Math.max(0.02, width - VALUE_W - 2 * INSET))] },
          { key: "Height", args: [num(LINE)] },
        ],
      };
    }
    return c;
  });
  return { ...f, children };
}

/** Clone a frame subtree under a per-instance suffix. The layout solver indexes frames by
 *  name across the whole screen, so two stacked windows sharing a child name would collide —
 *  and TimerDialog's children anchor to each OTHER by name (`SetPoint RIGHT,
 *  "TimerDialogValue", …`), so the relative-frame argument has to be rewritten too, not just
 *  the frame's own name. Miss that and every window's text would pin to the first window's. */
function renameFrame(f: FdfFrame, i: number): FdfFrame {
  const names = new Set<string>();
  const collect = (src: FdfFrame): void => {
    if (src.name) names.add(src.name);
    src.children.forEach(collect);
  };
  collect(f);
  const rename = (name: string): string => (names.has(name) ? `${name}${i}` : name);
  const walk = (src: FdfFrame): FdfFrame => ({
    ...src,
    name: rename(src.name),
    props: src.props.map((p) =>
      // SetPoint <point> "<relativeFrame>" <relativePoint> <x> <y> — arg 1 names a sibling.
      p.key === "SetPoint" && p.args[1]?.str ? { key: p.key, args: p.args.map((a, j) => (j === 1 ? s(rename(a.s)) : a)) } : { key: p.key, args: p.args.slice() },
    ),
    children: src.children.map(walk),
  });
  return walk(f);
}
