// Unit-group natives (Phase 7 milestone 7.16 — issue #33; see docs/triggers.md).
//
// A `group` is a set of units, and the engine's answer to "which units are over
// there?". It's the workhorse of custom maps: the GUI action
//   "Pick every unit in <region> matching <condition> and do <actions>"
// compiles to
//   call ForGroupBJ( GetUnitsInRectMatching(gg_rct_Foo, Condition(function Filt)), function Act )
// and blizzard.j's ForGroupBJ / GetUnitsInRectMatching / CountUnitsInGroup /
// GroupPickRandomUnit / GroupAddGroup all ride on the same handful of natives below:
// CreateGroup, the GroupEnum* scans, ForGroup + GetEnumUnit, and the boolexpr filter
// (GetFilterUnit). Wave spawns, AoE damage and mass orders all go through here.
//
// Enumeration reads the LIVE sim through EngineHooks.enumUnits and mints an interned
// unit handle per sim unit (Runtime.unitForSim), so an enumerated unit is the SAME
// handle the event pump hands to GetTriggerUnit and the one CreateUnit returned —
// which is what makes JASS `==` and IsUnitInGroup work across the two.
//
// The GroupEnum* natives CLEAR the group before filling it (they replace its contents,
// they don't accumulate) — the reason the recycled-"enum group" idiom works without an
// explicit GroupClear. Confirmed against the community references (thehelper/Hive JASS
// threads on group enumeration), and consistent with blizzard.j, which always enums into
// a freshly created or explicitly cleared group.
//
// Sim difference worth knowing: our sim drops a unit from `SimWorld.units` the moment it
// dies (it becomes a corpse), so an enum only ever sees LIVING units. WC3 also enumerates
// dead-but-not-decayed bodies — which is why so much GUI code filters on
// `IsUnitAliveBJ(GetFilterUnit())`. That filter still works here (a dead unit's
// GetUnitState reads 0), it just has nothing to reject.

import { orderIdToString, orderStringToId } from "../orders";
import type { BoolExpr, JassPlayer, JassUnit, NativeCtx, RectObj, Runtime, UnitSnapshot } from "../runtime";
import { asInt, asNum, asStr, jBool, jHandle, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** A group is a set of unit HANDLE ids (a set — GroupAddUnit twice adds once), kept in
 *  insertion order so ForGroup / FirstOfGroup are deterministic. */
interface GroupObj {
  handleId: number;
  units: Set<number>;
}

const group = (c: NativeCtx, v: JassValue): GroupObj | undefined => c.rt.data<GroupObj>(v);
const unit = (c: NativeCtx, v: JassValue): JassUnit | undefined => c.rt.data<JassUnit>(v);
const playerIndex = (c: NativeCtx, v: JassValue): number => c.rt.data<JassPlayer>(v)?.index ?? asInt(v);

/** Every unit currently in the sim (the enumeration source). Empty with no engine
 *  attached — a headless script's groups then only hold what it GroupAddUnit'd. */
const simUnits = (c: NativeCtx): ReadonlyArray<UnitSnapshot> => c.rt.hooks?.enumUnits?.() ?? [];

/** Run an enumeration's boolexpr `filter` for one unit, exposed to it as GetFilterUnit
 *  (this is the "matching <condition>" half of the Pick-every-unit action). A null
 *  filter — GetUnitsInRectAll passes one — matches everything. */
function filterPasses(c: NativeCtx, filterV: JassValue | undefined, unitV: JassValue): boolean {
  const be = filterV ? c.rt.data<BoolExpr>(filterV) : undefined;
  if (!be?.fn) return true;
  c.rt.eventStack.push(new Map([["FilterUnit", unitV]]));
  try {
    return truthy(c.call(be.fn, []));
  } finally {
    c.rt.eventStack.pop();
  }
}

/** The shared body of every GroupEnum* native: CLEAR the group, then walk the live sim
 *  adding each unit that passes `pred` (the geometric/ownership test) and the boolexpr
 *  filter, up to `limit` (the *Counted variants). */
function enumInto(c: NativeCtx, g: GroupObj | undefined, filterV: JassValue | undefined, limit: number, pred: (u: UnitSnapshot) => boolean): void {
  if (!g) return;
  g.units.clear();
  let n = 0;
  for (const u of simUnits(c)) {
    if (n >= limit) break;
    if (!pred(u)) continue;
    const handle = c.rt.unitForSim(u); // interned: same handle as CreateUnit / the event pump
    if (!filterPasses(c, filterV, handle)) continue;
    if (handle.k === "handle") g.units.add(handle.h);
    n++;
  }
}

const inRect = (u: UnitSnapshot, r: RectObj | undefined): boolean =>
  !!r && u.x >= r.minx && u.x <= r.maxx && u.y >= r.miny && u.y <= r.maxy;
/** WC3 measures GroupEnumUnitsInRange from the unit's ORIGIN (collision size is not
 *  considered) — a plain circle test. */
const inRange = (u: UnitSnapshot, x: number, y: number, radius: number): boolean =>
  (u.x - x) * (u.x - x) + (u.y - y) * (u.y - y) <= radius * radius;

export function registerGroupNatives(rt: Runtime): void {
  // --- the group container ---
  def(rt, "CreateGroup", (c) => {
    const g: GroupObj = { handleId: 0, units: new Set() };
    g.handleId = c.rt.handles.alloc(g);
    return jHandle(g.handleId, "group");
  });
  def(rt, "DestroyGroup", (c, a) => (a[0].k === "handle" && c.rt.handles.free(a[0].h), JNULL));
  def(rt, "GroupClear", (c, a) => (group(c, a[0])?.units.clear(), JNULL));
  def(rt, "GroupAddUnit", (c, a) => {
    const g = group(c, a[0]);
    if (g && a[1].k === "handle" && unit(c, a[1])) g.units.add(a[1].h);
    return JNULL;
  });
  def(rt, "GroupRemoveUnit", (c, a) => {
    const g = group(c, a[0]);
    if (g && a[1].k === "handle") g.units.delete(a[1].h);
    return JNULL;
  });
  def(rt, "IsUnitInGroup", (c, a) => jBool(a[0].k === "handle" && (group(c, a[1])?.units.has(a[0].h) ?? false)));

  // --- enumeration: fill a group from the live sim ---
  def(rt, "GroupEnumUnitsInRect", (c, a) => {
    const r = c.rt.data<RectObj>(a[1]);
    enumInto(c, group(c, a[0]), a[2], Infinity, (u) => inRect(u, r));
    return JNULL;
  });
  def(rt, "GroupEnumUnitsInRectCounted", (c, a) => {
    const r = c.rt.data<RectObj>(a[1]);
    enumInto(c, group(c, a[0]), a[2], asInt(a[3]), (u) => inRect(u, r));
    return JNULL;
  });
  def(rt, "GroupEnumUnitsInRange", (c, a) => {
    const x = asNum(a[1]), y = asNum(a[2]), rad = asNum(a[3]);
    enumInto(c, group(c, a[0]), a[4], Infinity, (u) => inRange(u, x, y, rad));
    return JNULL;
  });
  def(rt, "GroupEnumUnitsInRangeCounted", (c, a) => {
    const x = asNum(a[1]), y = asNum(a[2]), rad = asNum(a[3]);
    enumInto(c, group(c, a[0]), a[4], asInt(a[5]), (u) => inRange(u, x, y, rad));
    return JNULL;
  });
  def(rt, "GroupEnumUnitsInRangeOfLoc", (c, a) => {
    const l = c.rt.data<{ x: number; y: number }>(a[1]);
    const rad = asNum(a[2]);
    enumInto(c, group(c, a[0]), a[3], Infinity, (u) => !!l && inRange(u, l.x, l.y, rad));
    return JNULL;
  });
  def(rt, "GroupEnumUnitsInRangeOfLocCounted", (c, a) => {
    const l = c.rt.data<{ x: number; y: number }>(a[1]);
    const rad = asNum(a[2]);
    enumInto(c, group(c, a[0]), a[3], asInt(a[4]), (u) => !!l && inRange(u, l.x, l.y, rad));
    return JNULL;
  });
  def(rt, "GroupEnumUnitsOfPlayer", (c, a) => {
    const p = playerIndex(c, a[1]);
    enumInto(c, group(c, a[0]), a[2], Infinity, (u) => u.owner === p);
    return JNULL;
  });
  // GroupEnumUnitsOfType matches the unit type's NAME ("Footman"), not its rawcode —
  // hence the objectName lookup. (Blizzard's own GetUnitsOfTypeIdAll avoids it, going
  // through GroupEnumUnitsOfPlayer + a GetUnitTypeId filter instead.)
  const nameMatches = (c: NativeCtx, u: UnitSnapshot, want: string): boolean => {
    const name = c.rt.hooks?.objectName?.(u.typeId);
    return !!name && name.toLowerCase() === want.toLowerCase();
  };
  def(rt, "GroupEnumUnitsOfType", (c, a) => {
    const want = asStr(a[1]);
    enumInto(c, group(c, a[0]), a[2], Infinity, (u) => nameMatches(c, u, want));
    return JNULL;
  });
  def(rt, "GroupEnumUnitsOfTypeCounted", (c, a) => {
    const want = asStr(a[1]);
    enumInto(c, group(c, a[0]), a[2], asInt(a[3]), (u) => nameMatches(c, u, want));
    return JNULL;
  });
  // The player's current SELECTION. Only the local player has one in our engine (the
  // others aren't playing yet), so a remote slot enumerates empty rather than lying.
  def(rt, "GroupEnumUnitsSelected", (c, a) => {
    const sel = new Set(c.rt.hooks?.selectedUnits?.(playerIndex(c, a[1])) ?? []);
    enumInto(c, group(c, a[0]), a[2], Infinity, (u) => sel.has(u.id));
    return JNULL;
  });
  def(rt, "SyncSelections", () => JNULL); // MP selection sync — nothing to do locally

  // --- iteration: the loop body of "Pick every unit …" ---
  // ForGroup runs `callback` once per member with the unit exposed as GetEnumUnit.
  // Iterate a SNAPSHOT: the callback routinely mutates the group (GroupRemoveUnit, or
  // KillUnit → the unit leaves the sim), and blizzard.j's ForGroupBJ may destroy it.
  def(rt, "ForGroup", (c, a) => {
    const g = group(c, a[0]);
    if (g && a[1].k === "code") {
      for (const hid of [...g.units]) {
        c.rt.eventStack.push(new Map([["EnumUnit", jHandle(hid, "unit")]]));
        try {
          c.call(a[1].fn, []);
        } catch {
          /* one member's callback throwing must not abort the whole loop */
        } finally {
          c.rt.eventStack.pop();
        }
      }
    }
    return JNULL;
  });
  // FirstOfGroup — the head of the group (null when empty); the other half of the
  // classic "loop / FirstOfGroup / GroupRemoveUnit" drain.
  def(rt, "FirstOfGroup", (c, a) => {
    const g = group(c, a[0]);
    for (const hid of g?.units ?? []) return jHandle(hid, "unit");
    return JNULL;
  });
  def(rt, "GetEnumUnit", (c) => c.rt.eventResponse("EnumUnit"));

  // --- group orders: one order, every member (a spawn wave marching out) ---
  // Returns true if the order took for at least one unit, like the engine.
  const orderGroup = (c: NativeCtx, gv: JassValue, order: string, orderId: number, kind: "immediate" | "point" | "target", x: number, y: number, targetV: JassValue): JassValue => {
    const g = group(c, gv);
    if (!g) return jBool(false);
    const t = kind === "target" ? unit(c, targetV) : undefined;
    let any = false;
    for (const hid of [...g.units]) {
      const u = c.rt.handles.get(hid) as JassUnit | undefined;
      if (!u || u.simId < 0) continue;
      if (c.rt.hooks?.issueUnitOrder?.(u.simId, orderId, order, kind, x, y, t?.simId ?? 0)) any = true;
    }
    return jBool(any);
  };
  // As with the single-unit orders (natives/world.ts): the order STRING rides along so an
  // ability order ("holybolt") can be cast by name; an *ById* call recovers it from the
  // vocabulary.
  const byName = (c: NativeCtx, gv: JassValue, ov: JassValue, kind: "immediate" | "point" | "target", x: number, y: number, tv: JassValue): JassValue => {
    const order = ov?.k === "string" ? ov.s.trim().toLowerCase() : "";
    return orderGroup(c, gv, order, orderStringToId(order), kind, x, y, tv);
  };
  const byId = (c: NativeCtx, gv: JassValue, iv: JassValue, kind: "immediate" | "point" | "target", x: number, y: number, tv: JassValue): JassValue => {
    const id = asInt(iv);
    return orderGroup(c, gv, orderIdToString(id), id, kind, x, y, tv);
  };
  def(rt, "GroupImmediateOrder", (c, a) => byName(c, a[0], a[1], "immediate", 0, 0, JNULL));
  def(rt, "GroupImmediateOrderById", (c, a) => byId(c, a[0], a[1], "immediate", 0, 0, JNULL));
  def(rt, "GroupPointOrder", (c, a) => byName(c, a[0], a[1], "point", asNum(a[2]), asNum(a[3]), JNULL));
  def(rt, "GroupPointOrderById", (c, a) => byId(c, a[0], a[1], "point", asNum(a[2]), asNum(a[3]), JNULL));
  def(rt, "GroupPointOrderLoc", (c, a) => {
    const l = c.rt.data<{ x: number; y: number }>(a[2]);
    return byName(c, a[0], a[1], "point", l?.x ?? 0, l?.y ?? 0, JNULL);
  });
  def(rt, "GroupPointOrderByIdLoc", (c, a) => {
    const l = c.rt.data<{ x: number; y: number }>(a[2]);
    return byId(c, a[0], a[1], "point", l?.x ?? 0, l?.y ?? 0, JNULL);
  });
  def(rt, "GroupTargetOrder", (c, a) => byName(c, a[0], a[1], "target", 0, 0, a[2]));
  def(rt, "GroupTargetOrderById", (c, a) => byId(c, a[0], a[1], "target", 0, 0, a[2]));
}
