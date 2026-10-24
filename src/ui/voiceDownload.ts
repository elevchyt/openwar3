import { showGlueDialog } from "./glueDialog";
import { showPatchDialog } from "./patchDialog";
import { installVoiceModel } from "../voice/model";
import { WHISPER_MODEL } from "../voice/whisperModels";
import type { DataSource } from "../vfs/types";
import { loadOptions, saveOptions } from "../data/options";
import { applyVoiceOptions } from "../voice/control";

// "Download voice control dependencies" — fetching Voice Control's speech model
// (src/voice/model.ts) in the game's OWN chrome, in two steps:
//
//   1. the menus' own question box (`DialogWar3.fdf`, ui/glueDialog.ts) asks first, naming the
//      size — a 250 MB download is the player's decision, not a side effect of a click;
//   2. Yes puts up the dialog Warcraft III already had for exactly this: `BattleNetPatchDialog`,
//      the box the game showed while Battle.net handed it a patch (ui/patchDialog.ts, which the
//      LAN map download shares) — one Cancel button, which becomes OK once it is done.
//
// Both are mounted straight out of the player's install; nothing here draws chrome of its own.
// Cancel or Escape aborts the fetch and nothing half-written is kept.

const MB = (WHISPER_MODEL.bytes / 1_000_000).toFixed(0);

/** The words. Ours — the game never fetched anything but itself — set in its markup: gold
 *  (`|cffffcc00`) for the key and the size, as the game golds a hotkey in a tooltip. */
const TEXT = {
  ask: `Voice Control needs its speech model (|cffffcc00${MB} MB|r), downloaded once and kept on this computer.|n|nDownload it now?`,
  title: "Downloading Voice Control",
  titleDone: "Voice Control is ready",
  titleFailed: "Download failed",
  fetching: `Speech model, ${MB} MB — kept on this computer.`,
  done: "Hold |cffffcc00Period (.)|r and speak a command.",
  failed: (why: string) => `The speech model could not be downloaded.|n${why}`,
};

export interface VoiceDownloadOptions {
  container: HTMLElement;
  vfs: DataSource;
}

/** Ask, then download. Resolves when the dialog closes, true if the model arrived (the Options
 *  row swaps to its checkbox through `onVoiceModelInstalled` either way). */
export async function showVoiceDownload(opts: VoiceDownloadOptions): Promise<boolean> {
  const yes = await new Promise<boolean>((resolve) => {
    showGlueDialog({
      container: opts.container,
      vfs: opts.vfs,
      text: TEXT.ask,
      buttons: "yesno",
      dimmed: true,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    }).catch(() => resolve(false));
  });
  return yes ? download(opts) : false;
}

/** The patch dialog, downloading from the moment it is up. */
async function download(opts: VoiceDownloadOptions): Promise<boolean> {
  const abort = new AbortController();
  let installed = false;
  let settle: (ok: boolean) => void = () => {};
  const closed = new Promise<boolean>((r) => (settle = r));
  const dialog = await showPatchDialog({
    container: opts.container,
    vfs: opts.vfs,
    title: TEXT.title,
    info: TEXT.fetching,
    className: "voice-download",
    onClose: () => {
      abort.abort();
      settle(installed);
    },
  });
  try {
    await installVoiceModel((p) => dialog.setProgress(p.fraction), abort.signal);
    installed = true;
    // Downloading it was the decision to use it: Voice Control comes on, saved, at once.
    const stored = loadOptions();
    stored.voiceControl = true;
    saveOptions(stored);
    applyVoiceOptions(stored);
    dialog.finish(TEXT.titleDone, TEXT.done);
  } catch (err) {
    if (!abort.signal.aborted) {
      dialog.finish(TEXT.titleFailed, TEXT.failed(err instanceof Error ? err.message : String(err)), false);
    }
  }
  return closed;
}
