// Targets Allowed — WC3's `targs1`, and the one place its unit-KIND half is read.
//
// Every ability row in `Units\AbilityData.slk` carries a `targs1` list: what that ability
// may be aimed at or may strike (`ground,structure`, `air,ground,enemy,neutral,organic`,
// `_` for "anything"). It has two halves that behave very differently:
//
//   • the KIND half — air / ground / structure, organic, hero / nonhero, nonancient — which
//     is reliable data for every ability in the game, and lives here;
//   • the ALLEGIANCE half — enemy / friend / self / neutral / notself — which is reliable
//     for anything the player AIMS, but is simply absent from most hardcoded nukes (Shock
//     Wave is `ground,structure`, Carrion Swarm `ground,air`), so reading allegiance out of
//     it would invent friendly fire the real game does not have. That half stays with the
//     caller (SimWorld.targetAllowed for a cast, the handler for a nuke).
//
// Splitting the kind half out is what lets ONE implementation serve every caller that used
// to answer this question for itself: a single-target cast, an area effect and its green
// preview, a spell handler's target sweep, and an orb riding a blow. Each of those used to
// hand-write its own approximation (`if (t.flying) continue`, a `hitBuildings` argument,
// or nothing at all), and the approximations drifted from the table they were copied from.

/** The unit fields a Targets Allowed decision reads. Structural, so both the sim's SimUnit
 *  and a test's plain object satisfy it. */
export interface TargetKind {
  isHero: boolean;
  mechanical: boolean;
  building: unknown; // truthy for a structure (the sim carries the building state object)
  flying: boolean;
  ancient?: boolean;
  /** RESISTANT SKIN (`Arsk`) — Mountain Giant, Tauren, Spirit Walker, Infernal, Phoenix,
   *  Avatar of Vengeance. "Resistant units are treated as if they were heroes. They follow
   *  the same targeting behavior as heroes and effects last on resistant units as long as
   *  they would last on heroes." (Liquipedia, Resistant Skin.) So it is not a list of
   *  blocked spells: it is the `hero`/`nonhero` flags reading true for a unit that is not
   *  one — Charm and Polymorph name `nonhero` and refuse it, and anything hero-only accepts
   *  it. The DURATION half of the same rule is `dur()` in spells.ts. */
  resistant?: boolean;
}

/**
 * WHY this ability may not strike this KIND of unit — a `commandstrings.txt` [Errors] key
 * — or null when it may. Allegiance is not consulted (see the file header).
 */
export function targsKindError(target: TargetKind, flags: readonly string[] = []): string | null {
  const F = new Set((flags ?? []).map((f) => f.toLowerCase()));
  // Clear-cut unit-type gates.
  const heroLike = target.isHero || !!target.resistant; // Resistant Skin — see TargetKind.resistant
  if (F.has("nonhero") && heroLike) return "Nohero";
  if (F.has("hero") && !heroLike) return "Targethero";
  // "organic" is the absence of the two inorganic kinds — WC3 has no organic flag on the
  // unit, it has `mechanical` in UnitData and buildings, and everything else is flesh.
  if (F.has("organic") && (target.mechanical || target.building)) return "Notmechanical"; // "Must target organic units."
  // What the target IS — the same air/structure/ground classification weaponVs() applies to
  // Targets Allowed, and for the same reason: a building is NOT "ground" (see the
  // Chimaera/Mortar Team note there). Spells read the identical flags, so the rule is
  // shared rather than re-derived.
  //
  // `ground` and `air` are the two commonest flags in the table (391 and 296 of the 799
  // rows) and they are an ALLOW-list: Entangling Roots is `ground,enemy,neutral,organic`
  // and may not root a Gryphon; the Batrider's Unstable Concoction is `air,neutral,enemy`
  // and may not be spent on a Grunt. Refusals are the game's own words — commandstrings.txt
  // [Errors] Noair/Noground/Nostructure.
  //
  // Gated only when the data names a target kind at all: plenty of rows restrict by
  // allegiance alone (Absorb Mana is `player,vuln,invu`) and stay unrestricted.
  // A structure-ONLY ability keeps the game's positive wording ("Must target a building.")
  // rather than the generic refusal — that is what Repair says when aimed at a Footman.
  if (F.has("structure") && !F.has("ground") && !F.has("air") && !target.building) return "Targetstructure";
  // `nonancient` — an EXCLUSION, not an allow-list entry, and the only one in the table
  // shaped that way. It is what keeps a Peasant from repairing a Tree of Life: Repair,
  // Restoration and the orc's Repair all list it and only the night elf's Renew does not
  // (see repairRefusal). commandstrings.txt [Errors] Notancient = "Unable to target
  // Ancients." — which exists for precisely this flag and nothing else.
  if (F.has("nonancient") && target.ancient) return "Notancient";
  if (F.has("air") || F.has("ground") || F.has("structure")) {
    const kind = target.building ? "structure" : target.flying ? "air" : "ground";
    if (!F.has(kind)) return kind === "air" ? "Noair" : kind === "structure" ? "Nostructure" : "Noground";
  }
  return null;
}

/** Does the ability's `targs1` admit this unit as a target kind? */
export function targsAdmit(target: TargetKind, flags: readonly string[] = []): boolean {
  return targsKindError(target, flags) === null;
}
