// Corpses as a RESOURCE — the one place "may this ability use that body?" is answered.
//
// WC3 has a whole family of abilities built on corpses, and they arrive in four shapes that
// share everything except what happens to the body at the end:
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
//   • CARRY — the Meat Wagon, which spends nothing: it picks bodies up (`Amel`, autocast),
//     drives them somewhere, and drops them again (`Amed`). Its cargo stays usable the whole
//     time; the corpses simply travel with it. That is the fourth shape, and the reason the
//     query above has to know about `heldBy` at all.
//
// All four ask the same two questions first — WHICH bodies are in reach, and WHICH of them
// this ability is allowed to have — and the answers had drifted into four hand-written
// filters that disagreed with each other. This module is the single answer; SimWorld.
// corpsesFor / claimCorpses are its only callers, and every ability goes through those.
//
// Structural interfaces, like targeting.ts, so a test's plain object satisfies them without
// building a world.

/** The corpse fields a "may I use this?" decision reads. */
export interface CorpseKind {
  /** SPENT: raised or eaten, and gone for good. One flag for every consumer, because from the
   *  corpse's point of view being raised and being eaten are the same fate. Loading is NOT
   *  this — see `heldBy`; a wagon borrows a body, it does not use it up. */
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
  /** The unit CARRYING this body (0 = it is lying on the ground). A Meat Wagon's cargo.
   *
   *  Being carried is not the same as being spent: a held corpse is still perfectly good, and
   *  WC3 is explicit that it stays usable where it is — "Dropping corpses is not required for
   *  Necromancers to cast Raise Dead" (Liquipedia, Meat Wagon). What changes is only WHERE it
   *  is: it answers at the wagon's position, so a Necromancer beside the wagon can raise out
   *  of it, and the wagon can be driven to where the bodies are wanted.
   *
   *  The one thing it does forbid is being loaded a second time — see `forLoad`. */
  heldBy: number;
}

/** What a claim intends to do with the bodies it takes. */
export interface CorpseNeed {
  /** Only bodies that can be LOADED: not already in someone's cargo. Everything else may use
   *  a held corpse exactly as it would one on the ground. */
  forLoad?: boolean;
  /** The taker rebuilds the unit that died, so it needs to know what that was. False for a
   *  consumer that spends the body on something else (Cannibalize does not care). */
  needsType?: boolean;
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
 * `need` is what the taker intends: whether it must know what died (it is rebuilding that
 * unit) and whether the body has to be free to LOAD (see CorpseNeed).
 */
export function corpseUseError(
  c: CorpseKind,
  flags: readonly string[] = [],
  allegiance: CorpseAllegiance = "ally",
  need: CorpseNeed = {},
): string | null {
  if (c.raised) return "spent";
  if (c.isHero) return "hero";
  if (c.mechanical) return "mechanical";
  if (need.forLoad && c.heldBy) return "held"; // already in a wagon — one cargo at a time
  if (need.needsType !== false && !c.unitId) return "notype";
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
  need: CorpseNeed = {},
): boolean {
  return corpseUseError(c, flags, allegiance, need) === null;
}

/** How a claim picks when more bodies are in reach than it wants.
 *  `nearest` — the body you are standing on (Cannibalize, Carrion Scarabs, Raise Dead).
 *  `freshest` — most decay left, which is how a sweep that takes SEVERAL should choose
 *  (Resurrection, Animate Dead): the ones that have been dead longest go last. */
export type CorpseOrder = "nearest" | "freshest";
