// The Quest API (Scripts\common.j "Quest API" block) — the F9 quest log's script side.
//
// Everything a map author actually types is blizzard.j riding on these: CreateQuestBJ sets
// title/description/icon/required/discovered in one call, CreateQuestItemBJ hangs the
// requirement lines off it, and QuestMessageBJ is the "QUEST COMPLETED" banner — a pair of
// DisplayTimedTextToPlayer lines, a sting (bj_questCompletedSound, a plain
// CreateSoundFromLabel handle natives/sound.ts already plays), and FlashQuestDialogButton.
// So implementing the natives faithfully lights up the whole family, stings included,
// through Blizzard's own code.
//
// Every mutation bumps `rt.questsRevision` — there is no single "the quest changed" moment
// (a BJ configures one across five calls), so the open F9 dialog polls the counter, the same
// contract the dialogs/leaderboards/multiboards run on.

import type { DefeatConditionObj, NativeCtx, QuestItemObj, QuestObj, Runtime } from "../runtime";
import { asStr, jBool, jHandle, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);
const quest = (c: NativeCtx, v: JassValue): QuestObj | undefined => c.rt.data<QuestObj>(v);
const questItem = (c: NativeCtx, v: JassValue): QuestItemObj | undefined => c.rt.data<QuestItemObj>(v);

export function registerQuestNatives(rt: Runtime): void {
  // --- the quest object ------------------------------------------------------------
  def(rt, "CreateQuest", (c) => {
    const q: QuestObj = {
      handleId: 0,
      title: "",
      description: "",
      iconPath: "",
      // The two states no BJ ever leaves implicit are set the way a bare native user finds
      // them: a fresh quest is live (enabled) and unfailed. required/discovered take the
      // conventional defaults; CreateQuestBJ overwrites both on every quest it makes.
      required: true,
      completed: false,
      discovered: true,
      failed: false,
      enabled: true,
      items: [],
    };
    q.handleId = c.rt.handles.alloc(q);
    c.rt.quests.push(q);
    c.rt.questsRevision++;
    return jHandle(q.handleId, "quest");
  });
  def(rt, "DestroyQuest", (c, a) => {
    const q = quest(c, a[0]);
    if (q) {
      const i = c.rt.quests.indexOf(q);
      if (i >= 0) c.rt.quests.splice(i, 1);
      for (const it of q.items) c.rt.handles.free(it.handleId);
      c.rt.handles.free(q.handleId);
      c.rt.questsRevision++;
    }
    return JNULL;
  });

  /** A string setter and a flag setter differ only in which field they poke. */
  const setStr = (key: "title" | "description" | "iconPath") => (c: NativeCtx, a: JassValue[]): JassValue => {
    const q = quest(c, a[0]);
    if (q) {
      q[key] = asStr(a[1]);
      c.rt.questsRevision++;
    }
    return JNULL;
  };
  const setFlag = (key: "required" | "completed" | "discovered" | "failed" | "enabled") =>
    (c: NativeCtx, a: JassValue[]): JassValue => {
      const q = quest(c, a[0]);
      if (q) {
        q[key] = truthy(a[1]);
        c.rt.questsRevision++;
      }
      return JNULL;
    };

  def(rt, "QuestSetTitle", setStr("title"));
  def(rt, "QuestSetDescription", setStr("description"));
  def(rt, "QuestSetIconPath", setStr("iconPath"));
  def(rt, "QuestSetRequired", setFlag("required"));
  def(rt, "QuestSetCompleted", setFlag("completed"));
  def(rt, "QuestSetDiscovered", setFlag("discovered"));
  def(rt, "QuestSetFailed", setFlag("failed"));
  def(rt, "QuestSetEnabled", setFlag("enabled"));

  def(rt, "IsQuestRequired", (c, a) => jBool(quest(c, a[0])?.required ?? false));
  def(rt, "IsQuestCompleted", (c, a) => jBool(quest(c, a[0])?.completed ?? false));
  def(rt, "IsQuestDiscovered", (c, a) => jBool(quest(c, a[0])?.discovered ?? false));
  def(rt, "IsQuestFailed", (c, a) => jBool(quest(c, a[0])?.failed ?? false));
  def(rt, "IsQuestEnabled", (c, a) => jBool(quest(c, a[0])?.enabled ?? false));

  // --- requirement items -----------------------------------------------------------
  def(rt, "QuestCreateItem", (c, a) => {
    const q = quest(c, a[0]);
    if (!q) return JNULL;
    const it: QuestItemObj = { handleId: 0, questId: q.handleId, description: "", completed: false };
    it.handleId = c.rt.handles.alloc(it);
    q.items.push(it);
    c.rt.questsRevision++;
    return jHandle(it.handleId, "questitem");
  });
  def(rt, "QuestItemSetDescription", (c, a) => {
    const it = questItem(c, a[0]);
    if (it) {
      it.description = asStr(a[1]);
      c.rt.questsRevision++;
    }
    return JNULL;
  });
  def(rt, "QuestItemSetCompleted", (c, a) => {
    const it = questItem(c, a[0]);
    if (it) {
      it.completed = truthy(a[1]);
      c.rt.questsRevision++;
    }
    return JNULL;
  });
  def(rt, "IsQuestItemCompleted", (c, a) => jBool(questItem(c, a[0])?.completed ?? false));

  // --- defeat conditions -----------------------------------------------------------
  // Held as real handles so a script can create/describe/destroy them without a wobble,
  // but not rendered — see DefeatConditionObj for why.
  def(rt, "CreateDefeatCondition", (c) => {
    const d: DefeatConditionObj = { handleId: 0, description: "" };
    d.handleId = c.rt.handles.alloc(d);
    return jHandle(d.handleId, "defeatcondition");
  });
  def(rt, "DestroyDefeatCondition", (c, a) => {
    const d = c.rt.data<DefeatConditionObj>(a[0]);
    if (d) c.rt.handles.free(d.handleId);
    return JNULL;
  });
  def(rt, "DefeatConditionSetDescription", (c, a) => {
    const d = c.rt.data<DefeatConditionObj>(a[0]);
    if (d) d.description = asStr(a[1]);
    return JNULL;
  });

  // --- the two dialog pokes ----------------------------------------------------------
  // Flash: the HUD's Quests button glows until pressed (QuestMessageBJ calls this after
  // every banner). Update: repaint an open log with nothing else changed — a map that
  // edits a description mid-view calls it, and bumping the revision IS the repaint.
  def(rt, "FlashQuestDialogButton", (c) => {
    c.rt.questFlashes++;
    return JNULL;
  });
  def(rt, "ForceQuestDialogUpdate", (c) => {
    c.rt.questsRevision++;
    return JNULL;
  });
}
