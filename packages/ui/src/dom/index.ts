// The kit's vanilla-DOM binding, for pages that are not React — the game itself (src/ui/gate.ts).
// Each builder returns the same markup the React components in ../react render, so one stylesheet
// (../ui.css) dresses both; nothing here styles anything.

/** A glue button's caption with its hotkey picked out. The game writes the colour into the string
 *  itself — GlobalStrings.fdf `KEY_SINGLE_PLAYER "|CffffffffS|Ringle Player"` — so the shortcut
 *  letter is WHITE inside a gold caption. The first occurrence of the letter is the one marked. */
export function hotkeyLabel(target: HTMLElement, text: string, hotkey?: string): void {
  target.replaceChildren();
  const i = hotkey ? text.toLowerCase().indexOf(hotkey.toLowerCase()) : -1;
  if (i < 0) {
    target.textContent = text;
    return;
  }
  const hk = document.createElement("span");
  hk.className = "ow3-hk";
  hk.textContent = text[i];
  target.append(text.slice(0, i), hk, text.slice(i + 1));
}

export interface GlueButtonOptions {
  label: string;
  /** Pressing this letter clicks the button (see `bindHotkeys`). */
  hotkey?: string;
  /** The grey-rimmed variant (GlueScreen-Button1-BorderedBackdropBorder). */
  bordered?: boolean;
  size?: "md" | "lg";
  /** A second, smaller line under the caption. */
  sub?: string;
  onClick?: () => void;
}

export interface GlueButton {
  /** The wrapper — put this in the page. */
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
  setLabel(label: string): void;
  setDisabled(disabled: boolean): void;
}

export function createGlueButton(opts: GlueButtonOptions): GlueButton {
  const wrap = document.createElement("span");
  wrap.className = "ow3-glue-btn-wrap";
  const button = document.createElement("button");
  button.type = "button";
  button.className = ["ow3-glue-btn", `ow3-glue-btn--${opts.size ?? "md"}`, opts.bordered ? "ow3-glue-btn--bordered" : ""]
    .filter(Boolean)
    .join(" ");
  const glow = document.createElement("span");
  glow.className = "ow3-glue-btn__glow";
  glow.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "ow3-glue-btn__text";
  const caption = document.createElement("span");
  caption.className = "ow3-glue-btn__caption";
  const label = document.createElement("span");
  label.className = "ow3-glue-btn__label";
  caption.append(label);
  if (opts.sub) {
    const sub = document.createElement("span");
    sub.className = "ow3-glue-btn__sub";
    sub.textContent = opts.sub;
    caption.append(sub);
  }
  text.append(caption);
  button.append(glow, text);
  wrap.append(button);

  let current = opts.label;
  let disabled = false;
  const paint = (): void => {
    // A dead button answers to no letter, so it marks none either.
    hotkeyLabel(label, current, disabled ? undefined : opts.hotkey);
    if (opts.hotkey && !disabled) button.dataset.hotkey = opts.hotkey.toLowerCase();
    else delete button.dataset.hotkey;
  };
  paint();
  if (opts.onClick) button.addEventListener("click", () => { if (!disabled) opts.onClick?.(); });

  return {
    root: wrap,
    button,
    setLabel(next) {
      current = next;
      paint();
    },
    setDisabled(next) {
      disabled = next;
      button.disabled = next;
      button.classList.toggle("is-disabled", next);
      paint();
    },
  };
}

/** The Human options-menu backdrop: stone frame, gold rule, blue marble. */
export function createPanel(tag: "div" | "section" | "article" = "div", className?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = ["ow3-panel", className].filter(Boolean).join(" ");
  return el;
}

export interface ProgressBar {
  readonly root: HTMLElement;
  /** 0…1, or null for a stage whose size is not known yet (the head sweeps the hole). */
  set(fraction: number | null): void;
  /** The line under the bar; empty hides it. */
  setLabel(text: string): void;
}

/** The loading screen's bar (LoadBar.mdx), in the kit's own frame. */
export function createProgressBar(opts: { scale?: number; label?: string } = {}): ProgressBar {
  const root = document.createElement("div");
  root.className = "ow3-progress-wrap";
  const bar = document.createElement("div");
  bar.className = "ow3-progress";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  if (opts.scale) bar.style.setProperty("--ow3-progress-scale", String(opts.scale));
  const track = document.createElement("div");
  track.className = "ow3-progress__track";
  for (const part of ["fill", "glow", "glass"]) {
    const el = document.createElement("div");
    el.className = `ow3-progress__${part}`;
    track.append(el);
  }
  bar.append(track);
  const label = document.createElement("span");
  label.className = "ow3-progress__label";
  root.append(bar, label);

  const api: ProgressBar = {
    root,
    set(fraction) {
      if (fraction === null) {
        bar.classList.add("is-indeterminate");
        bar.removeAttribute("aria-valuenow");
        return;
      }
      const f = Math.min(1, Math.max(0, fraction));
      bar.classList.remove("is-indeterminate");
      bar.style.setProperty("--ow3-progress", String(f));
      bar.setAttribute("aria-valuenow", String(Math.round(f * 100)));
      bar.toggleAttribute("data-empty", f === 0);
    },
    setLabel(text) {
      label.textContent = text;
      label.hidden = !text;
    },
  };
  api.set(0);
  api.setLabel(opts.label ?? "");
  return api;
}

/** The glue screens answer to a letter as well as a click (MainMenu.fdf `ControlShortcutKey`):
 *  pressing a live button's marked letter under `root` presses it. A modifier, or focus in
 *  something you can type into, leaves the key alone. Returns the unbinder. */
export function bindHotkeys(root: ParentNode = document): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.key.length !== 1) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const el = root.querySelector<HTMLElement>(`[data-hotkey="${CSS.escape(e.key.toLowerCase())}"]`);
    if (!el) return;
    e.preventDefault();
    pressAndClick(el);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/** Show the Down art for a beat, then click — so a key press looks like a mouse press. */
export function pressAndClick(el: HTMLElement): void {
  el.classList.add("is-pressed");
  window.setTimeout(() => {
    el.classList.remove("is-pressed");
    el.click();
  }, 110);
}
