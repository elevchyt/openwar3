// SAVED GAMES from the script (issue #159, docs/save-games.md) — common.j's six save natives and
// EVENT_GAME_SAVE's one response.
//
//   native LoadGame            takes string saveFileName, boolean doScoreScreen returns nothing
//   native SaveGame            takes string saveFileName returns nothing
//   native RenameSaveDirectory takes string sourceDirName, string destDirName returns boolean
//   native RemoveSaveDirectory takes string sourceDirName returns boolean
//   native CopySaveGame        takes string sourceSaveName, string destSaveName returns boolean
//   native SaveGameExists      takes string saveName returns boolean
//   constant native GetSaveBasicFilename takes nothing returns string   // EVENT_GAME_SAVE
//
// A SAVE cannot be taken in the middle of the script — the thread asking for it is running, and
// a save is the match between steps — so `SaveGame` and `LoadGame` are REQUESTS the engine
// carries out once the script's pump is done (MapViewerScene `pendingScriptSave`). The directory
// natives are the campaign's own save FOLDERS, which our saves (one flat `saves/`) do not have;
// they answer false, as a failed rename does.

import type { NativeCtx, Runtime } from "../runtime";
import { asStr, jBool, jStr, JNULL, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

export function registerSaveNatives(rt: Runtime): void {
  def(rt, "SaveGame", (c, a) => (c.rt.hooks?.saveGame?.(asStr(a[0] ?? JNULL)), JNULL));
  def(rt, "LoadGame", (c, a) => (c.rt.hooks?.loadGame?.(asStr(a[0] ?? JNULL), a[1]?.k === "bool" && a[1].b), JNULL));
  def(rt, "SaveGameExists", (c, a) => jBool(c.rt.hooks?.saveGameExists?.(asStr(a[0] ?? JNULL)) ?? false));
  def(rt, "RenameSaveDirectory", () => jBool(false));
  def(rt, "RemoveSaveDirectory", () => jBool(false));
  def(rt, "CopySaveGame", () => jBool(false));
  // The name a save is being written under, inside an EVENT_GAME_SAVE trigger.
  def(rt, "GetSaveBasicFilename", (c) => {
    for (let i = c.rt.eventStack.length - 1; i >= 0; i--) {
      const v = c.rt.eventStack[i].get("SaveBasicFilename");
      if (v) return v;
    }
    return jStr("");
  });
}
