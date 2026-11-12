import type { DataSource } from "../vfs/types";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import type { ListItem } from "./fdf/widgets";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { adopt, setProp } from "./mapBrowser";
import { showGlueDialog } from "./glueDialog";
import { REPLAY_EXT } from "../game/replay";
import type { ReplaySink } from "../game/replaySink";

// The score screen's SAVE REPLAY panel (issue #158) — the game's own, `SaveReplayPanel` in
// UI\FrameDef\Glue\ScoreScreen.fdf: the replays already saved in a list (`ReplayListFrame`, an
// empty container the engine fills, so the shared ListBoxWar3.fdf goes into it as every glue
// list does), a name box under it, and Save / Delete / Cancel. Picking a row puts its name in
// the box, so saving over one is a click and a Save — and asks first, with the game's own
// OVERWRITE_REPLAY_MESSAGE; Delete asks with DELETE_REPLAY_MESSAGE. Both on the menus' own
// message box (ui/glueDialog.ts).
//
// What is saved is the match that just ended: the recorder wrote it as `LastReplay` when the
// match closed (render/mapViewer.ts `closeReplay`), and Save keeps a copy of that under the
// name (`ReplaySink.keepLast`). The game's "replay/autosaved" folder is not listed here — this
// panel saves into the replay folder itself, and the autosaves are the View Replay screen's.

const SCORE_FDF = "UI\\FrameDef\\Glue\\ScoreScreen.fdf";
const LIST_FDF = "UI\\FrameDef\\Glue\\ListBoxWar3.fdf";
/** `LastReplay` is overwritten by the next match: it is what is being saved, never a name to
 *  save over. */
const LAST = "LastReplay" + REPLAY_EXT;

export interface SaveReplayPanelOptions {
  container: HTMLElement;
  vfs: DataSource;
  sink: ReplaySink;
  /** The match's replay is on disk (`LastReplay`) — resolves false when it could not be written. */
  written: Promise<boolean>;
  /** The name offered in the box. */
  suggested: string;
  /** Saved under this name. */
  onSaved: (name: string) => void;
}

function buildRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("SaveReplayPanel");
  if (!root) throw new Error("ScoreScreen.fdf: no SaveReplayPanel frame");
  const listBox = lib.resolveRoot("ListBoxWar3");
  if (listBox) {
    const list: FdfFrame = { ...listBox, name: "SaveReplayList" };
    setProp(list, "SetAllPoints", []); // fill the container the FDF already sized
    adopt(root, "ReplayListFrame", [list]);
  }
  return root;
}

/** Put the panel up over the score screen. */
export async function showSaveReplayPanel(opts: SaveReplayPanelOptions): Promise<void> {
  const scrim = document.createElement("div");
  scrim.className = "glue-dialog-scrim dimmed";
  opts.container.appendChild(scrim);
  let screen: FdfScreen | null = null;
  let strings: FdfLibrary | null = null;
  let names: string[] = [];
  let busy = false;

  const close = (): void => {
    window.removeEventListener("keydown", onKey, true);
    screen?.dispose();
    scrim.remove();
  };
  // Escape is Cancel, Enter is Save — unless a message box is up over the panel, which answers
  // its own keys.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" && e.key !== "Enter") return;
    if (document.querySelectorAll(".glue-dialog-scrim").length > 1) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") close();
    else save();
  };
  window.addEventListener("keydown", onKey, true);

  const string = (key: string, fallback: string): string => {
    const v = strings?.string(key);
    return v && v !== key ? v : fallback;
  };
  const typed = (): string => screen?.editBox("SaveReplayFileEditBox")?.value.trim() ?? "";
  const fileOf = (name: string): string => (name.toLowerCase().endsWith(REPLAY_EXT) ? name : name + REPLAY_EXT);
  const bare = (file: string): string => file.replace(/\.o3r$/i, "");

  const paint = (): void => {
    const s = screen;
    if (!s) return;
    const list = s.list("SaveReplayList");
    list?.setItems(names.map((n): ListItem => ({ value: n, label: bare(n) })));
    if (list) {
      list.onChange = (value) => {
        const box = s.editBox("SaveReplayFileEditBox");
        if (box) box.value = bare(value);
        paint();
      };
      list.onActivate = () => save();
    }
    const exists = names.some((n) => n.toLowerCase() === fileOf(typed()).toLowerCase());
    s.setEnabled("SaveReplaySaveButton", !busy && typed() !== "" && fileOf(typed()).toLowerCase() !== LAST.toLowerCase());
    s.setEnabled("SaveReplayDeleteButton", !busy && exists);
  };

  const reload = async (): Promise<void> => {
    const all = await opts.sink.list().catch(() => []);
    names = all.map((f) => f.name).filter((n) => !n.includes("/") && n.toLowerCase() !== LAST.toLowerCase());
    paint();
  };

  const confirm = (key: string, fallback: string, name: string, then: () => void): void => {
    void showGlueDialog({
      container: opts.container,
      vfs: opts.vfs,
      text: string(key, fallback).replace("%s", name),
      buttons: "yesno",
      onConfirm: then,
    });
  };

  function save(): void {
    const name = typed();
    if (busy || !name || fileOf(name).toLowerCase() === LAST.toLowerCase()) return;
    const doSave = async (): Promise<void> => {
      busy = true;
      paint();
      // The match's own file has to be on disk before it can be copied; it is written as the
      // match closes, a moment before this screen is up.
      const kept = (await opts.written) ? await opts.sink.keepLast(name).catch(() => null) : null;
      busy = false;
      if (!kept) {
        paint();
        return;
      }
      close();
      opts.onSaved(kept);
    };
    const existing = names.find((n) => n.toLowerCase() === fileOf(name).toLowerCase());
    if (existing) confirm("OVERWRITE_REPLAY_MESSAGE", "Are you sure you want to overwrite the existing replay file '%s'?", bare(existing), () => void doSave());
    else void doSave();
  }

  function remove(): void {
    const existing = names.find((n) => n.toLowerCase() === fileOf(typed()).toLowerCase());
    if (busy || !existing) return;
    confirm("DELETE_REPLAY_MESSAGE", "Are you sure you want to delete the replay '%s'?", bare(existing), () => {
      void opts.sink.remove(existing).then(() => reload());
    });
  }

  try {
    screen = await mountFdfScreen({
      container: scrim,
      vfs: opts.vfs,
      fdfPath: SCORE_FDF,
      includeFdf: [LIST_FDF],
      rootFrame: "SaveReplayPanel",
      buildRoot: (lib) => { strings = lib; return buildRoot(lib); },
      centerRoot: true,
      handlers: {
        SaveReplaySaveButton: save,
        SaveReplayDeleteButton: remove,
        SaveReplayCancelButton: close,
      },
      onBuild: (s) => {
        screen = s;
        const box = s.editBox("SaveReplayFileEditBox");
        if (box) {
          box.value = opts.suggested;
          box.onChange = () => paint();
          box.onSubmit = () => save();
          box.focus();
        }
        paint();
      },
    });
  } catch (err) {
    close();
    throw err;
  }
  await reload();
}
