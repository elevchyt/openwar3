// Finding the player's Warcraft III folder without asking — the desktop app's first guess,
// tried before the load gate puts up the folder picker (src/ui/gate.ts), which stays the
// fallback for everything this cannot find.
//
// **The strongest clue is where WE are.** The Windows installer (build/installer.nsh) will only
// install into a 1.30.4 folder and puts the app in an `OpenWar3` folder INSIDE it, so a packaged
// Windows app's own executable sits at `<Warcraft III>\OpenWar3\OpenWar3.exe` and the install is
// its grandparent. The same holds for an AppImage a player drops into (or beside) their game
// folder, which is why this is not a Windows-only rule.
//
// After that come the places Blizzard's own installers wrote the folder down. None of them is
// trusted: every candidate goes through `looksLikeInstall`, the same 1.30.4 check the picker and
// every launch ask, so a stale registry value or a patched folder is simply the next candidate.

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { looksLikeInstall } from "./install.mjs";

/** Registry values that hold a Warcraft III folder. `InstallPath` is the classic CD installer's
 *  and the Battle.net launcher kept writing it; `InstallLocation` is the uninstall entry the
 *  launcher registers. HKLM is listed under both views because a 32-bit launcher on 64-bit
 *  Windows wrote into `WOW6432Node`, and reg.exe run from a 32-bit app sees only its own view
 *  unless the path names the other one. */
const REGISTRY = [
  ["HKCU\\Software\\Blizzard Entertainment\\Warcraft III", "InstallPath"],
  ["HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\Warcraft III", "InstallPath"],
  ["HKLM\\SOFTWARE\\Blizzard Entertainment\\Warcraft III", "InstallPath"],
  ["HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Warcraft III", "InstallLocation"],
  ["HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Warcraft III", "InstallLocation"],
];

/** One registry value, or null. `reg.exe` rather than a native module: it is on every Windows
 *  since XP, and a native addon would have to be built twice for the two architectures the
 *  installer carries. Bounded, because a hung query must not hold the window back. */
function readRegistry(key, value) {
  return new Promise((resolve) => {
    execFile("reg", ["query", key, "/v", value], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      // `    InstallPath    REG_SZ    C:\Program Files (x86)\Warcraft III`
      const line = stdout.split(/\r?\n/).find((l) => l.trim().toLowerCase().startsWith(value.toLowerCase()));
      const match = line && /REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line.trim());
      resolve(match ? match[1].trim().replace(/[\\/]+$/, "") : null);
    });
  });
}

/** The folders the packaged app itself lives in: `<install>\OpenWar3\OpenWar3.exe` names both the
 *  app folder and its parent. On Linux the executable is inside the AppImage's own mount, so the
 *  AppImage FILE's folder is the one that means anything (`APPIMAGE`, set by its runtime). */
function besideTheApp(execPath, env) {
  const exeDir = env.APPIMAGE ? dirname(env.APPIMAGE) : dirname(execPath);
  return [dirname(exeDir), exeDir];
}

/** Where a default install lands. `ProgramFiles(x86)` is absent on 32-bit Windows, where the
 *  launcher's folder is plain `Program Files`. */
function defaultFolders(env) {
  return [env["ProgramFiles(x86)"], env.ProgramFiles, env.ProgramW6432]
    .filter(Boolean)
    .map((root) => join(root, "Warcraft III"));
}

/**
 * The first folder that IS a 1.30.4 install, or null.
 *
 * `packaged` gates the look beside the executable: an unpackaged `pnpm app` runs Electron out of
 * `node_modules`, whose grandparent is nothing to do with Warcraft III.
 */
export async function detectInstall({ packaged, execPath = process.execPath, env = process.env, platform = process.platform } = {}) {
  const tried = new Set();
  const found = (path) => {
    if (!path || tried.has(path)) return false;
    tried.add(path);
    return looksLikeInstall(path);
  };

  for (const path of packaged ? besideTheApp(execPath, env) : []) if (found(path)) return path;
  if (platform !== "win32") return null;

  const fromRegistry = await Promise.all(REGISTRY.map(([key, value]) => readRegistry(key, value)));
  for (const path of fromRegistry) if (found(path)) return path;
  for (const path of defaultFolders(env)) if (found(path)) return path;
  return null;
}
