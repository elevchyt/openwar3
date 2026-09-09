// Checking the project's GitHub releases for a newer OpenWar3, fetching it, and restarting into
// it — the desktop app's own updater.
//
// The whole flow is the player's to refuse. `autoDownload` is OFF, so nothing is fetched until
// they say so, and nothing is INSTALLED until they say so again: a game that restarts itself
// under somebody mid-match is worse than one that is a version behind. What this file does is
// hold the state and let `main.mjs` put those two questions in front of them.
//
// The source is the repo's Releases page (`publish` in package.json). electron-builder writes
// `latest-linux.yml` / `latest.yml` beside each artifact when it publishes, and that file — not
// the tag list — is what the updater reads: a release with no such file is invisible to it,
// which is worth knowing the first time a hand-uploaded build appears not to exist.

import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

/** Nothing has been asked yet / nothing to do / the four states of an update in flight. */
const IDLE = { phase: "idle", version: null, percent: 0, error: null };

export function startUpdates({ onChange, log, fakeVersion = null } = {}) {
  let state = { ...IDLE };
  const set = (patch) => {
    state = { ...state, ...patch };
    onChange?.(state);
  };

  // A pretend update, for driving the two questions without publishing a release to ask them.
  // `main.mjs` passes this ONLY when the app is unpackaged, so a shipped build cannot be told by
  // an environment variable that there is a version it should fetch. It walks the same states the
  // real one does and stops short of the one thing it must not fake: replacing this build.
  if (fakeVersion) {
    setTimeout(() => set({ phase: "available", version: fakeVersion, error: null }), 400);
    return {
      get state() { return state; },
      check() { return Promise.resolve(); },
      download() {
        let percent = 0;
        const tick = setInterval(() => {
          percent += 20;
          if (percent >= 100) { clearInterval(tick); set({ phase: "ready", percent: 100 }); }
          else set({ phase: "downloading", percent });
        }, 300);
      },
      install() { set({ phase: "installing" }); log?.info?.("[OpenWar3] pretend update: not restarting"); },
    };
  }

  // Downloading is the player's decision, so the updater must not start on its own; installing
  // is a second decision, so it must not happen on quit either.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  if (log) autoUpdater.logger = log;

  autoUpdater.on("update-available", (info) => set({ phase: "available", version: info?.version ?? null, error: null }));
  autoUpdater.on("update-not-available", () => set({ phase: "none", version: null, error: null }));
  autoUpdater.on("download-progress", (p) => set({ phase: "downloading", percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on("update-downloaded", (info) => set({ phase: "ready", version: info?.version ?? state.version, percent: 100 }));
  autoUpdater.on("error", (err) => {
    // An update that cannot be checked for is not a reason to fail to START. No network, a rate
    // limit, a release with no metadata beside it — all of them end here, and all of them leave
    // a game that plays perfectly well at the version it already is.
    set({ phase: "error", error: String(err?.message ?? err) });
  });

  return {
    get state() { return state; },
    /** Ask GitHub. Safe to call when there is nothing to ask (an unpackaged app), where it does
     *  nothing rather than throwing about a missing `app-update.yml`. */
    check() {
      set({ phase: "checking", error: null });
      return autoUpdater.checkForUpdates().catch((err) => set({ phase: "error", error: String(err?.message ?? err) }));
    },
    download() {
      if (state.phase !== "available") return;
      set({ phase: "downloading", percent: 0 });
      return autoUpdater.downloadUpdate().catch((err) => set({ phase: "error", error: String(err?.message ?? err) }));
    },
    /** Replace this build and start the new one. Only ever reached from a player pressing Yes. */
    install() {
      if (state.phase !== "ready") return;
      // `isSilent` false, `isForceRunAfter` true: show the installer where a platform has one,
      // and come back up into the game afterwards, which is what "restart" means to a player.
      autoUpdater.quitAndInstall(false, true);
    },
  };
}
