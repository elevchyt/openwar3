// Target RULES — the half of "may this ability be aimed at that unit?" that no Targets Allowed
// list can state, gathered into ONE registry that every door asks through the same function
// (`SimWorld.targetError`): a spell clicked off the command card, an item pressed out of the
// inventory, an autocast, a computer's choice, a JASS order and a command off the wire.
//
// `targs1` (src/sim/targeting.ts) answers what KIND of unit and what ALLEGIANCE. Some abilities
// want something the vocabulary has no word for — "a unit with a mana bar", "an Undead", "not a
// summon" — and the engine keeps those rules itself. The data gives that away in the same way
// every time: `Units\CommandStrings.txt` [Errors] ships a line for a refusal that no row could
// ever earn through its flags (`Targetmanauser`, `Targetundead`, `Notsummoned`, `Needsummoned`,
// `Creeptoopowerful`), and the ability's Ubertip states the rule in words.
//
// These rules used to live in five places: three tables in spells.ts, a code→column map in
// world.ts, and two `if (ad.code === …)` lines inside `itemUseError` that only the ITEM button
// ever asked — so Control Magic's "summoned units only" held for the Gloves of Spell Mastery and
// not for the Spell Breaker's own button, and a Wand of Mana Stealing could be aimed at an Arcane
// Vault because nobody had written its line at all. A rule belongs to the ABILITY, keyed on its
// base `code` (so an item's row, a creep's twin and a map's own ability built on the same base
// all inherit it), and is answered once, for every door.
//
// What is NOT here: a rule that needs the caster's side as well as the target (the polarity
// spells — POLARITY_SPELLS in spells.ts, which the AI also reads to decide heal-or-harm), and
// the "would this achieve anything" refusals (a heal at full health, a replenish with nobody to
// restore), which are about the cast's effect rather than about who may be picked.

export type TargetRule =
  /** The target must HAVE a mana pool. A pool of zero is the test, not an empty one: a drained
   *  Sorceress is still a caster and burning her nothing is a legal, useless cast — a Footman
   *  or an Arcane Vault has no mana bar at all and may not be picked. A BUILDING with a pool is
   *  a legal target: a Moon Well (`emow` mana0 100 / manaN 300) may be robbed by the wand. */
  | { kind: "manaPool"; error: string }
  /** The target must be UNDEAD by CLASSIFICATION (UnitBalance.slk `type`, common.j's
   *  UNIT_TYPE_UNDEAD), not by race: a Meat Wagon is race `undead` but `type` = `Mechanical`. */
  | { kind: "undeadClass"; error: string }
  /** The target may not be a summoned unit — an illusion counts, being a summon in every reading
   *  the sim makes of one. */
  | { kind: "notSummon"; error: string }
  /** The target MUST be a summoned unit (on a summon clock). */
  | { kind: "summonOnly"; error: string }
  /** A CREEP (anything Neutral Hostile owns) above the level in this Data column of the
   *  ability's own row is "too powerful" — read off the row rather than a constant, so a map
   *  that retunes the column retunes the cap. 0 in the column means no cap. */
  | { kind: "creepLevel"; column: number; error: string };

const manaPool = (error: string): TargetRule => ({ kind: "manaPool", error });
const undeadClass = (error: string): TargetRule => ({ kind: "undeadClass", error });
const notSummon = (error: string): TargetRule => ({ kind: "notSummon", error });
const summonOnly = (error: string): TargetRule => ({ kind: "summonOnly", error });
const creepLevel = (column: number): TargetRule => ({ kind: "creepLevel", column, error: "Creeptoopowerful" });

/**
 * Every ability's target rules, by base `code`, in the order they are asked (the first refusal
 * is the line the player reads).
 */
export const TARGET_RULES: Readonly<Record<string, readonly TargetRule[]>> = {
  // ── needs a mana pool ─────────────────────────────────────────────────────────────────────
  // Mana Burn's `targs1` is `air,ground,enemy,organic,nonancient,vuln,invu`, which a Footman
  // satisfies in full, and commandstrings.txt ships a line written for exactly this one ability:
  // `Cantmanaburn` = "Unable to cast Mana Burn on this target."
  AEmb: [manaPool("Cantmanaburn")], // Demon Hunter — Mana Burn (and every row built on it)
  // Wand of Mana Stealing — "Steals mana from a target unit and gives it to the Hero" (ItemStrings
  // [woms] Ubertip). Its `targs1` is `notself` and NOTHING else: no kind word at all, so the flags
  // admit a building, and what refuses the Arcane Vault is that it has no mana to steal. The line
  // is the general-purpose one beside Cantmanaburn: `Targetmanauser` = "Must target a unit with
  // mana." The Moon Well, which has a pool, stays a legal target (the developer's observation of
  // the real client: the wand drains a Moon Well and hands the mana to the hero).
  Aste: [manaPool("Targetmanauser")],

  // ── needs an Undead ───────────────────────────────────────────────────────────────────────
  // The sacrifices take a "friendly Undead unit" (both Ubertips, word for word), and both rows
  // read `air,ground,player,nonhero,invu,vuln`, which a Meat Wagon satisfies in full. The line is
  // the game's own: `Targetundead` = "Must target an Undead unit."
  AUdp: [undeadClass("Targetundead")], // Death Knight — Death Pact
  AUdr: [undeadClass("Targetundead")], // Lich — Dark Ritual

  // ── may not take a summon ─────────────────────────────────────────────────────────────────
  // THE TRANSFORMS — "Casting Hex on a summoned unit does nothing… summoned units are immune to
  // being hexed by design" (classic.battle.net, Shadow Hunter); Polymorph carries the same
  // clause. `UI\UnitEditorData.txt` [targetList] has no "summoned" entry in 1.30.4, and yet
  // [Errors] ships `Notsummoned` = "Unable to target summoned units." — a line written for a rule
  // no row can state is the engine telling us it keeps that rule itself. A summon is on a clock
  // already, and a critter takes no damage it cannot dodge and gives none, so Hex would otherwise
  // be the cheapest possible ANSWER to every summon in the game.
  // The creep rows are aliases of these two (`AChx` and Rokhan's `ANhx` are code `AOhx`, `ACpy`
  // is code `Aply`), so they arrive here under the base code with nothing listed for them.
  AOhx: [notSummon("Notsummoned")], // Shadow Hunter — Hex
  Aply: [notSummon("Notsummoned")], // Sorceress — Polymorph
  // Transmute (issue #204) — the same refusal for a different reason: a summon has no `goldcost`
  // to be melted down into (UnitBalance prices a Water Elemental at 0), so the ultimate would be
  // a kill that pays nothing. Liquipedia (Alchemist): "Can not target summoned units." Its other
  // rule is the creep cap: "Transmute cannot be used on Heroes, or creeps above level
  // <ANtm,DataC1>" — the hero half is the row's own `nonhero`, the level half is DataC (= 5).
  ANtm: [notSummon("Notsummoned"), creepLevel(2)],
  // The staves — Staff of Preservation (`ANpr`) and Staff of Sanctuary (`ANsa`): "Cannot target
  // summoned units." (Liquipedia, both pages). A Water Elemental has no home to be sent to.
  ANpr: [notSummon("Notsummoned")],
  ANsa: [notSummon("Notsummoned")],

  // ── must take a summon ────────────────────────────────────────────────────────────────────
  // Control Magic — "Takes control of an enemy summoned unit" (HumanAbilityStrings [Acmg]), on
  // the Spell Breaker's own card and on the Gloves of Spell Mastery (`AIcm`, code `Acmg`) alike.
  // `Needsummoned` = "Must target summoned units." — the positive line, not `Notsummoned`.
  // `Nch1` "Maximum Creep Level" (DataA) is declared for `ANch,ACch,Acmg` in AbilityMetaData.
  Acmg: [summonOnly("Needsummoned"), creepLevel(0)],

  // ── creep level caps ──────────────────────────────────────────────────────────────────────
  // Charm — "Charm cannot be used on Heroes, or creeps above level <ANch,DataA1>." (the hero half
  // is the row's `nonhero`). `Nch1` is DataA, as above.
  ANch: [creepLevel(0)],
  // Scepter of Mastery — Charm with an item's numbers: `Icre` "Maximum Creep Level" is DataA on
  // `AIco` (AbilityMetaData), "Cannot be used on Heroes or on creeps higher than level <AIco,DataA1>."
  AIco: [creepLevel(0)],
  // DEVOUR — `Dev1` **"Max Creep Level"** for `useSpecific = "Adev,ACdv"`, i.e. DataA on both the
  // Kodo's row and the creeps'. Without it a Kodo Beast swallowed a level 10 Dragon whole.
  Adev: [creepLevel(0)],
  ACdv: [creepLevel(0)],
};

/** The rules an ability with this base code carries — empty for most of them. */
export function targetRulesOf(code: string): readonly TargetRule[] {
  return TARGET_RULES[code] ?? NO_RULES;
}
const NO_RULES: readonly TargetRule[] = [];
