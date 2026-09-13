"use client";

import { useEffect } from "react";

// The glue screens answer to a letter as well as a click (MainMenu.fdf `ControlShortcutKey`),
// so the page does too: pressing a button's marked letter clicks it. A modifier, or focus in
// something you can type into, leaves the key alone.
export function Hotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.key.length !== 1) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const el = document.querySelector<HTMLElement>(`[data-hotkey="${CSS.escape(e.key.toLowerCase())}"]`);
      if (!el) return;
      e.preventDefault();
      el.classList.add("is-pressed");
      window.setTimeout(() => {
        el.classList.remove("is-pressed");
        el.click();
      }, 110);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
