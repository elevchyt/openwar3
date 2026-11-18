// The natives a map built for 1.31, Reforged (1.32–2.0) or the 3.0 "Forsaken Kingdom" update
// calls, and 1.30.4's `common.j` has never heard of (issue #313, second half).
//
// They are DECLARED by our own prelude (src/compat/preludeLater.ts) and answered here; the frame
// API's share is in src/compat/frames.ts beside the model it reads. OpenWar3 still plays 1.30.4
// (src/compat/README.md): nothing in this file makes the game a later one. What it does is let
// a later MAP run — and say plainly, native by native, which of three things it got:
//
//   BEHAVIOUR  the engine has the thing the native is about (orders, cooldowns, healing, keys,
//              doodads, destructables, bit arithmetic), so the native does it.
//   STORED     a setting with nothing here to consume it — the HUD scale, a camera's "type", an
//              HD water parameter. Written and read back, so a script's own getter agrees with
//              its setter.
//   ABSENT     a SYSTEM this engine does not have: Reforged HD skins, facial animation, and the
//              3.0 equipment / bag / loadout inventory. Those answer what an engine without the
//              system answers — nothing equipped, no bag, the unit's own type for its "skin".
//
// Sources: jassdoc (github.com/lep/jassdoc — the annotated common.j through 3.0, which is also
// what wc3jass.com serves) for every signature and for behaviour; quoted where it decides
// something. Nothing here is Blizzard's code: a native has no body to copy.

import { intToRawcode, rawcodeToInt } from "../lexer";
import { orderIdToString } from "../orders";
import type { JassItem, JassPlayer, JassUnit, NativeCtx, Runtime, SoundObj, TriggerObj } from "../runtime";
import { asInt, asNum, asStr, jBool, jHandle, jInt, JNULL, jReal, jStr, truthy, type JassValue } from "../values";
import { issueTargetOrder } from "./orderTarget";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const unit = (c: NativeCtx, v: JassValue | undefined): JassUnit | undefined => c.rt.data<JassUnit>(v ?? JNULL);
const simOf = (c: NativeCtx, v: JassValue | undefined): number => {
  const u = unit(c, v);
  return u && u.simId >= 0 ? u.simId : -1;
};
const playerOf = (c: NativeCtx, v: JassValue | undefined): number => c.rt.data<JassPlayer>(v ?? JNULL)?.index ?? -1;
/** This module's own settings, on the runtime so a saved game carries them. */
const store = (c: NativeCtx): Map<string, number | string> => c.rt.nativeTable<string, number | string>("later");
/** Call another native by name — the classic native a later one is a variation of. */
const via = (c: NativeCtx, native: string, args: JassValue[]): JassValue => c.rt.natives.get(native)?.(c, args) ?? JNULL;

/** The 16:9-at-most game frame's coordinate space: 0.8 wide by 0.6 tall, a 4:3 box centred in
 *  the window (docs/video-options.md; ui/widescreen.ts). */
const FRAME_W = 0.8, FRAME_H = 0.6;

export function registerLaterNatives(rt: Runtime): void {
  // ======================================================================================
  // BEHAVIOUR
  // ======================================================================================

  // --- arithmetic ---
  def(rt, "MathRound", (_c, a) => jInt(Math.round(asNum(a[0]))));
  def(rt, "BlzBitOr", (_c, a) => jInt(asInt(a[0]) | asInt(a[1])));
  def(rt, "BlzBitAnd", (_c, a) => jInt(asInt(a[0]) & asInt(a[1])));
  def(rt, "BlzBitXor", (_c, a) => jInt(asInt(a[0]) ^ asInt(a[1])));
  // BlzConvertColor(a, r, g, b) — one 0xAARRGGBB integer, the form BlzFrameSetTextColor takes.
  def(rt, "BlzConvertColor", (_c, a) => jInt(((asInt(a[0]) & 0xff) << 24) | ((asInt(a[1]) & 0xff) << 16) | ((asInt(a[2]) & 0xff) << 8) | (asInt(a[3]) & 0xff)));

  // --- players and forces ---
  def(rt, "BlzForceHasPlayer", (c, a) => jBool(c.rt.data<{ players: Set<number> }>(a[0])?.players.has(playerOf(c, a[1])) ?? false));
  // "The number of town halls" — Blizzard.j's own count for the same question is
  // GetPlayerTypedUnitCount(p, "townhall", true, true), so it is asked that way.
  def(rt, "BlzGetPlayerTownHallCount", (c, a) => via(c, "GetPlayerTypedUnitCount", [a[0] ?? JNULL, jStr("townhall"), jBool(true), jBool(true)]));
  // BlzDisplayChatMessage(player, recipient, message) — a line in the chat log AS that player.
  def(rt, "BlzDisplayChatMessage", (c, a) => {
    const p = playerOf(c, a[0]);
    if (p >= 0) c.rt.hooks?.displayChatMessage?.(p, asInt(a[1]), c.rt.resolveTrigStr(asStr(a[2])));
    return JNULL;
  });
  // The two handicaps 1.32 added beside the life and XP ones. Stored and read back at the
  // default of 1 (100 %); the sim applies neither yet.
  for (const kind of ["ReviveTime", "Damage"]) {
    def(rt, `SetPlayerHandicap${kind}`, (c, a) => (store(c).set(`handicap${kind}:${playerOf(c, a[0])}`, asNum(a[1])), JNULL));
    def(rt, `GetPlayerHandicap${kind}`, (c, a) => jReal(Number(store(c).get(`handicap${kind}:${playerOf(c, a[0])}`) ?? 1)));
  }

  // --- units ---
  // BlzUnitIsAlive — life above the death threshold, what Blizzard.j's IsUnitAliveBJ computes.
  def(rt, "BlzUnitIsAlive", (c, a) => {
    const id = simOf(c, a[0]);
    return jBool(id >= 0 && (c.rt.hooks?.getUnitState?.(id, 0) ?? 0) > 0.405);
  });
  // BlzPauseUnitEx — "pauses a unit … without the buffs and cooldowns freezing bugs of
  // PauseUnit" and counted, so two pauses want two unpauses (jassdoc). The counter is kept here;
  // the pause itself is the one the engine has.
  def(rt, "BlzPauseUnitEx", (c, a) => {
    const id = simOf(c, a[0]);
    if (id < 0) return JNULL;
    const key = `pauseEx:${id}`;
    const n = Math.max(0, Number(store(c).get(key) ?? 0) + (truthy(a[1]) ? 1 : -1));
    store(c).set(key, n);
    c.rt.hooks?.pauseUnit?.(id, n > 0);
    return JNULL;
  });
  // BlzUnitHeal(u, source, life, isItem, applyStatBonuses) → the life actually restored.
  def(rt, "BlzUnitHeal", (c, a) => {
    const id = simOf(c, a[0]);
    if (id < 0) return jReal(0);
    const h = c.rt.hooks;
    const life = h?.getUnitState?.(id, 0) ?? 0, max = h?.getUnitState?.(id, 1) ?? 0;
    if (life <= 0) return jReal(0); // a dead unit is not healed
    const healed = Math.max(0, Math.min(asNum(a[2]), max - life));
    if (healed > 0) h?.setUnitState?.(id, 0, life + healed);
    return jReal(healed);
  });
  // The clip lengths a later map times its own effects against.
  def(rt, "BlzGetUnitAnimationDuration", (c, a) => {
    const id = simOf(c, a[0]);
    return jReal(id >= 0 ? c.rt.hooks?.unitAnimationDuration?.(id, asStr(a[1])) ?? 0 : 0);
  });
  def(rt, "BlzGetUnitAnimationDurationByIndex", (c, a) => {
    const id = simOf(c, a[0]);
    return jReal(id >= 0 ? c.rt.hooks?.unitAnimationDuration?.(id, asInt(a[1])) ?? 0 : 0);
  });
  // BlzResetUnitAttack(u, weaponIndex) — the swing under way is dropped, as
  // BlzUnitInterruptAttack drops it; a unit has one swing at a time whichever weapon it is.
  def(rt, "BlzResetUnitAttack", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.interruptAttack?.(id);
    return JNULL;
  });

  // --- a unit's ability cooldown, read and moved (3.0) ---
  // Remaining is seconds; "percent" is the share of the rank's own cooldown still to run, 0–100.
  const abil = (v: JassValue | undefined): string => intToRawcode(asInt(v ?? JNULL));
  const cooldown = (c: NativeCtx, id: number, a: string): { left: number; total: number } => {
    const h = c.rt.hooks;
    const level = Math.max(1, h?.getUnitAbilityLevel?.(id, a) ?? 1);
    return { left: h?.unitAbilityCooldownLeft?.(id, a) ?? 0, total: h?.unitAbilityRankData?.(id, a, level - 1)?.cooldown ?? 0 };
  };
  const setCooldown = (c: NativeCtx, id: number, a: string, seconds: number): void => {
    if (seconds > 0) c.rt.hooks?.startUnitAbilityCooldown?.(id, a, seconds);
    else c.rt.hooks?.endUnitAbilityCooldown?.(id, a);
  };
  def(rt, "BlzGetUnitAbilityCooldownPercent", (c, a) => {
    const id = simOf(c, a[0]);
    if (id < 0) return jReal(0);
    const cd = cooldown(c, id, abil(a[1]));
    return jReal(cd.total > 0 ? (cd.left / cd.total) * 100 : 0);
  });
  def(rt, "BlzSetUnitAbilityCooldownRemaining", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) setCooldown(c, id, abil(a[1]), asNum(a[2]));
    return JNULL;
  });
  def(rt, "BlzSetUnitAbilityCooldownPercent", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) setCooldown(c, id, abil(a[1]), (cooldown(c, id, abil(a[1])).total * asNum(a[2])) / 100);
    return JNULL;
  });
  def(rt, "BlzAdjustUnitAbilityCooldownRemaining", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) setCooldown(c, id, abil(a[1]), cooldown(c, id, abil(a[1])).left + asNum(a[2]));
    return JNULL;
  });
  def(rt, "BlzAdjustUnitAbilityCooldownPercent", (c, a) => {
    const id = simOf(c, a[0]);
    if (id < 0) return JNULL;
    const cd = cooldown(c, id, abil(a[1]));
    setCooldown(c, id, abil(a[1]), cd.left + (cd.total * asNum(a[2])) / 100);
    return JNULL;
  });

  // --- queued orders (1.32) ---
  // The shift-queue, for a script: the order goes BEHIND what the unit is doing instead of
  // replacing it. The engine's own orders queue (move, attack, patrol, hold, follow); an
  // ABILITY's order cannot be queued behind another here, so it is issued if the unit is free
  // and refused otherwise — never silently issued in place of the order it was meant to follow.
  const queue = (c: NativeCtx, unitV: JassValue | undefined, orderId: number, kind: "immediate" | "point" | "target", x: number, y: number, targetV: JassValue): JassValue => {
    const id = simOf(c, unitV);
    if (id < 0) return jBool(false);
    const order = orderIdToString(orderId);
    const hooks = c.rt.hooks;
    if (!hooks?.queueUnitOrder) {
      // No queue to speak of (a headless host): the order itself is the certain half.
      return jBool(kind === "target" ? issueTargetOrder(c, id, orderId, order, targetV) : hooks?.issueUnitOrder?.(id, orderId, order, kind, x, y, 0) ?? false);
    }
    const target = kind === "target" ? unit(c, targetV)?.simId ?? 0 : 0;
    return jBool(hooks.queueUnitOrder(id, orderId, order, kind, x, y, target));
  };
  def(rt, "BlzQueueImmediateOrderById", (c, a) => queue(c, a[0], asInt(a[1]), "immediate", 0, 0, JNULL));
  def(rt, "BlzQueuePointOrderById", (c, a) => queue(c, a[0], asInt(a[1]), "point", asNum(a[2]), asNum(a[3]), JNULL));
  def(rt, "BlzQueueTargetOrderById", (c, a) => queue(c, a[0], asInt(a[1]), "target", 0, 0, a[2] ?? JNULL));
  def(rt, "BlzQueueInstantPointOrderById", (c, a) => queue(c, a[0], asInt(a[1]), "point", asNum(a[2]), asNum(a[3]), JNULL));
  def(rt, "BlzQueueInstantTargetOrderById", (c, a) => queue(c, a[0], asInt(a[1]), "target", 0, 0, a[2] ?? JNULL));
  // A build or a purchase has no queue of its own on the script's side: issued as its
  // unqueued twin, which for a worker's build IS queued behind its job by the build command.
  def(rt, "BlzQueueBuildOrderById", (c, a) => via(c, "IssueBuildOrderById", a));
  def(rt, "BlzQueueNeutralImmediateOrderById", (c, a) => via(c, "IssueNeutralImmediateOrderById", a));
  def(rt, "BlzQueueNeutralPointOrderById", (c, a) => via(c, "IssueNeutralPointOrderById", a));
  def(rt, "BlzQueueNeutralTargetOrderById", (c, a) => via(c, "IssueNeutralTargetOrderById", a));
  def(rt, "BlzGetUnitOrderCount", (c, a) => {
    const id = simOf(c, a[0]);
    return jInt(id >= 0 ? c.rt.hooks?.unitOrderCount?.(id) ?? 0 : 0);
  });
  // BlzUnitClearOrders(u, onlyQueued) / BlzUnitForceStopOrder(u, clearQueue).
  def(rt, "BlzUnitClearOrders", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.clearUnitOrders?.(id, truthy(a[1]));
    return JNULL;
  });
  def(rt, "BlzUnitForceStopOrder", (c, a) => {
    const id = simOf(c, a[0]);
    if (id >= 0) c.rt.hooks?.clearUnitOrders?.(id, false);
    return JNULL;
  });

  // --- the keyboard (1.31) ---
  // BlzTriggerRegisterPlayerKeyEvent(trigger, player, oskeytype key, metaKey, keyDown). Raised
  // by the host's keyboard (Interpreter.firePlayerKey); an `oskeytype` is the virtual-key code,
  // the meta key a bit set (METAKEY_SHIFT 1, CTRL 2, ALT 4, META 8).
  def(rt, "BlzTriggerRegisterPlayerKeyEvent", (c, a) => {
    const t = c.rt.data<TriggerObj>(a[0]);
    if (t) c.rt.triggerRegs.push({ kind: "playerKey", trigId: t.handleId, params: a.slice(1) });
    return jHandle(0, "event");
  });
  def(rt, "BlzGetTriggerPlayerKey", (c) => c.rt.eventResponse("TriggerPlayerKey"));
  def(rt, "BlzGetTriggerPlayerMetaKey", (c) => {
    const v = c.rt.eventResponse("TriggerPlayerMetaKey");
    return v.k === "int" ? v : jInt(0);
  });
  def(rt, "BlzGetTriggerPlayerIsKeyDown", (c) => {
    const v = c.rt.eventResponse("TriggerPlayerIsKeyDown");
    return v.k === "bool" ? v : jBool(false);
  });

  // --- sync data (1.31) ---
  // BlzSendSyncData(prefix, data) sends a string from one client to every client, where it
  // arrives as an event for the SENDER's player. The interpreter runs once, on the authority,
  // so there is nobody to synchronise with: the data is delivered where it was sent, to the
  // triggers registered for that player and prefix.
  def(rt, "BlzTriggerRegisterPlayerSyncEvent", (c, a) => {
    const t = c.rt.data<TriggerObj>(a[0]);
    if (t) c.rt.triggerRegs.push({ kind: "playerSync", trigId: t.handleId, params: a.slice(1) });
    return jHandle(0, "event");
  });
  def(rt, "BlzSendSyncData", (c, a) => {
    const prefix = asStr(a[0]), data = asStr(a[1]);
    const sender = c.rt.localPlayer;
    c.fireEvent?.("playerSync", new Map<string, JassValue>([
      ["TriggerPlayer", c.rt.playerHandle(sender)], ["TriggerSyncPrefix", jStr(prefix)], ["TriggerSyncData", jStr(data)],
    ]), (p) => c.rt.data<JassPlayer>(p[0] ?? JNULL)?.index === sender && asStr(p[1] ?? JNULL) === prefix);
    return jBool(true);
  });
  def(rt, "BlzGetTriggerSyncPrefix", (c) => { const v = c.rt.eventResponse("TriggerSyncPrefix"); return v.k === "string" ? v : jStr(""); });
  def(rt, "BlzGetTriggerSyncData", (c) => { const v = c.rt.eventResponse("TriggerSyncData"); return v.k === "string" ? v : jStr(""); });

  // --- the window and the pointer ---
  const client = (c: NativeCtx): { width: number; height: number } => c.rt.hooks?.clientSize?.() ?? { width: 0, height: 0 };
  def(rt, "BlzGetLocalClientWidth", (c) => jInt(client(c).width));
  def(rt, "BlzGetLocalClientHeight", (c) => jInt(client(c).height));
  def(rt, "BlzIsLocalClientActive", (c) => jBool(c.rt.hooks?.clientActive?.() ?? true));
  def(rt, "BlzGetLocale", (c) => jStr(c.rt.hooks?.localeName?.() ?? "enUS"));
  def(rt, "BlzGetMouseFocusUnit", (c) => {
    const id = c.rt.hooks?.mouseFocusUnit?.() ?? 0;
    const u = id > 0 ? c.rt.units.find((x) => x.simId === id) : undefined;
    return u ? jHandle(u.handleId, "unit") : JNULL;
  });
  // Pixels ↔ the 0.8 × 0.6 frame space, whose 4:3 box is centred in a wider window.
  const box = (c: NativeCtx): { left: number; w: number; h: number } => {
    const { width, height } = client(c);
    const w = Math.min(width, (height * 4) / 3);
    return { left: (width - w) / 2, w, h: height };
  };
  def(rt, "BlzPixelToFrameX", (c, a) => { const b = box(c); return jReal(b.w > 0 ? ((asInt(a[0]) - b.left) / b.w) * FRAME_W : 0); });
  def(rt, "BlzPixelToFrameY", (c, a) => { const b = box(c); return jReal(b.h > 0 ? (1 - asInt(a[0]) / b.h) * FRAME_H : 0); });
  def(rt, "BlzFrameToPixelX", (c, a) => { const b = box(c); return jInt(Math.round(b.left + (asNum(a[0]) / FRAME_W) * b.w)); });
  def(rt, "BlzFrameToPixelY", (c, a) => { const b = box(c); return jInt(Math.round((1 - asNum(a[0]) / FRAME_H) * b.h)); });
  // Selection (1.31's pair over the classic EnableSelect). Stored so the getters answer.
  def(rt, "BlzEnableSelections", (c, a) => {
    store(c).set("selection", truthy(a[0]) ? 1 : 0);
    store(c).set("selectionCircle", truthy(a[1]) ? 1 : 0);
    c.rt.hooks?.enableSelection?.("select", truthy(a[0]), truthy(a[1]));
    return JNULL;
  });
  def(rt, "BlzIsSelectionEnabled", (c) => jBool(Number(store(c).get("selection") ?? 1) === 1));
  def(rt, "BlzIsSelectionCircleEnabled", (c) => jBool(Number(store(c).get("selectionCircle") ?? 1) === 1));

  // --- terrain, doodads, destructables ---
  // BlzIsTerrainPathableEx — IsTerrainPathable with the polarity its NAME promises: true when
  // the cell IS pathable (the classic native answers the opposite; natives/predicates.ts).
  def(rt, "BlzIsTerrainPathableEx", (c, a) => {
    const blocked = via(c, "IsTerrainPathable", a);
    return jBool(!(blocked.k === "bool" && blocked.b));
  });
  // The map's placed doodads, by index (3.0). Read off the list the renderer keeps.
  def(rt, "BlzGetNumDoodads", (c) => jInt(c.rt.hooks?.doodadCount?.() ?? 0));
  const doodad = (c: NativeCtx, v: JassValue | undefined) => c.rt.hooks?.doodadInfo?.(asInt(v ?? JNULL));
  def(rt, "BlzGetDoodadX", (c, a) => jReal(doodad(c, a[0])?.x ?? 0));
  def(rt, "BlzGetDoodadY", (c, a) => jReal(doodad(c, a[0])?.y ?? 0));
  def(rt, "BlzGetDoodadZ", (c, a) => jReal(doodad(c, a[0])?.z ?? 0));
  for (const axis of ["X", "Y", "Z"]) def(rt, `BlzGetDoodadScale${axis}`, (c, a) => jReal(doodad(c, a[0])?.scale ?? 1));
  def(rt, "BlzGetDoodadYaw", (c, a) => jReal(doodad(c, a[0])?.yaw ?? 0));
  def(rt, "BlzGetDoodadPitch", () => jReal(0)); // a 1.30 .doo carries one angle
  def(rt, "BlzGetDoodadRoll", () => jReal(0));
  def(rt, "BlzGetDoodadIsUsingModelAxes", () => jBool(false));
  def(rt, "BlzGetDoodadVariation", (c, a) => jInt(doodad(c, a[0])?.variation ?? 0));
  def(rt, "BlzGetDoodadId", (c, a) => {
    const id = doodad(c, a[0])?.id ?? "";
    return jInt(id.length === 4 ? rawcodeToInt(id) : 0);
  });
  def(rt, "BlzSetSingleDoodadAnimation", (c, a) => (c.rt.hooks?.setSingleDoodadAnimation?.(asInt(a[0]), asStr(a[1]), truthy(a[2])), JNULL));

  // The 28 destructable creators 3.0 added are one native with every combination of four
  // options spelled into its name: Dead, Z, PitchRoll, Skin, Color. Each is the classic
  // creator it extends — `Create[Dead]Destructable[Z](objectid, x, y, [z,] face, scale,
  // variation)` — with the extra arguments read and dropped: a tilt, an HD skin and a tint are
  // the picture's, and the destructable that exists and blocks the path is the same one.
  for (const dead of [false, true]) {
    for (const z of [false, true]) {
      const base = `Create${dead ? "Dead" : ""}Destructable${z ? "Z" : ""}`;
      for (const tail of ["PitchRoll", "WithSkinPitchRoll", "WithColor", "WithSkinColor", "PitchRollWithColor", "WithSkinPitchRollColor"]) {
        const tilted = tail.includes("PitchRoll");
        def(rt, `Blz${base}${tail}`, (c, a) => {
          let i = 0;
          const head = [a[i++], a[i++], a[i++]]; // objectid, x, y
          if (z) head.push(a[i++]);
          head.push(a[i++]); // face
          if (tilted) i += 2; // roll, pitch
          head.push(a[i++], a[i++]); // scale, variation
          return via(c, base, head.map((v) => v ?? JNULL));
        });
      }
    }
  }

  // --- effects ---
  // BlzRemoveEffect — the effect goes at once; DestroyEffect is the door there is.
  def(rt, "BlzRemoveEffect", (c, a) => via(c, "DestroyEffect", a));
  // A clip by NAME (3.0), beside 1.30's by `animtype`.
  const fxId = (c: NativeCtx, v: JassValue | undefined): number | undefined => c.rt.data<{ engineId: number }>(v ?? JNULL)?.engineId;
  for (const name of ["BlzSetSpecialEffectAnimation", "BlzQueueSpecialEffectAnimation"]) {
    def(rt, name, (c, a) => {
      const id = fxId(c, a[0]);
      const word = asStr(a[1]).trim().toLowerCase();
      if (id !== undefined && word) c.rt.hooks?.playSpecialEffect?.(id, word);
      return JNULL;
    });
  }

  // --- items, saves, sound, camera: a later spelling of something the engine has ---
  def(rt, "BlzCreateItemWithSkin", (c, a) => via(c, "CreateItem", [a[0] ?? JNULL, a[1] ?? JNULL, a[2] ?? JNULL]));
  // ChooseRandomItemExWithFilter(…) — the classic draw; the equipment type and tag it filters
  // on are properties of an item system this engine does not have, so every item passes.
  for (const name of ["ChooseRandomItemExWithFilter", "ChooseRandomItemExWithFilterAndIncludes"]) {
    def(rt, name, (c, a) => via(c, "ChooseRandomItemEx", [a[0] ?? JNULL, a[1] ?? JNULL]));
  }
  // A checkpoint save is a save.
  def(rt, "SaveGameCheckpoint", (c, a) => via(c, "SaveGame", [a[0] ?? JNULL]));
  def(rt, "StartSoundEx", (c, a) => via(c, "StartSound", [a[0] ?? JNULL]));
  def(rt, "BlzCameraSetupApplyForceDurationSmooth", (c, a) => via(c, "CameraSetupApplyForceDuration", [a[0] ?? JNULL, a[1] ?? JNULL, a[2] ?? JNULL]));
  // SetTerrainFogExV(style, zstart, zend, density, …, red, green, blue) — the classic fog
  // (style, zstart, zend, density, red, green, blue) with the height/linear terms left out.
  def(rt, "SetTerrainFogExV", (c, a) => via(c, "SetTerrainFogEx", [a[0], a[1], a[2], a[3], a[8], a[9], a[10]].map((v) => v ?? JNULL)));
  // A blow's own answer to "was this an attack": DAMAGE_TYPE_NORMAL (4) is what a weapon
  // deals and no spell does. Read off the blow being dealt; false outside one.
  def(rt, "BlzGetEventIsAttack", (c) => {
    const b = c.rt.damageStack[c.rt.damageStack.length - 1];
    return jBool(!!b && b.blow.damageType === 4);
  });

  // ======================================================================================
  // STORED — written and read back; nothing here consumes them
  // ======================================================================================
  const setNum = (key: string, at = 0): NativeFn => (c, a) => (store(c).set(key, a[at]?.k === "bool" ? (a[at].b ? 1 : 0) : asNum(a[at] ?? JNULL)), JNULL);
  const getInt = (key: string, fallback: number): NativeFn => (c) => jInt(Number(store(c).get(key) ?? fallback));
  const getBool = (key: string, fallback: boolean): NativeFn => (c) => jBool(Number(store(c).get(key) ?? (fallback ? 1 : 0)) === 1);

  def(rt, "BlzEnableTargetIndicator", setNum("targetIndicator"));
  def(rt, "BlzIsTargetIndicatorEnabled", getBool("targetIndicator", true));
  def(rt, "BlzSetHUDScale", setNum("hudScale"));
  def(rt, "BlzGetHUDScale", (c) => jReal(Number(store(c).get("hudScale") ?? 100)));
  def(rt, "BlzSetMinShadowCastingPointLightCount", setNum("shadowLights"));
  def(rt, "BlzGetMinShadowCastingPointLightCount", getInt("shadowLights", 0));
  def(rt, "BlzSetCameraAllowsHotkeyTargetLock", setNum("cameraHotkeyLock"));
  def(rt, "BlzGetCameraAllowsHotkeyTargetLock", getBool("cameraHotkeyLock", true));
  def(rt, "BlzCameraSetCameraType", setNum("cameraType"));
  def(rt, "BlzCameraGetCameraType", getInt("cameraType", 0));
  def(rt, "SetCameraFieldControlledByInput", (c, a) => (store(c).set(`cameraInput:${c.rt.enumIndex(a[0])}`, truthy(a[1]) ? 1 : 0), JNULL));
  def(rt, "GetCameraFieldControlledByInput", (c, a) => jBool(Number(store(c).get(`cameraInput:${c.rt.enumIndex(a[0])}`) ?? 1) === 1));
  // Per camera setup: its label and its "type".
  const handleKey = (v: JassValue | undefined): number => (v?.k === "handle" ? v.h : 0);
  def(rt, "BlzCameraSetupSetLabel", (c, a) => (store(c).set(`setupLabel:${handleKey(a[0])}`, asStr(a[1])), JNULL));
  def(rt, "BlzCameraSetupGetLabel", (c, a) => jStr(String(store(c).get(`setupLabel:${handleKey(a[0])}`) ?? "")));
  def(rt, "BlzCameraSetupSetCameraType", (c, a) => (store(c).set(`setupType:${handleKey(a[0])}`, asInt(a[1])), JNULL));
  def(rt, "BlzCameraSetupGetCameraType", (c, a) => jInt(Number(store(c).get(`setupType:${handleKey(a[0])}`) ?? 0)));
  // Per sound: the two dialogue keys a Reforged transmission names its speaker and line by.
  const sound = (c: NativeCtx, v: JassValue | undefined): number => c.rt.data<SoundObj>(v ?? JNULL)?.handleId ?? 0;
  for (const [name, key] of [["DialogueSpeakerNameKey", "speaker"], ["DialogueTextKey", "line"]] as const) {
    def(rt, `Set${name}`, (c, a) => {
      const s = sound(c, a[0]);
      if (s) store(c).set(`${key}:${s}`, asStr(a[1]));
      return jBool(s > 0);
    });
    def(rt, `Get${name}`, (c, a) => jStr(String(store(c).get(`${key}:${sound(c, a[0])}`) ?? "")));
  }
  // Hero glow (3.0): allowed by default, the flag kept per unit.
  def(rt, "AllowHeroGlowOnUnit", (c, a) => (store(c).delete(`noGlow:${simOf(c, a[0])}`), JNULL));
  def(rt, "DisallowHeroGlowOnUnit", (c, a) => (store(c).set(`noGlow:${simOf(c, a[0])}`, 1), JNULL));
  def(rt, "HeroGlowIsAllowedOnUnit", (c, a) => jBool(!store(c).has(`noGlow:${simOf(c, a[0])}`)));
  def(rt, "SetMaxCheckpointSaves", setNum("maxCheckpoints"));

  // Minimap icons and command-button effects are HANDLES a script creates, shows, hides and
  // destroys. The objects are real, so a script that stores one and destroys it later behaves;
  // what they would draw is not: a minimap icon's art is a MODEL (a `pingPath` .mdx) on a
  // minimap we paint as a canvas, and a button effect is the autocast-style glow on a command
  // card button.
  const handleOf = (ty: string, fields: Record<string, unknown>) => (c: NativeCtx): JassValue => {
    const o = { handleId: 0, ...fields };
    o.handleId = c.rt.handles.alloc(o);
    return jHandle(o.handleId, ty);
  };
  for (const name of ["CreateMinimapIcon", "CreateMinimapIconAtLoc", "CreateMinimapIconOnUnit"]) def(rt, name, (c) => handleOf("minimapicon", { visible: true })(c));
  def(rt, "SetMinimapIconVisible", (c, a) => {
    const icon = c.rt.data<{ visible: boolean }>(a[0]);
    if (icon) icon.visible = truthy(a[1]);
    return JNULL;
  });
  def(rt, "SetMinimapIconOrphanDestroy", () => JNULL);
  def(rt, "DestroyMinimapIcon", (c, a) => (a[0]?.k === "handle" && c.rt.handles.free(a[0].h), JNULL));
  for (const name of ["CreateCommandButtonEffect", "CreateUpgradeCommandButtonEffect", "CreateLearnCommandButtonEffect"]) def(rt, name, (c) => handleOf("commandbuttoneffect", {})(c));
  def(rt, "DestroyCommandButtonEffect", (c, a) => (a[0]?.k === "handle" && c.rt.handles.free(a[0].h), JNULL));
  // The command-button click events (1.32). Registered; nothing raises them yet.
  for (const [name, kind] of [["TriggerRegisterCommandEvent", "commandEvent"], ["TriggerRegisterUpgradeCommandEvent", "upgradeCommandEvent"]] as const) {
    def(rt, name, (c, a) => {
      const t = c.rt.data<TriggerObj>(a[0]);
      if (t) c.rt.triggerRegs.push({ kind, trigId: t.handleId, params: a.slice(1) });
      return jHandle(0, "event");
    });
  }

  // ======================================================================================
  // ABSENT — systems this engine does not have
  // ======================================================================================

  // Reforged HD skins. A unit's or an item's "skin" is its own type: we draw SD out of an SD
  // install, so there is exactly one look per type (docs/map-compatibility.md).
  def(rt, "BlzGetUnitSkin", (c, a) => { const u = unit(c, a[0]); return jInt(u ? rawcodeToInt(u.typeId) : 0); });
  def(rt, "BlzGetItemSkin", (c, a) => { const it = c.rt.data<JassItem>(a[0]); return jInt(it ? rawcodeToInt(it.typeId) : 0); });
  def(rt, "SkinManagerGetLocalPath", (_c, a) => jStr(asStr(a[0]))); // no skin table: the key is its own answer

  // The 3.0 equipment, bag and loadout inventory. This engine has the classic six-slot
  // inventory and nothing else, so nothing is ever equipped or bagged: every query says so,
  // every equip is refused, and the "extended" inventory is the ordinary one.
  const NO_EQUIPMENT_FALSE = [
    "IsItemEquipped", "IsItemInBag", "UnitEquipItem", "UnitHasItemBagged", "UnitHasItemEquipped",
    "UnitHasAnyItemEquiped", "UnitHasAnyItemEquipped", "UnitHasItemEquipmentOfType", "UnitCanEquipItemOfEquipmentType",
  ];
  const NO_EQUIPMENT_NULL = [
    "GetEquippedItem", "GetUnequippedItem", "UnitUnequipItemFromSlot", "UnitItemInBagSlot", "UnitItemInEquipmentSlot",
  ];
  for (const base of NO_EQUIPMENT_FALSE) for (const name of [base, `Blz${base}`]) def(rt, name, () => jBool(false));
  for (const base of NO_EQUIPMENT_NULL) for (const name of [base, `Blz${base}`]) def(rt, name, () => JNULL);
  for (const name of ["UnitUnequipItem", "BlzUnitUnequipItem"]) def(rt, name, () => JNULL);
  // Every loadout slot is empty — there are none to fill.
  for (const name of ["UnitHasLoadoutSlotEmpty", "BlzUnitHasLoadoutSlotEmpty"]) def(rt, name, () => jBool(true));
  for (const name of ["UnitExtendedInventorySize", "BlzUnitExtendedInventorySize"]) def(rt, name, (c, a) => via(c, "UnitInventorySize", [a[0] ?? JNULL]));
  // EQUIPMENT_TYPE_NONE / ITEMTAG_TYPE_UNDEFINED are index 0 of their types.
  for (const name of ["GetItemEquipmentType", "BlzGetItemEquipmentType"]) def(rt, name, (c) => c.rt.enumHandle("EquipmentType", 0));
  for (const name of ["GetItemTag", "BlzGetItemTag"]) def(rt, name, (c) => c.rt.enumHandle("ItemTag", 0));
  // …and the item-stacking responses of 1.32, an inventory rule (charges merging on pickup)
  // this engine does not apply: no item absorbs another.
  for (const name of ["BlzGetAbsorbingItem", "BlzGetStackingItemSource", "BlzGetStackingItemTarget"]) def(rt, name, () => JNULL);
  def(rt, "BlzGetManipulatedItemWasAbsorbed", () => jBool(false));
  def(rt, "BlzGetStackingItemTargetPreviousCharges", () => jInt(0));

  // Object FIELDS with no row behind them yet. The 1.31 field API reads and writes through one
  // table (src/compat/blzFields.ts), which today holds unit, weapon and ability fields; an
  // ITEM's fields and an ability's level-ARRAY fields have no rows in it and no constants in
  // the prelude, so each getter answers its typed default and each setter answers FALSE — "the
  // write did not take", which is what the game's own boolean means and what a careful map
  // checks. An item's ability list is its TYPE's here, so adding or removing one per item is
  // refused the same way.
  for (const [kind, zero] of [["Boolean", jBool(false)], ["Integer", jInt(0)], ["Real", jReal(0)], ["String", jStr("")]] as const) {
    def(rt, `BlzGetItem${kind}Field`, () => zero);
    def(rt, `BlzSetItem${kind}Field`, () => jBool(false));
    def(rt, `BlzGetAbility${kind}LevelArrayField`, () => zero);
    for (const verb of ["Set", "Add", "Remove"]) def(rt, `Blz${verb}Ability${kind}LevelArrayField`, () => jBool(false));
  }
  def(rt, "BlzItemAddAbility", () => jBool(false));
  def(rt, "BlzItemRemoveAbility", () => jBool(false));

  // Trigger introspection (3.0): whether a trigger's actions are mid-run, and stopping them.
  // A trigger thread here is not addressable by its trigger, so neither is answered.
  def(rt, "BlzTriggerIsRunning", () => jBool(false));
  def(rt, "BlzTriggerInterrupt", () => JNULL);
  // Polled key and button state (3.0) — the keyboard reaches a script as EVENTS here
  // (BlzTriggerRegisterPlayerKeyEvent); a poll is async by nature and answers "not pressed".
  for (const name of ["BlzIsKeyPressed", "BlzIsMetaKeyPressed", "BlzIsMouseButtonPressed"]) def(rt, name, () => jBool(false));
  for (const name of ["BlzGetMouseScreenPosX", "BlzGetMouseScreenPosY"]) def(rt, name, () => jInt(0));
  // In-engine model cinematics (3.0): none is ever playing.
  for (const name of ["BlzGetModelCinematicGameShotCount", "BlzGetModelCinematicGameCurrentShot"]) def(rt, name, () => jInt(0));
  def(rt, "BlzGetModelCinematicGameRemainingTime", () => jReal(0));
  // Facial animation is a Reforged HD model feature: "not set".
  for (const name of ["SetSoundFacialAnimationLabel", "SetSoundFacialAnimationGroupLabel", "SetSoundFacialAnimationSetFilepath"]) def(rt, name, () => jBool(false));

  // The rest change only how a Reforged client DRAWS — HD water, the fog styles past the classic
  // linear one, depth of field, a tint on a doodad or an item, team glow, the HD cinematic
  // panels, screen recording — or lock a window setting. No-ops, each of them on purpose.
  for (const name of [
    // drawing
    "BlzShowTerrain", "BlzShowSkyBox", "BlzShowUnitTeamGlow", "BlzHideCinematicPanels", "SetPortraitLight",
    "CameraSetFocalDistance", "CameraSetDepthOfFieldScale", "BlzSetSpecialEffectMatrixScale", "BlzResetSpecialEffectMatrix",
    "BlzSetSpecialEffectAnimationBlendTime", "BlzSetUnitSkin", "BlzSetItemSkin", "SetPlayerRaceSkin",
    "SetDestructableColor", "SetDestructableVertexColor", "SetItemColor", "BlzSetItemColor",
    "SetDoodadColor", "SetDoodadColorRect", "BlzSetSingleDoodadColor",
    "SetHDWaterParams", "SetHDWaterParamsEx", "BlzSetHDWaterColor", "BlzSetHDWaterColorOverride",
    "BlzSetHDWaterVertexDisplacement", "BlzSetHDWaterMinOpacity", "BlzSetHDWaterMaxOpacity", "BlzSetHDWaterReflectivity",
    "BlzSetHDWaterEmissivity", "BlzSetHDWaterEdgeSoftness", "BlzSetHDWaterWaveStrength", "BlzSetHDWaterEnvMapStrength",
    "BlzSetTerrainFogStyle", "BlzSetTerrainFogZStart", "BlzSetTerrainFogZEnd", "BlzSetTerrainFogDensity",
    "BlzSetTerrainFogHeightStart", "BlzSetTerrainFogHeightEnd", "BlzSetTerrainFogLinearStart", "BlzSetTerrainFogLinearEnd",
    "BlzSetTerrainFogMaxLinearDensity", "BlzSetTerrainFogDrawOverSky", "BlzSetTerrainFogColor",
    "BlzPlayModelCinematicGameAtPosition", "BlzSetCinematicEnabledDE",
    // the window, the pointer, the recorder
    "BlzEnableCursor", "BlzSetMousePos", "BlzEnableUIAutoPosition", "BlzLockHUDScale", "BlzUnlockHUDScale",
    "BlzStartRecording", "BlzEndRecording", "EnableCameraBlocker", "AddCameraBlocker",
    // audio
    "SetCinematicAudio", "SetThematicMusicVolume", "BlzSetThematicMusicAbsoluteVolume", "BlzPauseThematicMusicOnFocusLost",
    // unit systems with nothing to switch
    "BlzUnitEnableAuras", "BlzResetUnitTalents",
  ]) {
    def(rt, name, () => JNULL);
  }
}
