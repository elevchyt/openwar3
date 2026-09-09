// What the desktop app remembers between launches. One small JSON file in Electron's own
// per-user directory — not localStorage, which belongs to a page and would be lost the day the
// app is served from a different port.
//
// Deliberately tiny and deliberately not a settings SYSTEM: the game's own options already have
// a home (src/data/options.ts, in the page's storage where the game can read them). This is only
// for what the SHELL needs to know before there is a page at all, which today is one thing —
// where the player's Warcraft III folder is.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

let file = null;

/** Point the store at Electron's `userData`. Called once, after `app` is ready. */
export function useSettingsDir(dir) {
  file = join(dir, "settings.json");
}

export function readSettings() {
  if (!file) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // absent, or written by a version that wrote something else
  }
}

export function writeSettings(patch) {
  if (!file) return;
  const next = { ...readSettings(), ...patch };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch (err) {
    console.warn("[OpenWar3] could not save settings:", err?.message ?? err);
  }
  return next;
}
