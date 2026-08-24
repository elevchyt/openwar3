// Corpses as a RESOURCE — the one place "may this ability use that body?" is answered.
//
// WC3 has a whole family of abilities that spend corpses, and they arrive in three shapes
// that share everything except what stands up at the end:
//
//   • SUMMON FROM A CORPSE — one body becomes N of a FIXED type. The Rai1..Rai4 field group
//     (AbilityMetaData `useSpecific=Arai,ACrd,AUcb,AIrd,Avng`) is these rows and only these:
//     Raise Dead (2 skeletons, `uske`), the Rod of Necromancy that copies it, Carrion
//     Scarabs (`ucs1`), and the Avatar of Vengeance's Spirits (`even`).
//   • RAISE AS THEMSELVES — up to N bodies get back up as what they were. The Hre1/Hre2
//     group: Resurrection, the two Runes of Resurrection, Animate Dead and its creep and
//     item copies.
//   • CONSUME FOR AN EFFECT — the body is spent on something that is not a unit at all:
//     Cannibalize eats it for hit points.
//
// All three ask the same two questions first — WHICH bodies are in reach, and WHICH of them
// this ability is allowed to have — and the answers had drifted into four hand-written
// filters that disagreed with each other. This module is the single answer; SimWorld.
// corpsesFor / claimCorpses are its only callers, and every ability goes through those.
//
// Structural interfaces, like targeting.ts, so a test's plain object satisfies them without
// building a world.

/** The corpse fields a "may I use this?" decision reads. */
export interface CorpseKind {
  /** Already raised, eaten or loaded. A body is spent ONCE — the flag is shared by every
   *  consumer for exactly that reason (from the corpse's point of view being raised and
   *  being eaten are the same fate). */
  raised: boolean;
  /** A HERO's corpse. Never usable by anything: a fallen hero goes to the altar, and no
   *  spell in the game may raise, eat, or load one. This is the rule the old filters
   *  disagreed about most — `corpsesNear` excluded heroes, `takeCorpse` did not, so
   *  Carrion Scarabs and the Avatar's Spirits could hatch out of a dead Archmage. */
  isHero: boolean;
  /** A machine leaves a wreck, not a body. Belt-and-braces — SimWorld.spawnCorpse already
   *  declines to record one — but a custom map can hand a corpse to anything. */
  mechanical: boolean;
  /** The unit type that died. Empty means there is nothing to rebuild, which matters to the
   *  raise family (it re-creates that type) and not at all to Cannibalize. */
  unitId: string;
  /** The player who owned the unit when it fell — what `friend`/`enemy` in the ability's own
   *  Targets Allowed is measured against. */
  owner: number;
}

/** How the caster stands toward the corpse's owner, resolved by the caller (the alliance
 *  matrix lives on the world, and this module stays pure). */
export type CorpseAllegiance = "ally" | "enemy";

/**
 * WHY this ability may not use this corpse — a short reason key — or null when it may.
 *
 * `flags` is the ability's own `targs1`, read for the same two halves targeting.ts reads for
 * the living: the KIND half (which is fixed for corpses — never a hero, never a machine) and
 * the ALLEGIANCE half, which for corpses is genuinely per-ability and was being ignored:
 *
 *     [AHre] Resurrection   targs1 = air,ground,dead,friend   ← YOUR dead, nobody else's
 *     [AUan] Animate Dead   targs1 = air,ground,dead          ← anyone's
 *     [Avng] Vengeance      targs1 = air,ground,dead          ← anyone's
 *     [AUcb] Carrion Scarabs targs1 = dead                    ← anyone's
 *
 * Without it a Paladin's Resurrection stood the ENEMY's dead up and handed them to him, which
 * is not an ultimate anyone would have to think about using.
 *
 * `needsType` is for the shapes that rebuild the unit that died (raise-as-themselves) as
 * opposed to spending the body on something else (Cannibalize, a Meat Wagon's cargo).
 */
export function corpseUseError(
  c: CorpseKind,
  flags: readonly string[] = [],
  allegiance: CorpseAllegiance = "ally",
  needsType = true,
): string | null {
  if (c.raised) return "spent";
  if (c.isHero) return "hero";
  if (c.mechanical) return "mechanical";
  if (needsType && !c.unitId) return "notype";
  const F = new Set(flags.map((f) => f.toLowerCase()));
  // `player` is WC3's "own units" flag (Death Pact, Dark Ritual read it the same way) and
  // sits beside `friend` here; Ancestral Spirit is the row that carries it
  // (`ground,player,dead` — a Spirit Walker may only bring back his own kind).
  const friend = F.has("friend") || F.has("player");
  const enemy = F.has("enemy");
  if (friend && !enemy && allegiance !== "ally") return "notfriendly";
  if (enemy && !friend && allegiance !== "enemy") return "notenemy";
  return null;
}

/** Does this ability admit this corpse? */
export function corpseAdmits(
  c: CorpseKind,
  flags: readonly string[] = [],
  allegiance: CorpseAllegiance = "ally",
  needsType = true,
): boolean {
  return corpseUseError(c, flags, allegiance, needsType) === null;
}

/** How a claim picks when more bodies are in reach than it wants.
 *  `nearest` — the body you are standing on (Cannibalize, Carrion Scarabs, Raise Dead).
 *  `freshest` — most decay left, which is how a sweep that takes SEVERAL should choose
 *  (Resurrection, Animate Dead): the ones that have been dead longest go last. */
export type CorpseOrder = "nearest" | "freshest";
