// OPENWAR3'S DATA FOLDER — `%APPDATA%\openwar3`, `~/.config/openwar3`, `~/Library/Application
// Support/openwar3` — holds OUR files at the top and nothing else (the developer's call):
//
//   settings.json   the shell's own settings (electron/settings.mjs)
//   .logs/          the match logs (electron/logStore.mjs, docs/match-log.md)
//   replays/        the replays (electron/replayStore.mjs, docs/replays.md)
//   Chromium/       everything the browser engine keeps — its caches, cookies, and the Local
//                   Storage / IndexedDB the page's own options, profiles and campaign saves live in
//
// Electron's `userData` IS Chromium's user-data directory, so by default the engine's ~25 entries
// sit beside ours. Pointing `userData` one folder down (`Chromium/`) before `ready` moves the
// whole engine there — browser-level files (`Local State`, `GPUCache`, `Crashpad`) as well as the
// session's — and the folder above it is left to us. `setPath("userData")` is only honoured
// before `ready`, which is why this runs at the very top of electron/main.mjs.
//
// An install made before this layout has the engine's files at the top. The first launch MOVES
// them into `Chromium/` — renames, the same volume — so the player keeps every option, profile and
// campaign save. A move that fails (a file held open by another copy of the game, a permission)
// is UNDONE, and that launch runs on the old layout; the next one tries again. Never half: Local
// Storage split between two folders would read as a player whose settings were wiped.

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";

/** The engine's own folder, inside ours. */
export const CHROMIUM_DIR = "Chromium";

/** What is OURS at the top of the data folder — everything else there belongs to the engine. */
const OURS = new Set(["settings.json", ".logs", "replays", CHROMIUM_DIR]);

/**
 * Point the engine at `<data>/Chromium` (moving an older install's files there first) and answer
 * the data folder our own files go in. Call before `ready` and before any other `getPath`.
 */
export function arrangeDataDir(app, { warn = () => {} } = {}) {
  const root = app.getPath("userData");
  const engine = join(root, CHROMIUM_DIR);
  if (!existsSync(engine) && !moveEngineFiles(root, engine, warn)) return root;
  app.setPath("userData", engine);
  // Crash dumps default to `<userData>/Crashpad` as it stood at start-up; say where they go.
  try {
    app.setPath("crashDumps", join(engine, "Crashpad"));
  } catch {
    /* an Electron that has no such path */
  }
  return root;
}

/** Move every entry that is not ours into `engine`. True when the engine folder is ready to use;
 *  false (everything put back) when any move failed. */
function moveEngineFiles(root, engine, warn) {
  let entries = [];
  try {
    entries = readdirSync(root).filter((name) => !OURS.has(name));
  } catch {
    // No data folder yet: a first launch. The engine makes its own folder as it starts.
    entries = [];
  }
  try {
    mkdirSync(engine, { recursive: true });
  } catch (err) {
    warn(`cannot create ${engine}: ${err}`);
    return false;
  }
  const moved = [];
  for (const name of entries) {
    try {
      renameSync(join(root, name), join(engine, name));
      moved.push(name);
    } catch (err) {
      warn(`cannot move ${name} into ${CHROMIUM_DIR}/ (${err?.code ?? err}); keeping the old layout this launch`);
      for (const back of moved.reverse()) {
        try {
          renameSync(join(engine, back), join(root, back));
        } catch (undo) {
          warn(`cannot move ${back} back: ${undo}`);
        }
      }
      try {
        rmdirSync(engine);
      } catch {
        /* not empty: something could not be moved back — the next launch sees the folder */
      }
      return false;
    }
  }
  return true;
}
