// The REPLAY folder's one writer (issue #158, src/game/replay.ts) — used by the desktop shell
// (`<userData>/replays/`) and by the dev server (the repo's `.replays/`), so the rules live in
// one place, as electron/logStore.mjs does for the match logs.
//
// The rules:
//   · every match that recorded leaves `LastReplay.o3r`, overwritten by the next one — WC3's
//     own `LastReplay.w3g` — and the player KEEPS one by saving it under a name;
//   · with Options → "Automatically Save Replays" on, every match is ALSO kept under its own name
//     in `Autosaved/`, the game's own `replay/autosaved` folder;
//   · a replay is never swept: unlike a match log, it is something the player chose to keep;
//   · the page names a FILE, never a path. A name is reduced to its last component and must end
//     in `.o3r`, so nothing the page sends can reach outside the folder.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

export const REPLAY_EXT = ".o3r";
export const LAST_REPLAY = "LastReplay" + REPLAY_EXT;
/** The game's own `replay/autosaved` folder (GlobalStrings AUTOSAVE_REPLAY_INFO). */
export const AUTOSAVED = "Autosaved";

/** A file name the page may use: its last path component, with characters no file system
 *  minds, ending in the replay extension. Null when nothing usable is left. */
export function safeReplayName(name) {
  let base = basename(String(name ?? "")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim();
  if (!base.toLowerCase().endsWith(REPLAY_EXT)) base += REPLAY_EXT;
  if (base === REPLAY_EXT || base.startsWith(".")) return null;
  return base.slice(0, 120);
}

export function createReplayStore(dir, opts = {}) {
  const warn = opts.warn ?? (() => {});
  const ensure = () => {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      warn(`cannot create ${dir}: ${err}`);
    }
  };
  return {
    dir,
    /** Write the match that just ended as the last replay. Written beside and then moved over,
     *  so a crash mid-write never leaves half a file where the last good one was. */
    saveLast(bytes, autosaveName) {
      ensure();
      const file = join(dir, LAST_REPLAY);
      const tmp = file + ".part";
      writeFileSync(tmp, bytes);
      renameSync(tmp, file);
      const keep = autosaveName ? safeReplayName(autosaveName) : null;
      if (keep) {
        mkdirSync(join(dir, AUTOSAVED), { recursive: true });
        writeFileSync(join(dir, AUTOSAVED, keep), bytes);
      }
      return LAST_REPLAY;
    },
    /** Keep the last replay under a name. Returns the name it was kept as, or null. */
    keepLast(name) {
      const safe = safeReplayName(name);
      const from = join(dir, LAST_REPLAY);
      if (!safe || !existsSync(from)) return null;
      copyFileSync(from, join(dir, safe));
      return safe;
    },
    /** Every replay in the folder, newest first. */
    list() {
      ensure();
      const out = [];
      const scan = (sub) => {
        const where = sub ? join(dir, sub) : dir;
        let names = [];
        try {
          names = readdirSync(where);
        } catch {
          return;
        }
        for (const name of names) {
          if (!name.toLowerCase().endsWith(REPLAY_EXT)) continue;
          try {
            const st = statSync(join(where, name));
            if (st.isFile()) out.push({ name: sub ? `${sub}/${name}` : name, size: st.size, mtime: st.mtimeMs });
          } catch {
            /* gone between the listing and the stat */
          }
        }
      };
      scan("");
      scan(AUTOSAVED);
      return out.sort((a, b) => b.mtime - a.mtime);
    },
    /** One replay's bytes, or null. */
    read(name) {
      const file = pathOf(name);
      if (!file) return null;
      try {
        return readFileSync(file);
      } catch {
        return null;
      }
    },
    /** Delete one replay (the Save Replay panel's Delete). True when it is gone. */
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

  /** A name the page sent, as a file in the folder or in its one subfolder (`Autosaved/`). */
  function pathOf(name) {
    const raw = String(name ?? "");
    const sub = raw.startsWith(AUTOSAVED + "/") ? AUTOSAVED : "";
    const safe = safeReplayName(sub ? raw.slice(AUTOSAVED.length + 1) : raw);
    if (!safe) return null;
    return sub ? join(dir, sub, safe) : join(dir, safe);
  }
}
