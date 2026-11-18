// What an ability, an item and a clip are CALLED and DRAWN with, read and rewritten by a
// script (issue #313). All of it is in the install's own 1.30.4 `Scripts\common.j`.
//
//   * The classic "spell effect" family — `GetAbilityEffectById`, `GetAbilitySoundById`,
//     `AddSpellEffectById…` — which reach an ability's art through the object, not through a
//     path the script has to know. Blizzard.j wraps the two getters (2002, 2007).
//   * 1.29's button natives: the tooltip, icon and card position of an ability's OTHER two
//     faces — its "turn off" twin (`…Activated…`, the row's `Un*` columns) and its learn-skill
//     page (`…Research…`) — beside the plain face natives/abilityBlz.ts already answers.
//   * One ITEM's own words and icon.
//
// **The by-NAME halves do nothing, and that is the game's behaviour, not a gap.** `AbilityId`
// "always returns zero. Apparently ability names were never implemented" and `AbilityId2String`
// "always returns an empty string" (jassdoc), and the four natives that take an
// `abilityString` — `GetAbilityEffect`, `GetAbilitySound`, `AddSpellEffect`, `AddSpellEffectLoc`,
// `AddSpellEffectTarget` — "do nothing because no one knows what abilityString is supposed to
// be". A unit type has an internal name (`UnitId("footman")`, UnitUI `name`); an ability row
// has none, so there is nothing for them to look up. They are registered to answer exactly that
// rather than left to log "not implemented" on every call.
//
// A LEVEL is counted from the map's own base (`Runtime.blzIndexBase`), as in abilityBlz.ts.

import { intToRawcode } from "../lexer";
import type { JassItem, JassPlayer, NativeCtx, Runtime } from "../runtime";
import { asInt, asStr, jInt, JNULL, jStr, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const abil = (v: JassValue | undefined): string => intToRawcode(asInt(v ?? JNULL));
const rankOf = (c: NativeCtx, v: JassValue | undefined): number => asInt(v ?? JNULL) - c.rt.blzIndexBase;

type Face = "normal" | "activated" | "research";
type FaceField = "tip" | "ubertip" | "icon" | "x" | "y";

/** `ANIM_TYPE_*` by its ConvertAnimType index (common.j 303–313), as BlzGetAnimName spells it. */
const ANIM_NAMES = ["birth", "death", "decay", "dissipate", "stand", "walk", "attack", "morph", "sleep", "spell", "portrait"];

export function registerAbilityInfoNatives(rt: Runtime): void {
  // --- ability names: never implemented by the game (see the header) ---
  def(rt, "AbilityId", () => jInt(0));
  def(rt, "AbilityId2String", () => jStr(""));
  def(rt, "GetAbilityEffect", () => jStr(""));
  def(rt, "GetAbilitySound", () => jStr(""));
  for (const name of ["AddSpellEffect", "AddSpellEffectLoc", "AddSpellEffectTarget"]) def(rt, name, () => JNULL);

  // --- an ability's art, by object id ---
  // GetAbilityEffectById(abilityId, effecttype, index) — the `index`th model of one art field.
  // GetAbilitySoundById(abilityId, soundtype) — the sound LABEL the row names (what
  // CreateSoundFromLabel takes), not a file path.
  def(rt, "GetAbilityEffectById", (c, a) => jStr(c.rt.hooks?.abilityArt?.(abil(a[0]), c.rt.enumIndex(a[1]), asInt(a[2])) ?? ""));
  def(rt, "GetAbilitySoundById", (c, a) => jStr(c.rt.hooks?.abilitySound?.(abil(a[0]), c.rt.enumIndex(a[1])) ?? ""));

  // AddSpellEffectById / …ByIdLoc / …TargetById — "Creates the special effect … using the model
  // file from the Object Editor field of type t … If this field has more than one effect
  // inside, it will only create the first" (jassdoc). So each is the matching AddSpecialEffect
  // with the path looked up first, and is routed through that native: the `effect` handle it
  // hands back is the ordinary one, which DestroyEffect and the BlzSetSpecialEffect… family take.
  const artOf = (c: NativeCtx, abilV: JassValue, typeV: JassValue): string =>
    c.rt.hooks?.abilityArt?.(abil(abilV), c.rt.enumIndex(typeV), 0) ?? "";
  const via = (c: NativeCtx, native: string, args: JassValue[]): JassValue => c.rt.natives.get(native)?.(c, args) ?? JNULL;
  def(rt, "AddSpellEffectById", (c, a) => {
    const path = artOf(c, a[0], a[1]);
    return path ? via(c, "AddSpecialEffect", [jStr(path), a[2], a[3]]) : JNULL;
  });
  def(rt, "AddSpellEffectByIdLoc", (c, a) => {
    const path = artOf(c, a[0], a[1]);
    return path ? via(c, "AddSpecialEffectLoc", [jStr(path), a[2]]) : JNULL;
  });
  def(rt, "AddSpellEffectTargetById", (c, a) => {
    const path = artOf(c, a[0], a[1]);
    return path ? via(c, "AddSpecialEffectTarget", [jStr(path), a[2], a[3]]) : JNULL;
  });

  // --- an ability's button: the three faces ---
  const read = (c: NativeCtx, id: string, face: Face, field: FaceField, rank: number) => c.rt.hooks?.abilityFace?.(id, face, field, rank);
  const str = (face: Face, field: FaceField, leveled: boolean): NativeFn => (c, a) =>
    jStr(String(read(c, abil(a[0]), face, field, leveled ? rankOf(c, a[1]) : 0) ?? ""));
  const int = (face: Face, field: FaceField): NativeFn => (c, a) => jInt(Number(read(c, abil(a[0]), face, field, 0) ?? 0));
  /** `BlzSet…(abilCode, value, level)` — the value comes SECOND, the level last. */
  const write = (face: Face, field: FaceField, leveled: boolean, numeric: boolean): NativeFn => (c, a) => {
    c.rt.hooks?.setAbilityFace?.(abil(a[0]), face, field, leveled ? rankOf(c, a[2]) : 0, numeric ? asInt(a[1]) : asStr(a[1]));
    return JNULL;
  };
  def(rt, "BlzGetAbilityActivatedTooltip", str("activated", "tip", true));
  def(rt, "BlzGetAbilityActivatedExtendedTooltip", str("activated", "ubertip", true));
  def(rt, "BlzGetAbilityResearchTooltip", str("research", "tip", true));
  def(rt, "BlzGetAbilityResearchExtendedTooltip", str("research", "ubertip", true));
  def(rt, "BlzGetAbilityActivatedIcon", str("activated", "icon", false));
  def(rt, "BlzSetAbilityActivatedTooltip", write("activated", "tip", true, false));
  def(rt, "BlzSetAbilityActivatedExtendedTooltip", write("activated", "ubertip", true, false));
  def(rt, "BlzSetAbilityResearchTooltip", write("research", "tip", true, false));
  def(rt, "BlzSetAbilityResearchExtendedTooltip", write("research", "ubertip", true, false));
  def(rt, "BlzSetAbilityActivatedIcon", write("activated", "icon", false, false));
  // Card position: column (X, 0–3) and row (Y, 0–2) of "the default 4x3 grid" (jassdoc).
  def(rt, "BlzGetAbilityPosX", int("normal", "x"));
  def(rt, "BlzGetAbilityPosY", int("normal", "y"));
  def(rt, "BlzGetAbilityActivatedPosX", int("activated", "x"));
  def(rt, "BlzGetAbilityActivatedPosY", int("activated", "y"));
  def(rt, "BlzSetAbilityPosX", write("normal", "x", false, true));
  def(rt, "BlzSetAbilityPosY", write("normal", "y", false, true));
  def(rt, "BlzSetAbilityActivatedPosX", write("activated", "x", false, true));
  def(rt, "BlzSetAbilityActivatedPosY", write("activated", "y", false, true));

  // --- one item's words and icon (its entity, not its type) ---
  const item = (c: NativeCtx, v: JassValue): number => {
    const it = c.rt.data<JassItem>(v);
    return it && it.simId >= 0 ? it.simId : -1;
  };
  type ItemField = "name" | "tooltip" | "description" | "ubertip" | "icon";
  const itemGet = (field: ItemField): NativeFn => (c, a) => {
    const id = item(c, a[0]);
    return jStr(id >= 0 ? c.rt.hooks?.itemText?.(id, field) ?? "" : "");
  };
  const itemSet = (field: ItemField): NativeFn => (c, a) => {
    const id = item(c, a[0]);
    if (id >= 0) c.rt.hooks?.setItemText?.(id, field, asStr(a[1]));
    return JNULL;
  };
  def(rt, "BlzGetItemTooltip", itemGet("tooltip"));
  def(rt, "BlzGetItemDescription", itemGet("description"));
  def(rt, "BlzGetItemExtendedTooltip", itemGet("ubertip"));
  def(rt, "BlzGetItemIconPath", itemGet("icon"));
  def(rt, "BlzSetItemTooltip", itemSet("tooltip"));
  def(rt, "BlzSetItemDescription", itemSet("description"));
  def(rt, "BlzSetItemIconPath", itemSet("icon"));
  // "Change(set) the item name at runtime. @bug Doesn't work." (jassdoc) — so it does not here.
  def(rt, "BlzSetItemName", () => JNULL);

  // BlzDecPlayerTechResearched(player, techid, levels) — AddPlayerTechResearched's opposite
  // number, and one-directional: "this native does not allow for an increment by setting the
  // integer to negative" (jassdoc). Written through the same pair of hooks the Set/Add forms use.
  def(rt, "BlzDecPlayerTechResearched", (c, a) => {
    const player = c.rt.data<JassPlayer>(a[0])?.index ?? -1;
    const tech = abil(a[1]);
    const levels = asInt(a[2]);
    if (player < 0 || levels <= 0) return JNULL;
    const have = c.rt.hooks?.playerTechCount?.(player, tech, false) ?? 0;
    if (have > 0) c.rt.hooks?.setPlayerTechResearched?.(player, tech, Math.max(0, have - levels));
    return JNULL;
  });

  // BlzGetAnimName(animtype) — "the string representation of the name of the animation".
  def(rt, "BlzGetAnimName", (c, a) => jStr(ANIM_NAMES[c.rt.enumIndex(a[0] ?? JNULL)] ?? ""));

  // The mouse responses of 1.29's EVENT_PLAYER_MOUSE_DOWN/UP/MOVE. Nothing raises those three
  // events yet, so outside one there is no position to report: each answers the response on the
  // event stack and its typed zero when there is none — which is what the game answers outside a
  // mouse event too.
  const mouse = (key: string): NativeFn => (c) => {
    const v = c.rt.eventResponse(key);
    return v.k === "real" ? v : { k: "real", n: 0 };
  };
  def(rt, "BlzGetTriggerPlayerMouseX", mouse("MouseX"));
  def(rt, "BlzGetTriggerPlayerMouseY", mouse("MouseY"));
  def(rt, "BlzGetTriggerPlayerMousePosition", (c) => {
    const x = c.rt.eventResponse("MouseX"), y = c.rt.eventResponse("MouseY");
    const l = { handleId: 0, x: x.k === "real" ? x.n : 0, y: y.k === "real" ? y.n : 0 };
    l.handleId = c.rt.handles.alloc(l);
    return { k: "handle", h: l.handleId, ty: "location" };
  });
  def(rt, "BlzGetTriggerPlayerMouseButton", (c) => c.rt.eventResponse("MouseButton"));
}
