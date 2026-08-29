import { isRepairCode, NO_AOE_CURSOR, type AbilityDef, type AbilityLevel } from "../../data/abilities";
import type { SimUnit } from "../../sim/world";
import { friendlySpell, near, waveDistance, type CasterView } from "../casting";
import { MELEE_INSANE, MELEE_NEWBIE } from "../ids";
import type { PlusProfile } from "./profile";
import { aimCtx, spellFacts, spellValue, type AimCtx } from "./targeting";

// Computer+ — when its units press their buttons (issue #124).
//
// The classic caster (src/ai/casting.ts) is a TRANSCRIPTION: one hiveworkshop thread of
// observations of the real client, one `CAST_RULES` row per ability, quoting the line it came
// from, and a blanket refusal to touch anything the thread does not describe — including,
// explicitly, "transform abilities like Destroyer Form/Bear Form/Crow Form". It reproduces
// Blizzard's AI, warts included, and that is exactly what it is for.
//
// This one has a different job, stated in issue #124: "a separate one that is more
// intelligent, more human like and it must utilize ALL abilities, especially things like Bear
// Form". So it is not a table of abilities at all. It is:
//
//   1. a ROLE for every ability — what the button is FOR (`ROLES` below, with a derivation
//      from the ability's own row for anything unlisted, so a custom map's spells are played
//      rather than ignored);
//   2. a PRIORITY over those roles — a caster presses its most valuable legal button, not the
//      first one on its command card, which is the single biggest difference in how the two
//      read to play against;
//   3. TARGET VALUE — casters over footmen, the wounded for a nuke and the healthy for a
//      disable, workers when raiding, and a hero only when it can actually be finished. The
//      ladder itself lives in plus/targeting.ts, because the ARMY aims by the same one: a
//      Mountain King who stuns the Tauren while every Footman beside him swings at the Shaman
//      is worse than either decision taken alone;
//   4. a REACTION DELAY, because a human does not Storm Bolt on the first frame of a fight —
//      a smaller ROLE VOCABULARY at the lower difficulties, because a novice does not use half
//      these buttons at all, and a WORSE READ of the fight at those difficulties too
//      (`PlusProfile.castTargeting`): an easy computer aims at the biggest body on the screen,
//      which is how its Storm Bolt ends up on your Tauren.
//
// What it keeps from the classic caster, and must: LEGALITY is the sim's. `castUseError` /
// `castError` are the click-time gates — mana, cooldown, the upgrade requirement, Targets
// Allowed, spell polarity, "is there even a corpse" — so this can never be more permissive
// than the button a player presses, and every cast still leaves through `RtsController.execute`.
// Autocast is also still the sim's (`SimWorld.tickAutocast`); the caster only arms it.

/** What a button is FOR. The ladder is the priority order, highest first — see `roleRank`. */
export type Role =
  /** Save yourself, right now: Divine Shield, Avatar, Mana Shield, Wind Walk, Cannibalize. */
  | "panic"
  /** Put hit points back on somebody (or back on their feet). */
  | "heal"
  /** Change shape — the family the classic caster refuses outright. */
  | "morph"
  /** Take an enemy OUT of the fight: stuns, holds, polymorphs, silences. */
  | "disable"
  /** Damage. */
  | "nuke"
  /** Put another body on the field. */
  | "summon"
  /** Make our side better at fighting. */
  | "buff"
  /** Make their side worse at it, without removing them. */
  | "debuff"
  /** Worth pressing in a fight, but nothing above describes it. */
  | "utility";

const LADDER: readonly Role[] = ["panic", "heal", "morph", "disable", "nuke", "summon", "buff", "debuff", "utility"];
const roleRank = (r: Role): number => LADDER.indexOf(r);

/**
 * Every base ability the four melee races own, by role.
 *
 * Grouped by ROLE rather than listed per ability, because the role is the only thing this file
 * needs and a list of ninety single-entry rows would say less. Where an ability could
 * plausibly sit in two groups the choice is written out; everything else is its tooltip.
 */
const ROLES: Partial<Record<Role, readonly string[]>> = {
  panic: [
    "AHds", // Divine Shield
    "AHav", // Avatar
    "ANms", // Mana Shield
    "AOwk", // Wind Walk — the Blademaster's way out of a fight he is losing
    "Acan", // Cannibalize — a Ghoul eating a body IS its heal
    "AEbl", // Blink — an ESCAPE here and nothing else. The classic caster refuses it because
            // the thread records nothing about when the engine blinks; used only to leave a
            // fight the hero is losing, a wrong guess costs one hero one hop.
  ],
  heal: [
    "AHhb", // Holy Light
    "AUdc", // Death Coil — the same button on the other polarity; POLARITY_SPELLS decides who
            // each may touch, so both are simply "heal" here
    "AOhw", // Healing Wave
    "Arej", // Rejuvenation
    "AEtq", // Tranquility
    "AHre", // Resurrection — a heal that works on the dead
    "AUan", // Animate Dead
  ],
  morph: [
    "Abrf", // Bear Form — issue #124's named example, and the fighting form of the Druid
    "AEme", // Metamorphosis
    "ANcr", // Chemical Rage
    "ANrg", // Robo-Goblin
    "ANef", // Storm, Earth and Fire
    "Abur", // Burrow — a Crypt Fiend hiding to regenerate (see MORPH_WHEN)
  ],
  disable: [
    "AHtb", "ANfb", // Storm Bolt / Fire Bolt
    "AOhx", // Hex
    "AUsl", // Sleep
    "AHbn", // Banish
    "AEer", // Entangling Roots
    "ANdo", // Doom
    "ANsi", // Silence
    "AHtc", "AOws", // Thunder Clap / War Stomp — damage as well, but a stun that lands on the
                    // whole enemy line is worth more than the damage and is what opens a fight
    "AUim", // Impale
    "Asta", // Stasis Trap
    "ANch", // Charm
    "Adev", // Devour
    "Aprg", // Purge — a slow as much as a dispel
  ],
  nuke: [
    "AOcl", "ANfl", // Chain Lightning / Forked Lightning
    "AUfn", // Frost Nova
    "AHbz", "ANrf", // Blizzard / Rain of Fire
    "AHfs", // Flame Strike
    "AUcs", "AOsh", "ANbf", // Carrion Swarm / Shock Wave / Breath of Fire
    "AEsf", // Starfall
    "AEfk", // Fan of Knives
    "AOww", // Bladestorm
    "AUdd", "AOeq", // Death and Decay / Earthquake
    "AUls", // Locust Swarm
    "ANfd", // Finger of Death
    "ANso", // Soul Burn
    "AHdr", // Life Drain
    "AEsh", // Shadow Strike
    "ANab", // Acid Bomb
    "ANtm", // Transmute
  ],
  summon: [
    "AHwe", // Water Elemental
    "AOsf", // Feral Spirit
    "AUcb", // Carrion Beetles
    "AEfn", // Force of Nature
    "AOsw", // Serpent Ward
    "AHpx", // Summon Phoenix
    "AUin", // Inferno
    "AEsv", // Vengeance
    "AOvd", // Big Bad Voodoo
  ],
  buff: [
    "Aroa", // Roar
    "Aspl", // Spirit Link
    "Auhf", // Unholy Frenzy
    "Aams", // Anti-magic Shell
    "AEim", // Immolation — a toggle, so `alreadyOn` is what stops it being switched back off
    "Absk", // Berserk
    "AOmi", // Mirror Image — three more bodies is a buff on the hero carrying it
    "Alsh", // Lightning Shield: aimed at an enemy, but what it does is add damage to a fight
  ],
  debuff: [
    "AEmb", // Mana Burn
    "ANht", // Howl of Terror
    "Acri", // Cripple
    "ANdh", // Drunken Haze
    "Adis", // Dispel Magic
    "AUdr", // Dark Ritual — see DARK_RITUAL_MANA: it is mana economy, gated on being short
  ],
};

/** code → role, flattened once. */
const ROLE_OF = new Map<string, Role>(
  (Object.entries(ROLES) as Array<[Role, readonly string[]]>).flatMap(([role, codes]) => codes.map((c) => [c, role] as const)),
);

/**
 * What the AI still will not press, and why each one is here.
 *
 * MUCH shorter than the classic caster's `NEVER`, which is the point of this file — the whole
 * transform family and every "the thread records nothing" entry have moved into the table
 * above. What is left is the three kinds of button that are not a combat decision at all:
 */
const NEVER = new Set<string>([
  // 1. Jobs that belong to other parts of the AI, not to a caster.
  "Aent", // Entangle Gold Mine — the economy's (AiPlayer.entangleMines)
  "Ambt", // Replenish — the Moon Well pours itself
  "Aeat", // Eat Tree
  "Auns", // Unsummon
  "Ashm", // Shadow Meld — a stance the sim holds
  "Aroo", // Root / Uproot — an Ancient walking, which is a building decision
  "Amel", "Amed", // the Meat Wagon's corpse cargo (armed as autocast instead)
  // 2. Buttons that spend the unit itself. A human uses a Sapper; an AI with no read on
  //    whether the trade is worth it uses them on a Footman. Left out until it can be judged.
  "Asds", // Kaboom!
  "Auco", // Unstable Concoction
  "Adtn", // Detonate — a Wisp is a worker, and the economy has already assigned it
  // 3. Buttons whose value is entirely in information or logistics, which this AI does not
  //    model: it scouts with a worker and it has one army in one place.
  "AOfs", // Far Sight
  "AHmt", // Mass Teleport
  "ANpr", "ANsa", // Staff of Preservation / Sanctuary
  // 4. …and the one form change that makes its owner useless in a fight: a Druid of the Talon
  //    in Raven Form is a flyer that cannot attack. Its use is scouting, and this AI scouts
  //    with a worker (ComputerPlusAi.scoutPass) rather than with a spell.
  "Arav",
  // Ethereal Form, likewise: it trades the Spirit Walker's attack for immunity to physical
  // damage, which is a call about the ENEMY's composition rather than about this fight.
  "Aetf",
]);

// ITEMS — NOT HANDLED HERE, AND DELIBERATELY. See docs/computer-plus.md "Items: not yet".
//
// Nothing in this file can reach an item even by accident: an item's granted abilities are not
// in `SimUnit.abilities` at all (they hang off the inventory slot and dispatch through
// `SimWorld.useItem`, gated by `itemReadyError` / `itemUseError`), so the ability walk in
// `tryCast` never sees a Scroll of Healing. Buying is the other half and is not here either —
// `{ c: "buyitem", shopId, itemId }` belongs in the build ladder beside the rest of the AI's
// gold, not in a caster.
//
// This is a hole waiting on the sim rather than a decision about play: the item side is still
// being filled in, and an AI written against a half-implemented inventory would encode the
// half. When it lands, a Potion of Healing is a `panic`/`heal` row on the ladder above, a Scroll
// of Healing is an area heal `pickSpot` already knows how to aim, and a Scroll of Town Portal
// belongs to the army manager's retreat rather than to this file.

/** Autocasts the AI must not simply switch on — the same two the classic caster holds back,
 *  for the same reasons (Defend costs 30% move speed and has a condition; Replenish is a job). */
const HAND_AUTOCAST = new Set<string>(["Adef", "Ambt"]);

/**
 * A morph's condition. The classic caster refuses this whole family; Computer+ is asked to use
 * it, so each one needs a rule of its own — a shape change is not a spell you spam.
 */
const MORPH_WHEN: Record<string, "engage" | "regen"> = {
  Abrf: "engage", // Bear Form: the Druid's fighting body. Morph when a fight starts and stay.
  AEme: "engage", // Metamorphosis
  ANcr: "engage", // Chemical Rage
  ANrg: "engage", // Robo-Goblin
  ANef: "engage", // Storm, Earth and Fire
  Abur: "regen", // Burrow: a hurt Crypt Fiend digs in to heal, and only with nothing near it
};

/** How hurt something has to be before a heal is spent on it. */
const HURT = 0.75;
/** …and how hurt the CASTER has to be for a panic button. */
const NEAR_DEATH = 0.5;
/** Dark Ritual is mana economy: it only makes sense when the caster is actually short. */
const DARK_RITUAL_MANA = 0.5;
/** How many bodies an area spell wants under it. The same two the classic caster uses, from
 *  the same observations — an AoE on one target is a wasted cast at any skill level. */
const CLUSTER = 2;
/** How far a caster looks to decide there is a fight around it (the Priest's own `acquire`). */
const MIN_LOOK = 600;
/** …and how far from the caster a fight has to be to count as "around us" for a morph. */
const ENGAGE_LOOK = 900;

/**
 * Which roles a difficulty actually uses.
 *
 * This is the caster's half of "meaningful difficulties" (issue #124), and it is deliberately
 * coarse: an easy computer heals, throws its damage spell, summons and morphs — the four
 * things a new player notices they can do — and never disables, buffs, debuffs or presses a
 * panic button. A normal one plays everything except the fiddly enemy-weakening spells. Insane
 * uses the whole card.
 */
function rolesFor(profile: PlusProfile): ReadonlySet<Role> {
  if (profile.difficulty === MELEE_NEWBIE) return new Set<Role>(["heal", "nuke", "summon", "morph"]);
  if (profile.difficulty === MELEE_INSANE) return new Set<Role>(LADDER);
  return new Set<Role>(["panic", "heal", "morph", "disable", "nuke", "summon", "buff"]);
}

/** One Computer+ player's casters. */
export class PlusCaster {
  private readonly roles: ReadonlySet<Role>;
  /** Each of our units' hit points at the end of the previous pass — the "is it being
   *  attacked" signal, the same one the classic caster reads. */
  private lastHp = new Map<number, number>();
  /** When each of our units first had an enemy in reach of THIS fight. The reaction delay is
   *  measured off it, so a spell lands a beat after the swords meet rather than before. */
  private fightSince = new Map<number, number>();
  /** Seconds since the player was seated — the brain's clock, handed in each pass. */
  private now = 0;
  /** How this player reads a fight (plus/targeting.ts), built once from the profile. */
  private readonly aim0: AimCtx;

  /**
   * `roll` is the AI's OWN random stream (`AiPlayer.randomInt`), not `Math.random` — a
   * misclick has to be deterministic for the same seed like every other AI decision, or two
   * replays of one match diverge.
   */
  constructor(
    private readonly view: CasterView,
    private readonly profile: PlusProfile,
    private readonly roll: () => number,
  ) {
    this.roles = rolesFor(profile);
    this.aim0 = aimCtx(profile);
  }

  pass(now: number): void {
    this.now = now;
    const own: SimUnit[] = [];
    const foes: SimUnit[] = [];
    for (const u of this.view.world.units.values()) {
      if (u.hp <= 0) continue;
      if (u.owner === this.view.player) own.push(u);
      else if (this.view.hostile(u)) foes.push(u);
    }
    this.townBell(own, foes);
    for (const u of own) {
      // ARMING is asked of buildings as well, and `canAct` (which refuses one out of hand) is
      // deliberately not consulted for it. The Moon Well is why: Replenish Life and Mana
      // (`Ambt`) is an AUTOCAST on a BUILDING, and with it off a night elf's wells pour into
      // nobody — a whole race's healing, silently absent, because the one walk that could have
      // switched it on skipped every building in the game. The Obsidian Statue is the same row
      // on a unit and was already reached; the well was not.
      if (this.canArm(u)) this.armAutocasts(u);
      if (!this.canAct(u)) continue;
      this.tryCast(u, own, foes);
    }
    this.lastHp.clear();
    const alive = new Set<number>();
    for (const u of own) {
      this.lastHp.set(u.id, u.hp);
      alive.add(u.id);
    }
    // `fightSince` is the one map that outlives a pass, so it is the one that has to be swept:
    // a unit that died mid-engagement would otherwise sit in it for the rest of the match.
    for (const id of this.fightSince.keys()) if (!alive.has(id)) this.fightSince.delete(id);
  }

  /** May this unit's autocasts be switched on? A much shorter list than `canAct`: arming is a
   *  toggle rather than an action, so a building may do it, and the only things that stop it are
   *  not being there yet and not being able to act at all. */
  private canArm(u: SimUnit): boolean {
    if (u.hp <= 0 || u.paused || u.isIllusion) return false;
    if (u.building && u.building.constructionLeft > 0) return false; // still going up
    return true;
  }

  private canAct(u: SimUnit): boolean {
    if (u.building || u.paused || u.stunned || u.silenced || u.isIllusion || u.morphT > 0) return false;
    // A channel is cancelled by the next order, so a unit already casting is left alone —
    // without this a chooser running twice a second starts Starfall forever and finishes it
    // never (docs/melee-ai.md).
    if (u.order === "cast") return false;
    if (u.isPeon || u.order === "harvest" || u.order === "return" || u.order === "repair") return false;
    if (u.constructing || u.repair) return false;
    return true;
  }

  // ====================================================================================
  //  Autocast — armed, then left to the sim
  // ====================================================================================

  /** Switch on every autocast the unit owns, and let `SimWorld.tickAutocast` run them. That
   *  covers Heal, Inner Fire, Slow, Bloodlust, Curse, Faerie Fire, Frost Armor, Abolish Magic,
   *  Ensnare, Web, Raise Dead, Get Corpse and every arrow orb, with none of it restated here. */
  private armAutocasts(u: SimUnit): void {
    for (const ab of u.abilities) {
      if (ab.level < 1 || ab.autocastOn) continue;
      const def = this.view.def(ab.id);
      if (!def?.autocast) continue;
      if (NEVER.has(def.code) || HAND_AUTOCAST.has(def.code) || isRepairCode(def.code)) continue;
      if (!this.view.world.techMeets(u.owner, ab.id)) continue;
      this.view.order({ c: "autocast", unitId: u.id, code: ab.code });
    }
  }

  /**
   * Call to Arms — the one button on a BUILDING, and a very human one.
   *
   * `Amic` is the Human town bell: every Peasant within 2000 becomes a Militia for 45 seconds.
   * It is the answer to "something is in my base and my army is somewhere else", which is
   * precisely the situation an AI is worst at, and no other race has anything like it. Rung
   * only when the raiders outnumber whatever is home, and only above Easy — a novice does not
   * know the bell exists.
   */
  private townBell(own: SimUnit[], foes: SimUnit[]): void {
    if (this.profile.difficulty === MELEE_NEWBIE) return;
    // The bell is a TOGGLE (`townbellon` / `townbelloff`), so pressing it while the militia are
    // out sends them straight back to work — and this pass runs twice a second. Call to Arms is
    // a TIMED form (`[Amil]` Dur 40 = HeroDur 40), so `altFormLeft` on something that carries
    // the ability is exactly "the militia are already up".
    if (own.some((o) => o.altFormLeft > 0 && o.abilities.some((a) => a.code === "Amil"))) return;
    for (const hall of own) {
      if (!hall.building || hall.hp <= 0) continue;
      const bell = hall.abilities.find((a) => a.code === "Amic" && a.level >= 1);
      if (!bell) continue;
      if (this.view.world.castUseError(hall.id, "Amic") !== null) continue;
      const raiders = foes.filter((f) => !f.building && !f.isPeon && near(hall, f, ENGAGE_LOOK)).length;
      if (raiders < 1) continue;
      const defenders = own.filter((o) => !o.building && !o.isPeon && o.speed > 0 && near(hall, o, ENGAGE_LOOK)).length;
      if (defenders >= raiders) continue;
      this.view.order({ c: "cast", unitId: hall.id, code: "Amic", targetId: 0, x: hall.x, y: hall.y, queued: false });
      return; // one bell is the whole town
    }
  }

  // ====================================================================================
  //  The deliberate cast
  // ====================================================================================

  /**
   * One button per unit per pass — the BEST one it can legally press.
   *
   * The abilities are walked in role-priority order rather than command-card order, which is
   * the whole difference between this and the classic caster: a Paladin with a dying Footman
   * in range heals before he stuns, and a Mountain King with a fight starting stuns before he
   * throws his hammer at whatever is nearest.
   */
  private tryCast(u: SimUnit, own: SimUnit[], foes: SimUnit[]): boolean {
    const engaged = this.engaged(u, foes);
    this.trackFight(u, engaged);
    const cards: Array<{ role: Role; ab: SimUnit["abilities"][number]; def: AbilityDef; lvl: AbilityLevel }> = [];
    for (const ab of u.abilities) {
      if (ab.level < 1 || ab.cooldownLeft > 0) continue;
      const def = this.view.def(ab.id);
      if (!def || def.target === "passive") continue;
      if (NEVER.has(def.code) || HAND_AUTOCAST.has(def.code) || isRepairCode(def.code)) continue;
      // An autocast is the sim's job (see armAutocasts) — except a morph, which wears the flag
      // on some rows and is emphatically a decision.
      if (def.autocast && !MORPH_WHEN[def.code]) continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (!lvl) continue;
      const role = roleOf(def, lvl);
      if (!role || !this.roles.has(role)) continue;
      cards.push({ role, ab, def, lvl });
    }
    cards.sort((a, b) => roleRank(a.role) - roleRank(b.role));

    for (const card of cards) {
      if (!this.ready(u, card.role, engaged)) continue;
      // Mana, cooldown, the upgrade gate and "is there even a corpse" — asked of the sim, at
      // the same door a player's click asks, so this can never be more permissive.
      if (this.view.world.castUseError(u.id, card.ab.code) !== null) continue;
      if (!this.wants(u, card.def, card.role, foes, engaged)) continue;
      if (this.aim(u, card.ab.code, card.def, card.lvl, card.role, own, foes)) return true;
    }
    return false;
  }

  /**
   * The REACTION DELAY — how long a fight has to have been going before a spell goes out.
   *
   * A reflex (a panic button, a heal) is immediate at every difficulty: those are the casts a
   * player makes because something just happened to them. Everything else waits
   * `PlusProfile.castDelay`, which is two and a half seconds for an easy computer and nothing
   * at all for an insane one. It is the cheapest possible model of "how fast does this player
   * see the fight", and it is what makes an easy computer's Shock Wave land after you have
   * already walked out of it.
   */
  private ready(u: SimUnit, role: Role, engaged: boolean): boolean {
    if (role === "panic" || role === "heal") return true;
    if (!engaged) return true; // nothing to be late for
    const since = this.fightSince.get(u.id);
    return since === undefined || this.now - since >= this.profile.castDelay;
  }

  /** Does the caster want this ability at all, before anything is aimed? */
  private wants(u: SimUnit, def: AbilityDef, role: Role, foes: SimUnit[], engaged: boolean): boolean {
    switch (role) {
      case "panic":
        // "Casts when attacked … the health of the unit isn't a factor" is the real client's
        // Divine Shield; a Wind Walk or a Blink is the opposite, an exit taken when losing.
        // Both are here: hit right now, or hurt badly enough to leave.
        return this.underAttack(u, foes) || u.hp / Math.max(1, u.maxHp) <= NEAR_DEATH;
      case "morph":
        return this.morphWanted(u, def, foes, engaged);
      case "heal":
      case "nuke":
      case "disable":
        return true; // the target search is the gate — see aim()
      case "debuff":
        if (def.code === "AUdr") return u.maxMana > 0 && u.mana / u.maxMana <= DARK_RITUAL_MANA;
        return engaged;
      case "summon":
      case "buff":
      case "utility":
        return engaged;
    }
  }

  /**
   * A shape change, by its own rule (MORPH_WHEN).
   *
   * `SimUnit.altModel` is the whole state this needs: it is true exactly while the unit is
   * standing in the ability's ALTERNATE form, and pressing the button in that state is the
   * way BACK (see `SimWorld.morphToggle`). So an "engage" morph asks "am I still in my other
   * body, and is there a fight", and Burrow — the one two-way rule — reads it from both ends.
   */
  private morphWanted(u: SimUnit, def: AbilityDef, foes: SimUnit[], engaged: boolean): boolean {
    if (MORPH_WHEN[def.code] === "regen") {
      // A Crypt Fiend digs in to heal — hurt, and with nothing close enough to punish it for
      // being underground — and digs out again the moment either half stops being true.
      const hurt = u.hp / Math.max(1, u.maxHp) <= NEAR_DEATH;
      const quiet = !foes.some((f) => near(u, f, ENGAGE_LOOK));
      return u.altModel ? !quiet || !hurt : hurt && quiet;
    }
    // A fighting form is entered once and kept: it is the body this unit fights in.
    return engaged && !u.altModel;
  }

  /** Point the ability at something and issue it. */
  private aim(
    u: SimUnit,
    code: string,
    def: AbilityDef,
    lvl: AbilityLevel,
    role: Role,
    own: SimUnit[],
    foes: SimUnit[],
  ): boolean {
    // A morph is aimed at nobody: its condition already ran in `morphWanted`, and the cast
    // point is ignored by the handler (`SPELL_HANDLERS`' morph entries take only the caster).
    if (role === "morph") {
      return this.view.order({ c: "cast", unitId: u.id, code, targetId: 0, x: u.x, y: u.y, queued: false });
    }
    if (def.target === "unit") {
      const t = this.pickTarget(u, code, def, lvl, role, own, foes);
      if (!t) return false;
      return this.view.order({ c: "cast", unitId: u.id, code, targetId: t.id, x: 0, y: 0, queued: false });
    }
    const spot = this.pickSpot(u, code, def, lvl, role, own, foes);
    if (!spot) return false;
    return this.view.order({ c: "cast", unitId: u.id, code, targetId: 0, x: spot.x, y: spot.y, queued: false });
  }

  /** The most VALUABLE legal target — see `value`. Legality is `castError`, the click's own. */
  private pickTarget(
    u: SimUnit,
    code: string,
    def: AbilityDef,
    lvl: AbilityLevel,
    role: Role,
    own: SimUnit[],
    foes: SimUnit[],
  ): SimUnit | null {
    const friendly = friendlySpell(def);
    const pool = friendly ? own : foes;
    // Every LEGAL target is collected rather than only the best one, because the misclick
    // below has to draw from the same set: a "mistake" that could land on something the click
    // itself would refuse is not a mistake, it is a dropped cast.
    const legal: SimUnit[] = [];
    let best: SimUnit | null = null;
    let bestScore = -Infinity;
    for (const t of pool) {
      if (t.building && !friendly) continue;
      if (!near(u, t, lvl.castRange)) continue;
      if (role === "heal" && t.hp / Math.max(1, t.maxHp) > HURT) continue;
      if (!buffFree(t, lvl)) continue;
      if (this.view.world.castError(u.id, code, t.id) !== null) continue;
      legal.push(t);
      // Worth first, distance only as the tie-break — and `bestScore` starts below every
      // possible score, because a cheap target at the edge of a long cast range scores
      // negative and would otherwise never be picked at all.
      const s = this.value(t, role, lvl) * 1000 - Math.hypot(t.x - u.x, t.y - u.y);
      if (s > bestScore) { bestScore = s; best = t; }
    }
    // …and then, sometimes, the wrong one. `castMistake` is ordinary sloppiness on top of a
    // difficulty's READ of the fight (`castTargeting`), and the two compose: an easy computer
    // aims at the biggest body most of the time and at whatever it happened to click on the
    // rest of it. A heal is exempt — a player who means to heal somebody heals somebody, and
    // the pool is already only the wounded.
    if (best && role !== "heal" && legal.length > 1 && this.mistake()) {
      return legal[Math.min(legal.length - 1, Math.floor(this.roll() * legal.length))] ?? best;
    }
    return best;
  }

  /** Did this click go astray? Drawn off the AI's own stream, so a match replays identically. */
  private mistake(): boolean {
    return this.profile.castMistake > 0 && this.roll() < this.profile.castMistake;
  }

  /**
   * How much this target is worth to this kind of spell — the shared ladder, plus this
   * ability's own row.
   *
   * The ladder is `plus/targeting.ts` (read its header for what a difficulty changes about it);
   * all this adds is `spellFacts`, the two columns of the ABILITY that change the aim. Today
   * that is `dur1`/`herodur1`: every hard disable in the game has a shorter hero duration, so
   * an expert prices a stun spent on a hero at what it actually buys.
   */
  private value(t: SimUnit, role: Role, lvl?: AbilityLevel): number {
    return spellValue(t, role, this.aim0, lvl ? spellFacts(lvl.duration, lvl.heroDuration) : undefined);
  }

  /**
   * Where a point / no-target ability goes: the spot that catches the most VALUE, not the most
   * bodies.
   *
   * The classic caster counts heads and takes the biggest pile, which is the observed
   * behaviour of the real engine. Weighing each body by what it is worth is the human version
   * of the same decision — a Blizzard on two Sorceresses is better than one on three Footmen —
   * and it costs the same search.
   */
  private pickSpot(
    u: SimUnit,
    code: string,
    def: AbilityDef,
    lvl: AbilityLevel,
    role: Role,
    own: SimUnit[],
    foes: SimUnit[],
  ): { x: number; y: number } | null {
    const friendly = friendlySpell(def);
    const pool = friendly ? own : foes;
    const area = lvl.area > 0;
    // A novice does not hold an area spell for a clump — they press it on whoever they are
    // looking at. So the quorum is the difficulty's too, and an easy computer's Blizzard lands
    // on one Footman.
    const quorum = this.profile.castTargeting === "naive" ? 1 : CLUSTER;
    const need = area && !friendly ? quorum : 1;

    if (def.target === "none") {
      if (!buffFree(u, lvl)) return null; // a self-buff already up is not re-pressed
      if (!area) return { x: u.x, y: u.y }; // a bare self-cast — nothing to aim
      const hits = this.catchment(u, u.x, u.y, def, lvl, role, pool, friendly);
      return hits.count >= need ? { x: u.x, y: u.y } : null;
    }

    const wave = NO_AOE_CURSOR.has(def.code);
    const reach = wave ? waveDistance(lvl) : lvl.castRange;
    const legal: Array<{ x: number; y: number }> = [];
    let best: { x: number; y: number } | null = null;
    let bestValue = 0;
    for (const t of pool) {
      if (!near(u, t, reach)) continue;
      const hits = wave ? this.corridor(u, t, def, lvl, role, pool, friendly) : this.catchment(u, t.x, t.y, def, lvl, role, pool, friendly);
      if (hits.count < need) continue;
      if (this.view.world.castError(u.id, code, 0, t.x, t.y) !== null) continue;
      legal.push({ x: t.x, y: t.y });
      if (hits.value <= bestValue) continue;
      bestValue = hits.value;
      best = { x: t.x, y: t.y };
    }
    // The same misclick a single-target cast can make (`pickTarget`), on the same stream: the
    // Blizzard that went down on the edge of the fight rather than on the middle of it.
    if (best && legal.length > 1 && this.mistake()) {
      return legal[Math.min(legal.length - 1, Math.floor(this.roll() * legal.length))] ?? best;
    }
    return best;
  }

  /** Who a circle centred on (x, y) would catch, and what they are worth. */
  private catchment(
    u: SimUnit, x: number, y: number, def: AbilityDef, lvl: AbilityLevel, role: Role,
    pool: SimUnit[], friendly: boolean,
  ): { count: number; value: number } {
    const area = lvl.area || MIN_LOOK;
    let count = 0;
    let value = 0;
    for (const t of pool) {
      if (Math.hypot(t.x - x, t.y - y) > area) continue;
      if (!this.counts(u, t, def, role, friendly)) continue;
      count++;
      value += this.value(t, role, lvl);
    }
    return { count, value };
  }

  /** …and who a wave aimed through `at` would sweep (mirrors `lineTargets` in sim/spells.ts). */
  private corridor(
    u: SimUnit, at: SimUnit, def: AbilityDef, lvl: AbilityLevel, role: Role,
    pool: SimUnit[], friendly: boolean,
  ): { count: number; value: number } {
    const dist = waveDistance(lvl);
    const half = lvl.area || 125;
    const len = Math.hypot(at.x - u.x, at.y - u.y) || 1;
    const ux = (at.x - u.x) / len;
    const uy = (at.y - u.y) / len;
    let count = 0;
    let value = 0;
    for (const t of pool) {
      const px = t.x - u.x;
      const py = t.y - u.y;
      const along = px * ux + py * uy;
      if (along < 0 || along > dist) continue;
      if (Math.abs(px * -uy + py * ux) > half + t.radius) continue;
      if (!this.counts(u, t, def, role, friendly)) continue;
      count++;
      value += this.value(t, role, lvl);
    }
    return { count, value };
  }

  /** Does this unit count toward an area spell's quorum? */
  private counts(u: SimUnit, t: SimUnit, def: AbilityDef, role: Role, friendly: boolean): boolean {
    if (t === u && !friendly) return false;
    if (t.invulnerable) return false;
    if (!this.view.world.targsAdmit(t, def.targetFlags)) return false;
    if (friendly) return role !== "heal" || t.hp / Math.max(1, t.maxHp) <= HURT;
    return !t.building;
  }

  // --- the fight, as the AI reads it --------------------------------------------------

  /** Is there a fight around this unit at all? */
  private engaged(u: SimUnit, foes: SimUnit[]): boolean {
    const look = Math.max(u.weapon?.acquire ?? 0, MIN_LOOK);
    return foes.some((f) => !f.building && near(u, f, look));
  }

  /** Remember when THIS fight started, and forget it when the fight ends — the delay is per
   *  engagement, not a cooldown, so a unit that has been fighting for a minute is not slow to
   *  react to the next spell it wants. */
  private trackFight(u: SimUnit, engaged: boolean): void {
    if (!engaged) this.fightSince.delete(u.id);
    else if (!this.fightSince.has(u.id)) this.fightSince.set(u.id, this.now);
  }

  /** Has it lost hit points since the previous pass, or is something visibly swinging at it? */
  private underAttack(u: SimUnit, foes: SimUnit[]): boolean {
    const was = this.lastHp.get(u.id);
    if (was !== undefined && u.hp < was) return true;
    return foes.some((f) => f.targetId === u.id && near(f, u, (f.weapon?.range ?? 0) + 100));
  }
}

/** Already carrying a buff this rank applies — the sim's own no-restack doctrine, narrowed to
 *  THIS ability's buff ids so two spells never block each other. */
function buffFree(t: SimUnit, lvl: AbilityLevel): boolean {
  if (!lvl.buffs.length) return true;
  const want = lvl.buffs.map((b) => b.toLowerCase());
  return !t.buffs.some((b) => b.buffId && want.includes(b.buffId.toLowerCase()));
}

/**
 * The role of an ability the table above does not name.
 *
 * Every ability gets one — that is the difference from the classic caster, which leaves
 * anything it has no rule for alone. A custom map's spells, a creep's, a neutral hero's and
 * anything a later patch adds are all played, at the role their own row implies:
 *
 *   summons a unit                 → summon
 *   wants a corpse (`dead`)        → heal (Resurrection's shape: it puts bodies back)
 *   aimed at a friend, restores    → heal … or buff, if it has no duration to run out
 *   aimed at an enemy, has an area → nuke
 *   aimed at an enemy, single      → nuke if it does damage, else disable
 *   a bare self-cast               → buff
 */
function roleOf(def: AbilityDef, lvl: AbilityLevel): Role | null {
  const named = ROLE_OF.get(def.code);
  if (named) return named;
  const F = new Set(def.targetFlags.map((f) => f.toLowerCase()));
  if (lvl.summon || def.levelData.some((l) => !!l.summon)) return "summon";
  if (F.has("dead")) return "heal";
  const friendly = friendlySpell(def);
  if (friendly) return lvl.duration > 0 ? "buff" : "heal";
  if (def.target === "unit") return lvl.duration > 0 ? "disable" : "nuke";
  if (def.target === "point") return lvl.area > 0 ? "nuke" : null;
  return lvl.area > 0 ? "nuke" : "buff"; // no target at all
}
