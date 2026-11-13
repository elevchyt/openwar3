// The REPLAY WINDOW's boot (issue #158, electron/replayBundles.mjs, docs/replays.md "Versions").
//
// A replay recorded by another OpenWar3 is watched IN that OpenWar3: the desktop app of a later
// version downloads the recording version's own page (its "replay bundle"), opens it in a window
// of its own, and that page — this code, as it stood in that release — finds a bridge called
// `ow3replay` where a normal launch finds `ow3native`, and does exactly one thing: mounts the
// player's install, plays the replay it is handed, and closes the window when the watcher leaves.
// No load gate, no menus, no profile, no save; a replay window can watch a replay.
//
// THE CONTRACT is the bridge's shape, and it is a promise between two builds that never see each
// other's source: the page in a bundle was built long before the shell that opens it. So it is
// small, it is versioned (`REPLAY_CONTRACT`, stated in the bundle's manifest by
// tools/replay-bundle.mjs), and a shell that speaks an older contract than a bundle needs does
// not open that bundle at all — it says "update OpenWar3" instead. Adding to it is a new number.
//
//   contract   the version of this shape the SHELL speaks
//   version    the OpenWar3 version this page is (the one the replay was recorded on)
//   maxFps     the frame cap with vsync off, 0 for none (render/frameCap.ts)
//   replay()   the one replay, as bytes
//   exit()     close the window
//
// The player's options are not on it: the shell writes them into this window's own throwaway
// storage before the first script runs (electron/replayPreload.cjs), so every module that reads
// an option reads the player's, in whatever shape THIS version keeps them.

import { loadNativeInstall } from "./assets/nativeInstall";
import { decodeReplay, type Replay } from "./game/replay";
import { loadProfile, type LoadResult } from "./vfs/loader";
import { DEFAULT_PROFILE } from "./vfs/profiles";

/** The bridge shape this page needs. Bump it when the page comes to need more of the shell. */
export const REPLAY_CONTRACT = 1;

export interface ReplayBridge {
  contract: number;
  version: string;
  maxFps?: number;
  replay(): Promise<Uint8Array | null>;
  exit(): void;
}

/** The bridge, in a replay window; null in the game proper. */
export function replayBridge(): ReplayBridge | null {
  return (window as unknown as { ow3replay?: ReplayBridge }).ow3replay ?? null;
}

export interface ReplayBootHooks {
  mountInstall(load: LoadResult): void;
  watchReplay(replay: Replay): Promise<void>;
}

/** Mount the install, play the replay. A failure is SAID, with a way out — there is no menu
 *  behind this window to fall back on. */
export async function replayBoot(root: HTMLElement, bridge: ReplayBridge, hooks: ReplayBootHooks): Promise<void> {
  const note = document.createElement("div");
  note.className = "replay-boot";
  const line = document.createElement("div");
  line.textContent = `Loading replay — OpenWar3 ${bridge.version}`;
  note.appendChild(line);
  root.appendChild(note);
  try {
    const picked = await loadNativeInstall();
    const load = await loadProfile(picked, DEFAULT_PROFILE, (_msg, fraction) => {
      line.textContent = `Loading replay — OpenWar3 ${bridge.version}${fraction ? ` (${Math.round(fraction * 100)}%)` : ""}`;
    });
    hooks.mountInstall(load);
    const bytes = await bridge.replay();
    if (!bytes) throw new Error("The replay was not handed over.");
    const replay = await decodeReplay(new Uint8Array(bytes));
    note.remove();
    await hooks.watchReplay(replay);
  } catch (err) {
    console.error("[replay-boot]", err);
    line.textContent = `This replay could not be played: ${(err as Error).message ?? err}`;
    const close = document.createElement("button");
    close.className = "replay-boot-close";
    close.textContent = "Close";
    close.onclick = () => bridge.exit();
    note.appendChild(close);
  }
}
