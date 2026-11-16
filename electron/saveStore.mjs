// The SAVED GAMES folder's one writer (issue #159, src/game/save/saveFile.ts, docs/save-games.md)
// — used by the desktop shell (`<data folder>/saves/`, beside `replays/`) and by the dev server
// (the repo's `.saves/`), so the rules live in one place, as electron/replayStore.mjs does for
// the replays.
//
// The rules:
//   · a saved game is a file the player NAMED (the game's own Save Game panel), or the one the
//     map's script named through `SaveGame` — never swept, never overwritten unasked (the panel
//     asks first, in the game's own words);
//   · a file is written beside and then moved over, so a crash mid-write never leaves half a
//     save where a good one was;
//   · the page names a FILE, never a path. A name is reduced to its last component and must end
//     in `.o3s`, so nothing the page sends can reach outside the folder.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

export const SAVE_EXT = ".o3s";

/** A file name the page may use: its last path component, with characters no file system
 *  minds, ending in the save extension. Null when nothing usable is left. */
export function safeSaveName(name) {
  let base = basename(String(name ?? "").replace(/\\/g, "/")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim();
  if (!base.toLowerCase().endsWith(SAVE_EXT)) base += SAVE_EXT;
  if (base === SAVE_EXT || base.startsWith(".")) return null;
  return base.slice(0, 120);
}

export function createSaveStore(dir, opts = {}) {
  const warn = opts.warn ?? (() => {});
  const ensure = () => {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      warn(`cannot create ${dir}: ${err}`);
    }
  };
  const pathOf = (name) => {
    const safe = safeSaveName(name);
    return safe ? join(dir, safe) : null;
  };
  return {
    dir,
    /** Write a saved game. Returns the name it was written as, or null. */
    write(name, bytes) {
      const file = pathOf(name);
      if (!file) return null;
      ensure();
      const tmp = file + ".part";
      writeFileSync(tmp, bytes);
      renameSync(tmp, file);
      return basename(file);
    },
    /** Every saved game in the folder, newest first. */
    list() {
      ensure();
      let names = [];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const out = [];
      for (const name of names) {
        if (!name.toLowerCase().endsWith(SAVE_EXT)) continue;
        try {
          const st = statSync(join(dir, name));
          if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* gone between the listing and the stat */
        }
      }
      return out.sort((a, b) => b.mtime - a.mtime);
    },
    /** One saved game's bytes, or null. */
    read(name) {
      const file = pathOf(name);
      if (!file) return null;
      try {
        return readFileSync(file);
      } catch {
        return null;
      }
    },
    exists(name) {
      const file = pathOf(name);
      return !!file && existsSync(file);
    },
    /** Delete one saved game (the panel's Delete). True when it is gone. */
    remove(name) {
      const file = pathOf(name);
      if (!file) return false;
      try {
        unlinkSync(file);
        return true;
      } catch {
        return false;
      }
    },
  };
}
