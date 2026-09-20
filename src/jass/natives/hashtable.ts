// HASHTABLES — the general-purpose store every modern map is built on (see docs/triggers.md).
//
// `InitHashtable` and its ~120 Save/Load/Have/Remove/Flush natives are declared in the
// install's own `Scripts\common.j` (they arrived in 1.24), and they are how a map written
// after about 2010 keeps ANY per-unit or per-timer state: "attach this damage amount to that
// missile", "remember which hero owns this timer", "count how many times this unit has been
// hit". A map that uses them and finds them missing does not fail loudly — every Save is a
// no-op and every Load returns 0, so the map runs and quietly forgets everything it knows.
//
// Three facts out of common.j shape the whole file, and each is visible in the signatures:
//
//  1. **The key is a PAIR of integers** — `(parentKey, childKey)` — and nothing interprets
//     either. A map's idiom is `GetHandleId(u)` for the parent and a small constant for the
//     child, which is why the parent map is sparse and the child map is tiny.
//  2. **Each TYPE is its own namespace.** `HaveSavedInteger` and `HaveSavedReal` ask about the
//     same pair and get different answers, exactly as the game cache's five families do
//     (natives/gamecache.ts says the same thing about `HaveStored*`). So a slot holds one of
//     each rather than one value.
//  3. **Every typed handle saver is the same function.** `SaveUnitHandle`, `SaveTimerHandle`,
//     `SaveGroupHandle` … all take `(table, parent, child, <handle>)` and return boolean, and
//     all forty of them share ONE handle slot — `HaveSavedHandle` is a single native with no
//     per-type twin, which is the data saying so. The typing is the COMPILER's job, and by
//     the time a value reaches here it is already a handle.
//
// `FlushParentHashtable` empties the whole table and `FlushChildHashtable` one parent key —
// the pair a map calls when a unit dies, and the reason a long game does not leak.

import type { NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jBool, jHandle, jInt, jReal, jStr, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** One (parentKey, childKey) pair's slots — one per stored TYPE (see note 2). */
interface Slot {
  int?: number;
  real?: number;
  bool?: boolean;
  str?: string;
  handle?: JassValue;
}

/** A hashtable handle's backing object. */
export interface HashtableObj {
  handleId: number;
  /** parentKey → childKey → slot. Sparse both ways: a map keys the parent on a handle id,
   *  which is a number in the thousands, and the child on a handful of small constants. */
  data: Map<number, Map<number, Slot>>;
}

const table = (c: NativeCtx, v: JassValue): HashtableObj | undefined => c.rt.data<HashtableObj>(v);

/** The slot at (parent, child), created on the way in for a write and not for a read. */
function slotOf(t: HashtableObj, parent: number, child: number, create: boolean): Slot | undefined {
  let children = t.data.get(parent);
  if (!children) {
    if (!create) return undefined;
    children = new Map();
    t.data.set(parent, children);
  }
  let slot = children.get(child);
  if (!slot && create) {
    slot = {};
    children.set(child, slot);
  }
  return slot;
}

/** The typed handle savers — every one of them the same function (see note 3). Listed by
 *  name because the list IS the API surface: a map calls the one its variable's type names,
 *  and a name missing from here is a `SaveXHandle` that silently forgets. Read straight off
 *  `Scripts\common.j`'s hashtable section. */
const HANDLE_TYPES = [
  "Player", "Widget", "Destructable", "Item", "Unit", "Ability", "Timer", "Trigger",
  "TriggerCondition", "TriggerAction", "TriggerEvent", "Force", "Group", "Location", "Rect",
  "BooleanExpr", "Sound", "Effect", "UnitPool", "ItemPool", "Quest", "QuestItem",
  "DefeatCondition", "TimerDialog", "Leaderboard", "Multiboard", "MultiboardItem",
  "Trackable", "Dialog", "Button", "TextTag", "Lightning", "Image", "Ubersplat", "Region",
  "FogState", "FogModifier", "Agent", "Hashtable",
];

export function registerHashtableNatives(rt: Runtime): void {
  def(rt, "InitHashtable", (c) => {
    const obj: HashtableObj = { handleId: 0, data: new Map() };
    obj.handleId = c.rt.handles.alloc(obj);
    return jHandle(obj.handleId, "hashtable");
  });

  // --- the four value families ------------------------------------------------------
  // Save* returns nothing for integer/real/boolean and boolean for string (common.j's own
  // split, which nothing depends on); a Save against a destroyed table is simply dropped.
  const save = (name: string, write: (slot: Slot, v: JassValue) => void, returns: "none" | "bool"): void => {
    def(rt, name, (c, a) => {
      const t = table(c, a[0]);
      if (!t) return returns === "bool" ? jBool(false) : JNULL;
      write(slotOf(t, asInt(a[1]), asInt(a[2]), true)!, a[3] ?? JNULL);
      return returns === "bool" ? jBool(true) : JNULL;
    });
  };
  save("SaveInteger", (s, v) => { s.int = asInt(v); }, "none");
  save("SaveReal", (s, v) => { s.real = asNum(v); }, "none");
  save("SaveBoolean", (s, v) => { s.bool = truthy(v); }, "none");
  save("SaveStr", (s, v) => { s.str = asStr(v); }, "bool");
  for (const kind of HANDLE_TYPES) {
    save(`Save${kind}Handle`, (s, v) => { s.handle = v; }, "bool");
  }

  const load = (name: string, read: (slot: Slot | undefined) => JassValue): void => {
    def(rt, name, (c, a) => {
      const t = table(c, a[0]);
      return read(t ? slotOf(t, asInt(a[1]), asInt(a[2]), false) : undefined);
    });
  };
  load("LoadInteger", (s) => jInt(s?.int ?? 0));
  load("LoadReal", (s) => jReal(s?.real ?? 0));
  load("LoadBoolean", (s) => jBool(s?.bool ?? false));
  load("LoadStr", (s) => jStr(s?.str ?? ""));
  for (const kind of HANDLE_TYPES) {
    load(`Load${kind}Handle`, (s) => s?.handle ?? JNULL);
  }

  // --- have / remove ----------------------------------------------------------------
  const have = (name: string, held: (slot: Slot) => boolean): void => {
    def(rt, name, (c, a) => {
      const t = table(c, a[0]);
      const slot = t && slotOf(t, asInt(a[1]), asInt(a[2]), false);
      return jBool(!!slot && held(slot));
    });
  };
  have("HaveSavedInteger", (s) => s.int !== undefined);
  have("HaveSavedReal", (s) => s.real !== undefined);
  have("HaveSavedBoolean", (s) => s.bool !== undefined);
  have("HaveSavedString", (s) => s.str !== undefined);
  have("HaveSavedHandle", (s) => s.handle !== undefined);

  const remove = (name: string, clear: (slot: Slot) => void): void => {
    def(rt, name, (c, a) => {
      const t = table(c, a[0]);
      const slot = t && slotOf(t, asInt(a[1]), asInt(a[2]), false);
      if (slot) clear(slot);
      return JNULL;
    });
  };
  remove("RemoveSavedInteger", (s) => { delete s.int; });
  remove("RemoveSavedReal", (s) => { delete s.real; });
  remove("RemoveSavedBoolean", (s) => { delete s.bool; });
  remove("RemoveSavedString", (s) => { delete s.str; });
  remove("RemoveSavedHandle", (s) => { delete s.handle; });

  // --- flush ------------------------------------------------------------------------
  // The pair a map calls when a unit dies. Without them a long game grows a slot per
  // (handle id, child) for ever, which is the leak this family is famous for.
  def(rt, "FlushParentHashtable", (c, a) => {
    table(c, a[0])?.data.clear();
    return JNULL;
  });
  def(rt, "FlushChildHashtable", (c, a) => {
    table(c, a[0])?.data.delete(asInt(a[1]));
    return JNULL;
  });
}
