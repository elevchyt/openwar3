// THE REPLAY PANEL (issue #158) — a watcher's controls over a replay, inside the observer HUD
// (issue #168, ui/observerHud.ts), where Auto Camera used to stand on its own.
//
// What the game's own panel is made of is the reference (`UI\FrameDef\UI\ReplayPanel.fdf`): the
// four transport icons war3skins names (`ReplayPauseIcon` BTNReplay-Pause, `ReplaySpeedUpIcon`,
// `ReplaySpeedDownIcon`, `ReplayRestartIcon` BTNReplay-Loop), their GlobalStrings tooltips
// (`REPLAY_TOOLTIP_*`), the progress bar (`SimpleBuildTimeIndicator`, the build bar), the
// `ELAPSED_TIME` / `REPLAY_SPEED_AT` / `SPEED` line, and the two checkboxes (`FOG_OF_WAR`,
// `REPLAY_CAMERA`) in the EscMenu checkbox art. WHERE it stands is not the game's: 1.30.4 parks
// it over the command card, the one container a watcher's HUD keeps for the selection, so it is
// compact and sits above that instead — and it does one thing the original never could, which is
// go BACK in time (game/replay.ts; a seek backward re-plays the match up to the moment asked for).
//
// The layout is the developer's pick of three (issue #158): ONE panel above the selection, its
// width — the transport row, the timeline with the time on it, and the two checkboxes.

import type { HudDriver } from "./hud";
import { setGameTip } from "./gameTip";

/** "mm:ss", or "h:mm:ss" past the hour — the observer HUD's match clock (ui/observerHud.ts
 *  `clock`), restated rather than imported because that module builds this one. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
}

/** What the panel reads and drives — the scene's (render/mapViewer.ts). */
export interface ReplayControls {
  /** Where the replay is: steps played, steps in all, paused, the speed multiplier, a seek under
   *  way (its target step), and the first step that failed its state check. */
  state(): { tick: number; total: number; paused: boolean; speed: number; seeking: number | null; diverged: number | null };
  setPaused(on: boolean): void;
  setSpeed(mult: number): void;
  /** Go to a step — forward or BACK. */
  seek(tick: number): void;
  fog(): boolean;
  setFog(on: boolean): void;
}

/** Replay speeds, slowest first. WC3's own panel reads "at 1x Speed"; the rungs are ours. */
export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16] as const;

/** Steps per second of game time (render/mapViewer.ts SIM_HZ). */
const HZ = 60;

/** How far the skip buttons jump, in game seconds. Ours. */
const SKIP_SECONDS = 15;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
};

function speedLabel(mult: number): string {
  return mult >= 1 ? `${mult}x` : `1/${Math.round(1 / mult)}x`;
}

/**
 * The panel. Built once by the observer HUD and refreshed with it; it adopts the Auto Camera
 * checkbox the HUD already had and builds the Fog of War one beside it, in the same art.
 */
export class ReplayPanel {
  readonly root: HTMLDivElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly slowerBtn: HTMLButtonElement;
  private readonly fasterBtn: HTMLButtonElement;
  private readonly track: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly seekMark: HTMLDivElement;
  private readonly trackText: HTMLSpanElement;
  private readonly speedText: HTMLSpanElement;
  private readonly fogBox: { check: HTMLElement };
  private dragging = false;

  constructor(
    parent: HTMLElement,
    private readonly driver: HudDriver,
    private readonly controls: ReplayControls,
    autoCamera: HTMLElement,
  ) {
    const d = driver;
    this.root = el("div", "rp obs-panel", parent);

    const icon = (key: string, cls: string, tip: string, onClick: () => void): HTMLButtonElement => {
      const b = el("button", `rp-btn ${cls}`);
      const url = d.blpUrl(d.skinPath(key));
      if (url) b.style.backgroundImage = `url(${url})`;
      setGameTip(b, tip);
      b.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        onClick();
      });
      b.oncontextmenu = (e) => e.preventDefault();
      return b;
    };
    const tip = (key: string, fallback: string): string => d.uiString(key, fallback);
    const state = (): ReturnType<ReplayControls["state"]> => controls.state();
    const skip = (secs: number): void => {
      const s = state();
      controls.seek(Math.max(0, Math.min(s.total, (s.seeking ?? s.tick) + secs * HZ)));
    };
    const stepSpeed = (dir: 1 | -1): void => {
      const i = REPLAY_SPEEDS.indexOf(state().speed as (typeof REPLAY_SPEEDS)[number]);
      const next = REPLAY_SPEEDS[Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, (i < 0 ? 2 : i) + dir))];
      controls.setSpeed(next);
    };

    this.pauseBtn = icon("ReplayPauseIcon", "rp-pause", tip("REPLAY_TOOLTIP_PAUSE", "Pause/Unpause replay (|Cfffed312Pause|R)"), () => controls.setPaused(!state().paused));
    this.slowerBtn = icon("ReplaySpeedDownIcon", "rp-slower", tip("REPLAY_TOOLTIP_SPEED_DOWN", "Decrease replay speed (|Cfffed312-|R)"), () => stepSpeed(-1));
    this.fasterBtn = icon("ReplaySpeedUpIcon", "rp-faster", tip("REPLAY_TOOLTIP_SPEED_UP", "Increase replay speed (|Cfffed312+|R)"), () => stepSpeed(1));
    const restart = icon("ReplayRestartIcon", "rp-restart", tip("REPLAY_TOOLTIP_RESTART", "Restart replay"), () => controls.seek(0));
    // Back and forward in time: the speed icons turned on their side (◀◀ / ▶▶) — the game has no
    // art for a seek, because it has no seek. The words are ours.
    const back = icon("ReplaySpeedUpIcon", "rp-back", `Back ${SKIP_SECONDS} seconds`, () => skip(-SKIP_SECONDS));
    const fwd = icon("ReplaySpeedUpIcon", "rp-fwd", `Forward ${SKIP_SECONDS} seconds`, () => skip(SKIP_SECONDS));

    // The timeline: the build bar, which is what the game's own replay panel draws.
    this.track = el("div", "rp-track obs-sel-bar");
    this.fill = el("div", "obs-bar-fill progress", this.track);
    this.seekMark = el("div", "rp-seek-mark", this.track);
    this.trackText = el("span", "obs-sel-bar-text rp-track-text", this.track);
    const at = (e: PointerEvent): number => {
      const r = this.track.getBoundingClientRect();
      return Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))) * state().total);
    };
    this.track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.dragging = true;
      this.track.setPointerCapture?.(e.pointerId);
      this.seekMark.style.left = `${(at(e) / Math.max(1, state().total)) * 100}%`;
      this.seekMark.hidden = false;
    });
    this.track.addEventListener("pointermove", (e) => {
      const t = at(e);
      setGameTip(this.track, clock(t / HZ));
      if (this.dragging) this.seekMark.style.left = `${(t / Math.max(1, state().total)) * 100}%`;
    });
    this.track.addEventListener("pointerup", (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      controls.seek(at(e));
    });

    // The two checkboxes, Auto Camera adopted as the HUD built it and Fog of War its twin.
    const fog = this.checkbox(tip("FOG_OF_WAR", "Fog of War"), () => controls.fog(), (on) => controls.setFog(on));
    // …sized exactly as its twin: the HUD hands Auto Camera its box, gap and type as variables.
    for (const v of ["--autocam-box", "--autocam-gap", "--autocam-font"]) fog.root.style.setProperty(v, autoCamera.style.getPropertyValue(v));
    this.fogBox = fog;
    autoCamera.classList.add("rp-autocam");
    const checks = el("div", "rp-checks");
    checks.append(fog.root, autoCamera);

    const row = el("div", "rp-row", this.root);
    row.append(restart, back, this.pauseBtn, fwd, this.slowerBtn, this.fasterBtn);
    this.speedText = el("span", "rp-speed", row);
    this.root.append(this.track, checks);
    this.refresh();
  }

  /** A checkbox in the EscMenu art Auto Camera wears (`ReplayCheckBox*`), the label part of it. */
  private checkbox(label: string, on: () => boolean, set: (on: boolean) => void): { root: HTMLElement; check: HTMLElement } {
    const d = this.driver;
    const root = el("div", "hud-autocam rp-check");
    const box = el("button", "hud-autocam-box hud-iconbtn", root);
    const check = el("div", "hud-autocam-check", box);
    const text = el("span", "hud-autocam-label", root);
    text.textContent = label;
    const face = d.blpUrl(d.skinPath("ReplayCheckBoxNormal"));
    if (face) box.style.backgroundImage = `url(${face})`;
    const tick = d.blpUrl(d.skinPath("ReplayCheckBoxCheck"));
    if (tick) check.style.backgroundImage = `url(${tick})`;
    const toggle = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      e.preventDefault();
      set(!on());
      check.hidden = !on();
    };
    box.addEventListener("pointerdown", toggle);
    text.addEventListener("pointerdown", toggle);
    check.hidden = !on();
    return { root, check };
  }

  /** Once a frame, with the rest of the HUD. */
  refresh(): void {
    const s = this.controls.state();
    const total = Math.max(1, s.total);
    const shown = s.seeking ?? s.tick;
    this.fill.style.width = `${Math.min(100, (s.tick / total) * 100)}%`;
    if (!this.dragging) {
      this.seekMark.hidden = s.seeking === null;
      if (s.seeking !== null) this.seekMark.style.left = `${(s.seeking / total) * 100}%`;
    }
    const time = `${clock(shown / HZ)} / ${clock(total / HZ)}`;
    const speed = speedLabel(s.speed);
    const seeking = s.seeking !== null ? (s.seeking < s.tick ? "Rewinding…" : "Skipping…") : null;
    this.root.classList.toggle("paused", s.paused);
    this.root.classList.toggle("diverged", s.diverged !== null);
    this.pauseBtn.classList.toggle("on", s.paused);
    this.slowerBtn.disabled = s.speed <= REPLAY_SPEEDS[0];
    this.fasterBtn.disabled = s.speed >= REPLAY_SPEEDS[REPLAY_SPEEDS.length - 1];
    this.fogBox.check.hidden = !this.controls.fog();
    this.trackText.textContent = seeking ?? time;
    this.speedText.textContent = `${this.driver.uiString("REPLAY_SPEED_AT", "at ").trim()} ${speed}`;
    if (s.diverged !== null) setGameTip(this.root, `This replay stopped matching the recording at ${clock(s.diverged / HZ)}.`);
  }

  dispose(): void {
    this.root.remove();
  }
}
