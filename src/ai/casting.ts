import { NO_AOE_CURSOR, isRepairCode, type AbilityDef, type AbilityLevel } from "../data/abilities";
import { AttackType } from "../data/enums";
import type { Command } from "../game/commands";
import type { SimUnit, SimWorld } from "../sim/world";

/**
 * When a computer player's units press their buttons.
 *
 * This is the one part of `src/ai/` with **no script to port** — see docs/melee-ai.md. The
 * four race files decide what a hero LEARNS (`set skill[1] = HOLY_BOLT`) and then say nothing
 * whatever about using it; casting lives in `Game.dll`, as a `heroAbility` object hung off
 * `CUnit` beside `attackAbility`/`moveAbility` (docs/reverse-engineering/tinkerworx-repos.md).
 * So the behaviour has to be reconstructed from OBSERVATION of the real client, and there is
 * exactly one systematic record of it:
 *
 *   **Boris_Spider, "Base Abilities for Custom Spells used by AI Casters"**
 *   https://www.hiveworkshop.com/threads/base-abilities-for-custom-spells-cast-by-melee-game-ai-units.193280/
 *   (approved tutorial, last updated 2014-08-16; eleven named contributors)
 *
 * Every rule in `CAST_RULES` below is a line from that thread, quoted next to it. Where the
 * thread lists an ability but records no trigger — it says so with a bare dash — the entry
 * falls through to `classDefault`, which derives one from the ability's own row.
 *
 * Two structural facts from the thread shape the whole file, and both are why this is keyed on
 * the base `code` rather than on a list of Blizzard ability ids:
 *
 *  1. **The AI casts a BASE ABILITY, not a spell.** That is the thread's entire subject: a
 *     custom map's "Thunderwrath" based on Carrion Swarm is cast by the AI exactly when
 *     Carrion Swarm is, because the engine only ever sees `code`. Keying on `code` gives us
 *     the same property for free, and it is the same seam `SPELL_HANDLERS` already uses.
 *  2. **An ability the engine has no rule for is never cast at all** — "the AI will never cast
 *     spells based on Channel-Special". A code that reaches `classDefault` with nothing to
 *     derive is left alone rather than guessed at.
 *
 * What is NOT here, because the sim already does it: **autocast**. "Autocast spells have the
 * same event for firing for their autocast and for their AI use" (post 20), so Heal, Slow,
 * Bloodlust, Curse, Faerie Fire, Frost Armor, Ensnare, Web, Raise Dead and the arrow orbs are
 * handled by ARMING them (see `armAutocasts`) and letting `SimWorld.tickAutocast` — a working,
 * data-driven "should this unit cast right now" — run them.
 */

/** How often a computer's casters are asked. Twice a second: fast enough that a Storm Bolt
 *  lands inside the fight that earned it, slow enough that the scan is nothing. */
export const CAST_PERIOD = 0.5;

/**
 * How many bodies an area spell wants under it.
 *
 * The thread's number, stated for every AoE it describes and never varying: "Will cast if
 * there are at least 2 to 3 units in a group" (Blizzard/Rain of Fire), "at least 2 to 3 units
 * in a cone" (the waves), "2 to 3 units around the caster" (Thunder Clap/War Stomp), "2+
 * enemies standing in the AoE" (Flame Strike), "2 or more enemy units close" (Starfall). The
 * LOW end of the range, because the same thread reports single-target casts slipping through
 * ("I've had breath of fire casted when I was fighting 1 unit vs 1 unit", post 2) — a floor of
 * 3 would forbid what the real client is observed doing.
 */
const CLUSTER = 2;

/**
 * How hurt something has to be before a heal is spent on it.
 *
 * One of the two judgement calls docs/melee-ai.md flagged as having no data behind it. The
 * thread says only "significant/any/moderate damage" (Healing Wave/Heal/Rejuvenation). A
 * quarter of the bar is the reading that keeps a 200-point Holy Light off a Footman with a
 * scratch while still catching anything actually in a fight; the sim's own Heal autocast uses
 * the other reading ("any damage at all", `t.hp >= t.maxHp` refused), and the abilities that
 * want that one are autocasts, which go through it rather than through here.
 */
const HURT = 0.75;

/** …and the caster's own bar, for the panic buttons. Wind Walk is "used when the AI-controlled
 *  units are near death"; Cannibalize is "spammed when a unit is injured, usually around 50%
 *  HP or less" — which is the only number the thread gives for a self-health gate, so it is
 *  the one both take. */
const NEAR_DEATH = 0.5;

/** How far a caster looks to decide there is a fight around it. The unit's own acquisition
 *  range — the same "as far as a caster's eyes" the sim's autocast already reaches with
 *  (`SimWorld.autocastSearchRange`) — floored for the casters that carry no weapon to read it
 *  off. 600 is the Priest's `acquire` in UnitWeapons.slk. */
const MIN_LOOK = 600;

/** What the AI never presses, and why each is here. */
const NEVER = new Set<string>([
  // "The regular melee game will use all abilities on the standard Blizzard maps (EXCEPT for
  // transform abilities like Destroyer Form/Bear Form/Crow Form)" — the thread's one blanket
  // exclusion. Post 44 has the reason: a morph is a different unit type, and the AI "would
  // think he lost a unit". Everything with an alternate form is therefore out.
  "AEme", // Metamorphosis
  "ANrg", // Robo-Goblin
  "ANcr", // Chemical Rage
  "ANef", // Storm, Earth and Fire — one Brewmaster becomes three units
  "Abur", // Burrow
  "Aroo", // Root / Uproot
  "Acpf", // Corporeal / Ethereal Form
  "Amil", "Amic", // Call to Arms / back to work
  // Named by the thread with a flat "never":
  "AOfs", // "~Farsight - Unused"
  "AUdp", // "~Death Pact - Never"
  // Economy and errands, which are not casts the AI decides — they belong to the parts of
  // src/ai/ that own the economy (MeleeAi.entangleMines) or to the worker's own job.
  "Aent", // Entangle Gold Mine — MeleeAi.entangleMines issues this one
  "Aeat", // Eat Tree
  "Adtn", // Detonate — a wisp trading itself for a dispel
  "Auns", // Unsummon
  "Ambt", // Replenish (the Moon Well pours itself; see tickReplenish)
  "Ashm", // Shadow Meld — a stance the sim holds, not a spell
  "Amel", "Amed", // the Meat Wagon's corpse cargo (autocast; see armAutocasts)
  // OUR call rather than the thread's, and stated so: each trades a whole unit for one cast,
  // which is a decision no observation in the thread covers. Left off until it can be based
  // on something.
  "Asds", // Kaboom! (Goblin Sapper)
  "Auco", // Unstable Concoction (Batrider)
  // …and the army-logistics spells, for the same reason: the thread records nothing about
  // when the AI blinks or mass-teleports, and a wrong guess moves an army.
  "AHmt", // Mass Teleport
  "AEbl", // Blink
  "ANpr", "ANsa", // Staff of Preservation / Sanctuary
]);

/** Autocasts the AI must NOT simply switch on. Everything else with an `Orderon`/`Orderoff`
 *  pair is armed — see armAutocasts. */
const HAND_AUTOCAST = new Set<string>([
  // Defend is a STANCE wearing the autocast flag (see KNOWN_ABILITIES), and the thread gives
  // it a condition: "Activated in the same manner as Divine Shield, but only if the caster is
  // being attacked by a unit with Piercing damage". It also costs 30% of the Footman's move
  // speed while up, so leaving it on is not free. See tickDefend.
  "Adef",
  // The Moon Well's pour and a worker's Repair/Renew are jobs rather than casts: arming Renew
  // would pull wisps off the economy that src/ai/ has already assigned.
  "Ambt",
]);

/** When the AI wants an ability at all — the thread's trigger, one word. */
type Trigger =
  /** "Spammed at every cool down" — the target search is the only gate. */
  | "spam"
  /** "Uses whenever is available" — fires the moment it is off cooldown. */
  | "ready"
  /** Needs `count` bodies under the area/cone (see CLUSTER). */
  | "cluster"
  /** There is a fight within the caster's own eyes. */
  | "engaged"
  /** The caster is taking hits RIGHT NOW. */
  | "attacked"
  /** The caster's own hit points are below `hp`. */
  | "hurt"
  /** Somebody friendly (the caster included) is below `hp`. */
  | "hurtAlly"
  /** The caster's own MANA is below `hp` — Dark Ritual's whole point. */
  | "manaLow";

/** Which of the legal targets the AI reaches for first. All of these are the thread's. */
type Prefer =
  | "hero" // "has preference to target heroes" (Storm Bolt/Fire Bolt/Frost Bolt)
  | "nonhero" // "Spammed on non-heroes, may target a lone hero" (Hex)
  | "summon" // "Prefers casting on summoned units" (Banish)
  | "mana" // "Spammed on anything with mana" (Mana Burn)
  | "dying" // "uses it when the target is dying" (Black Arrow)
  | "furthest" // "always cast on the furthest target inside the range" (Parasite)
  | "level" // "may prefer units with higher levels" (Devour)
  | "hurt"; // the most wounded — how a heal picks (SimWorld.autocastTarget does the same)

interface CastRule {
  when: Trigger;
  /** For `cluster`: how many bodies. Defaults to CLUSTER. */
  count?: number;
  /** For `hurt`/`hurtAlly`/`manaLow`: the fraction of the bar. */
  hp?: number;
  prefer?: Prefer;
  /** Re-cast on something already carrying this ability's buff? False (the default) is the
   *  sim's own autocast doctrine — `autocastWants` refuses a target that already wears a buff
   *  from this caster. True is for the spells the thread explicitly reports being spammed
   *  regardless of what is already on the target. */
  restack?: boolean;
  /** "May not be used if air units are present (despite being allowed to hit them to)" —
   *  Thunder Clap / War Stomp, confirmed twice in the thread (the list, and post 34). */
  noAir?: boolean;
  /** Only count a body that a DISPEL would actually do something to — a summon (which it
   *  damages) or something wearing a timed buff. Dispel Magic's quorum is otherwise "any two
   *  enemies", which is every fight. */
  dispellable?: boolean;
}

/**
 * The thread, as a table. One row per base ability, quoting the line it comes from.
 *
 * Reading order inside a unit's ability list is the card's own order, and the first rule that
 * fires wins — so a hero presses one button per pass. The thread's own "Future Plans" notes
 * that the AI seems to have preferences BETWEEN spells ("I've noticed that the AI will spam
 * Charm before it casts Forked Lightning") but never established what they are, so nothing
 * here pretends to.
 */
const CAST_RULES: Record<string, CastRule> = {
  // === "Spammed at every cool down" ===================================================
  // "~Chain Lightning - Spammed at every cool down, appears to ignore stunned/disabled
  //  enemies." (The stunned half is not modelled: nothing in our data says a unit is
  //  "disabled" separately from the buff that stunned it.)
  AOcl: { when: "spam", restack: true },
  // "~Frost Nova - Spammed at every cool down" — post 20 disputes the "every" ("it may be
  // casted when the unit is damaged or when the fight begins"), but every reading of it is a
  // spam with a fight around it, which is what a cast range full of enemies already means.
  AUfn: { when: "spam", restack: true },
  // "~Storm Bolt/Fire Bolt/Frost Bolt - Spammed at every cool down, has preference to target
  //  heroes." — and `SetTargetHeroes(not isNewbie)` in common.ai 779 says the same thing
  //  about the AI's aim generally, which is the one targeting preference the SCRIPTS state.
  AHtb: { when: "spam", prefer: "hero", restack: true },
  ANfb: { when: "spam", prefer: "hero", restack: true },
  // "~Forked Lightning - Spammed on enemy heroes and/or clusters of 2+ enemy units."
  ANfl: { when: "spam", prefer: "hero", restack: true },
  // "~Life Drain - Spammed at every cool down."
  AHdr: { when: "spam", restack: true },
  // "~Mana Burn - Spammed on anything with mana"
  AEmb: { when: "spam", prefer: "mana" },
  // "~Shadow Strike - Spammed at every cool down unless victim is already afflicted with
  //  Shadow Strike (may prefer target that has less then 100% of his health…)" — the
  //  "unless already afflicted" is exactly the no-restack default.
  AEsh: { when: "spam", prefer: "dying" },
  // "~Charm - Spammed on anything that can be targeted; will not target things that can't
  //  attack" — the can't-attack half is the ability's own `targs1` in our data.
  ANch: { when: "spam" },
  // "~Devour - Spammed on anything that can be targeted, may prefer units with higher levels."
  Adev: { when: "spam", prefer: "level" },
  // "~Hex - Spammed on non-heroes, may target a lone hero"
  AOhx: { when: "spam", prefer: "nonhero" },
  // "~Silence - …Preference for units with at least 75 mana as well as player units and
  //  non-heroes over heroes." (An AoE, so the preference picks where the circle goes.)
  ANsi: { when: "cluster", count: 1, prefer: "mana" },
  // "~Soul Burn - Only activates on heroes."
  ANso: { when: "spam", prefer: "hero" },
  // "~Purge -" and "~Cripple -" and "~Acid Bomb -" and "~Drunken Haze -" — listed with no
  // trigger recorded. Spam is the class default for a single-target enemy debuff anyway; the
  // rows exist so the reading is on the record.
  Aprg: { when: "spam" },
  Acri: { when: "spam" },
  ANab: { when: "spam" },
  ANdh: { when: "spam" },
  // "~Banish - Prefers casting on summoned units."
  AHbn: { when: "spam", prefer: "summon" },
  // "~Sleep - Cast while in combat, seems to prefer non heroes."
  AUsl: { when: "engaged", prefer: "nonhero" },
  // "~Unholy Frenzy -" — no trigger recorded. It is cast on an ALLY and costs that ally
  // health, so it wants a fight to be worth it (class default would say the same).
  Auhf: { when: "engaged" },
  // "~Anti-magic Shell -" — no trigger recorded; a shield is for a unit under fire.
  Aams: { when: "engaged" },
  // "~Doom -" is not in the thread at all, but is the same single-target enemy curse as its
  // neighbours and would reach the identical class default. Stated rather than derived so the
  // Pit Lord's ultimate is not held hostage to a fallback.
  ANdo: { when: "spam" },
  // Entangling Roots — likewise absent from the thread. Single-target enemy hold.
  AEer: { when: "spam" },
  // Lightning Shield — absent from the thread; a buff aimed at an enemy (it burns whoever
  // wears it), so a fight is the gate.
  Alsh: { when: "engaged" },
  // Transmute — absent from the thread. It kills a non-hero for gold, so a live enemy in
  // range is the whole condition.
  ANtm: { when: "spam", prefer: "nonhero" },

  // === "Uses whenever is available" ===================================================
  // "~Finger of Death - Uses whenever is available" (post 36).
  ANfd: { when: "ready", prefer: "hero" },

  // === The area spells — "at least 2 to 3 units" ======================================
  // "~Blizzard/Rain of Fire - Will cast if there are at least 2 to 3 units in a group."
  AHbz: { when: "cluster" },
  ANrf: { when: "cluster" },
  // "~Flamestrike - May be cast if there are 2+ enemies standing in the AoE" (confirmed in
  // post 5: "Flamestrike is used if there at least 2 enemies standing within AOE").
  AHfs: { when: "cluster" },
  // "~Fire Breath/Shockwave/Carrion Swarm/Impale - Will cast if there are at least 2 to 3
  //  units in a cone."
  ANbf: { when: "cluster" },
  AOsh: { when: "cluster" },
  AUcs: { when: "cluster" },
  AUim: { when: "cluster" },
  // "~Fan of Knives - Spams randomly if 2 to 3 enemies around, occasionally also uses on
  //  single targets if attacked."
  AEfk: { when: "cluster" },
  // "~Starfall - Uses when there is 2 or more enemy units close." (post 36)
  AEsf: { when: "cluster" },
  // "~Thunderclap/Warstomp - Will cast if there are 2 to 3 units around the caster. May not
  //  be used if air units are present (despite being allowed to hit them to)."
  AHtc: { when: "cluster", noAir: true },
  AOws: { when: "cluster", noAir: true },
  // "~Bladestorm - Used at random, appears to use immediately if many enemies nearby."
  AOww: { when: "cluster" },
  // "~Locust Swarm / Voodoo Spirits -" — no trigger recorded; a PBAoE drain field wants
  // bodies around it like every other one.
  AUls: { when: "cluster" },
  // "~Cloud - Spams any defensive building (ranged and/or melee), usually when attacking
  //  towns". We have no Cloud, but Death and Decay and Earthquake are the two point fields
  //  aimed at a base, and neither is in the thread; both take the ordinary cluster gate.
  AUdd: { when: "cluster" },
  AOeq: { when: "cluster" },
  // "~Dispel -" — no trigger recorded. `count: 1` because one summoned unit is already worth
  // a Dispel (it damages summons), which is what the ability is FOR — and `dispellable`
  // because otherwise the quorum is "any enemy", i.e. every fight.
  Adis: { when: "cluster", count: 1, dispellable: true },
  // "~Immolation - Activates only if Immolation deals damage and there are viable targets
  //  present; it may favor use after losing hitpoints". One viable target is the stated bar.
  AEim: { when: "cluster", count: 1 },
  // "~Serpent Ward - Plants near enemies every cool down." / "~Stasis Trap -" (no trigger).
  AOwd: { when: "cluster", count: 1 },
  Asta: { when: "cluster", count: 1 },

  // === Heals and friendly buffs =======================================================
  // "~Healing Wave/Heal/Rejuvenation - Used when caster or any nearby allies take
  //  significant/any/moderate damage."
  AOhw: { when: "hurtAlly", prefer: "hurt" },
  Arej: { when: "hurtAlly", prefer: "hurt" },
  // "~Holy Light/Death Coil - Spam on any nearby Undead units or friendly non-Undead units,
  //  prefers heroes." — i.e. both are used as HEALS by the AI, on opposite polarities, and
  //  our POLARITY_SPELLS already decides which units each may touch.
  AHhb: { when: "hurtAlly", prefer: "hero" },
  AUdc: { when: "hurtAlly", prefer: "hero" },
  // "~Big Bad Voodoo -" (no trigger) and "~Roar/Howl of Terror - Used when engaging enemies".
  AOvd: { when: "engaged" },
  Aroa: { when: "engaged" },
  ANht: { when: "engaged" },
  // "~Spirit-Link - Casts on friendly units that are engaged"
  Aspl: { when: "engaged" },
  // "~Resurrection - Cast if there are friendly dead units nearby." (The bodies themselves are
  //  `castUseError`'s job — it refuses the cast outright when there is nothing to raise.)
  AHre: { when: "ready" },
  // Animate Dead is Resurrection's undead twin and is not in the thread; same gate.
  AUan: { when: "ready" },
  // "~Cannibalize - Spammed when a unit is injured, usually around 50% HP or less."
  Acan: { when: "hurt", hp: NEAR_DEATH },

  // === Panic buttons ==================================================================
  // "~Divine Shield - Casts when attacked, often just before the caster is dealt damage or hit
  //  by a non-friendly spell to avoid taking any damage. The health of the unit isn't a factor
  //  for it's casting." — so no `hp` gate, deliberately.
  AHds: { when: "attacked" },
  // "~Mirror Image - Cast if the caster is attacked a certain number of times. Used
  //  immediately if the caster is about to be hit by a spell." (post 34: "Those damn
  //  blademasters always do this to me")
  AOmi: { when: "attacked" },
  // "~Wind Walk - Used when the AI-controlled units are near death"
  AOwk: { when: "hurt", hp: NEAR_DEATH },
  // "~Berserk - Used in combat, will not cast if outnumbered." (the outnumbered half is
  //  checked in `wants`, since it is about the fight and not about the ability)
  Absk: { when: "engaged" },
  // Avatar is not in the thread. It is the Mountain King's own Divine Shield — a self-buff
  // that answers being hit — and takes the same trigger.
  AHav: { when: "attacked" },
  // Mana Shield, likewise absent, is the same shape again.
  ANms: { when: "attacked" },

  // === Summons ========================================================================
  // "~Water Elemental - Casts when caster or nearby allies are engaging enemies." — and every
  // other summon in the game is the same button, so they share the rule. (Feral Spirit, the
  // Beastmaster's three, Phoenix, Inferno, Lava Spawn, Tornado, Pocket Factory, Vengeance,
  // Force of Nature, Carrion Beetles… none of which the thread names individually.)
  AHwe: { when: "engaged" },

  // === Mana economy ===================================================================
  // Dark Ritual is not in the thread, and it must not reach the class default: it is aimed at
  // a FRIENDLY unit and KILLS it, so "the most wounded ally" would be exactly wrong. Its own
  // tooltip is the rule — a summoned unit, spent when the Lich is short of mana.
  AUdr: { when: "manaLow", hp: NEAR_DEATH, prefer: "summon" },
};

/** The world and the player, as the caster needs them. Kept narrow on purpose: everything
 *  here is either a read of the sim or the one door out (`AiPlayer.order` →
 *  `RtsController.execute`), so a computer's cast is gated exactly as your own click is. */
export interface CasterView {
  world: SimWorld;
  player: number;
  /** The ability row behind one of a unit's ability slots (`SimAbility.id`). */
  def(abilityId: string): AbilityDef | undefined;
  /** `AiPlayer.hostileTo` — creeps and neutral-hostile included. */
  hostile(u: SimUnit): boolean;
  /** `AiPlayer.order`. */
  order(cmd: Command): boolean;
}

/** One computer player's casters. */
export class AiCaster {
  /** Each of our units' hit points at the END of the previous pass — the "is it being
   *  attacked" signal Divine Shield and Mirror Image turn on. Health the AI can see on its own
   *  units is not privileged information, and a drop over half a second is the plainest
   *  reading of "attacked" there is. */
  private lastHp = new Map<number, number>();

  constructor(private readonly view: CasterView) {}

  pass(): void {
    const own: SimUnit[] = [];
    const foes: SimUnit[] = [];
    for (const u of this.view.world.units.values()) {
      if (u.hp <= 0) continue;
      if (u.owner === this.view.player) own.push(u);
      else if (this.view.hostile(u)) foes.push(u);
    }
    for (const u of own) {
      if (!this.canAct(u)) continue;
      this.armAutocasts(u);
      this.tickDefend(u, foes);
      this.tryCast(u, own, foes);
    }
    this.lastHp.clear();
    for (const u of own) this.lastHp.set(u.id, u.hp);
  }

  /** Is this one of ours worth asking at all? */
  private canAct(u: SimUnit): boolean {
    if (u.building || u.paused || u.stunned || u.silenced || u.isIllusion || u.morphT > 0) return false;
    // THE TRAP (docs/melee-ai.md): Blizzard, Starfall, Tranquility and Death and Decay are
    // CHANNELLED, and a fresh order is what cancels a channel. A chooser that runs twice a
    // second and does not skip a unit already casting would start Starfall forever and finish
    // it never.
    if (u.order === "cast") return false;
    // A worker is the economy's, not the captain's — the same line `AiPlayer.army` draws for
    // the Ghoul, from the other side: `isPeon` is the CLASSIFICATION (the nine harvest-and-
    // build units), so a Ghoul still fights and still eats corpses while a Peasant is left to
    // mine. And nobody mid-job is interrupted for a spell.
    if (u.isPeon || u.order === "harvest" || u.order === "return" || u.order === "repair") return false;
    if (u.constructing || u.repair) return false;
    return true;
  }

  // ======================================================================================
  //  Autocast — "their autocast doesn't have to be enabled for AIs"
  // ======================================================================================

  /**
   * Switch on every autocast the unit owns.
   *
   * Post 20 of the thread: "autocast spells have the same 'event for firing' for their
   * autocast and for their AI use (which means their autocast doesn't have to be enabled for
   * IAs)". The engine's AI has one code path for both; we have `SimWorld.tickAutocast`, which
   * is that code path — so arming the toggle reproduces the observed behaviour with the
   * machinery that already exists, rather than a second copy of it in here.
   *
   * That covers Heal, Inner Fire, Slow, Bloodlust, Curse, Faerie Fire, Frost Armor, Abolish
   * Magic, Ensnare, Web, Raise Dead, the Meat Wagon's Get Corpse and every arrow orb —
   * "~Searing Arrows - Uses it whenever the CD is off", "~Cold Arrows - PREFERRED over Searing
   * Arrows in the case the hero/unit has both spells" (which is `src/sim/orbs.ts`' priority
   * ladder, not a decision made here).
   */
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
   * Defend (`Adef`), the one autocast with a condition of its own.
   *
   * "~Defend - Activated in the same manner as Divine Shield, but only if the caster is being
   * attacked by a unit with Piercing damage (If ability is set to shield against Magic damage
   * as well)." Our `SimWorld.applyDamage` reads the stance for `AttackType.Pierce` only, so
   * Pierce is the whole question — and because the stance costs 30% of the Footman's move
   * speed while it is up (`Adef` DataC), it is dropped again when the archers are gone.
   */
  private tickDefend(u: SimUnit, foes: SimUnit[]): void {
    const ab = u.abilities.find((a) => a.code === "Adef" && a.level >= 1);
    if (!ab || !this.view.world.techMeets(u.owner, ab.id)) return;
    const look = this.lookRange(u);
    const want = foes.some((f) => near(u, f, look) && f.weapons.some((w) => w.enabled && w.attackType === AttackType.Pierce));
    if (want !== ab.autocastOn) this.view.order({ c: "autocast", unitId: u.id, code: "Adef" });
  }

  // ======================================================================================
  //  The deliberate casts
  // ======================================================================================

  /** One button per unit per pass, in the card's own order. */
  private tryCast(u: SimUnit, own: SimUnit[], foes: SimUnit[]): boolean {
    for (const ab of u.abilities) {
      if (ab.level < 1 || ab.cooldownLeft > 0) continue;
      const def = this.view.def(ab.id);
      if (!def || def.target === "passive" || def.autocast) continue;
      if (NEVER.has(def.code) || HAND_AUTOCAST.has(def.code) || isRepairCode(def.code)) continue;
      const lvl = def.levelData[Math.min(ab.level, def.levelData.length) - 1];
      if (!lvl) continue;
      const rule = CAST_RULES[def.code] ?? classDefault(def, lvl);
      if (!rule) continue;
      // Mana, cooldown, the upgrade gate, and "is there even a corpse" — asked of the sim, at
      // the same door the player's click asks (`castUseError`), so the AI can never be more
      // permissive than the button.
      if (this.view.world.castUseError(u.id, ab.code) !== null) continue;
      if (!this.wants(u, def, rule, foes)) continue;
      if (this.aim(u, ab.code, def, lvl, rule, own, foes)) return true;
    }
    return false;
  }

  /** The trigger half: does the caster want this ability RIGHT NOW, before anything is aimed?
   *  The gates that need the aim (cluster size, a wounded ally) are asked in `aim`. */
  private wants(u: SimUnit, def: AbilityDef, rule: CastRule, foes: SimUnit[]): boolean {
    switch (rule.when) {
      case "spam":
      case "ready":
      case "cluster":
      case "hurtAlly":
        return true;
      case "engaged":
        // "~Berserk - Used in combat, WILL NOT CAST IF OUTNUMBERED." The one trigger in the
        // thread that counts both sides, so it is asked here rather than made a rule field.
        if (def.code === "Absk" && this.outnumbered(u, foes)) return false;
        return foes.some((f) => near(u, f, this.lookRange(u)));
      case "attacked":
        return this.underAttack(u, foes);
      case "hurt":
        return u.hp / Math.max(1, u.maxHp) <= (rule.hp ?? HURT);
      case "manaLow":
        return u.maxMana > 0 && u.mana / u.maxMana <= (rule.hp ?? NEAR_DEATH);
    }
  }

  /** Point the ability at something and issue the cast. Returns true if one went out. */
  private aim(
    u: SimUnit,
    code: string,
    def: AbilityDef,
    lvl: AbilityLevel,
    rule: CastRule,
    own: SimUnit[],
    foes: SimUnit[],
  ): boolean {
    if (def.target === "unit") {
      const t = this.pickTarget(u, code, def, lvl, rule, own, foes);
      if (!t) return false;
      return this.view.order({ c: "cast", unitId: u.id, code, targetId: t.id, x: 0, y: 0, queued: false });
    }
    const spot = this.pickSpot(u, code, def, lvl, rule, own, foes);
    if (!spot) return false;
    return this.view.order({ c: "cast", unitId: u.id, code, targetId: 0, x: spot.x, y: spot.y, queued: false });
  }

  /**
   * The best legal target for a single-target cast.
   *
   * Legality is `SimWorld.castError` — the click-time gate, which already knows about
   * `targs1`, magic immunity, invulnerability, spell polarity (Holy Light on the undead) and
   * everything else the data says. This function only decides WHICH of the legal ones, off the
   * thread's preferences.
   *
   * Reach is the spell's own `Rng1` and nothing more. An autocast may walk to its work
   * (`autocastSearchRange`), but a deliberate cast that did would march a Lich out of his
   * army to Frost Nova something he can see and not reach.
   */
  private pickTarget(
    u: SimUnit,
    code: string,
    def: AbilityDef,
    lvl: AbilityLevel,
    rule: CastRule,
    own: SimUnit[],
    foes: SimUnit[],
  ): SimUnit | null {
    const friendly = friendlySpell(def);
    const pool = friendly ? own : foes;
    const reach = lvl.castRange;
    let best: SimUnit | null = null;
    let bestScore = -Infinity;
    for (const t of pool) {
      if (t.building && !friendly) continue; // a building is not who a caster is fighting
      if (!near(u, t, reach)) continue;
      if (!rule.restack && this.alreadyOn(t, lvl)) continue;
      if (rule.when === "hurtAlly" && t.hp / Math.max(1, t.maxHp) > (rule.hp ?? HURT)) continue;
      if (this.view.world.castError(u.id, code, t.id) !== null) continue;
      const s = this.score(u, t, rule.prefer);
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }
    return best;
  }

  /** Higher is better; ties break toward the nearest, which is the sim's own tie-break for a
   *  hostile autocast pick (`autocastTarget`). */
  private score(u: SimUnit, t: SimUnit, prefer: Prefer | undefined): number {
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    const near1 = 1 - d / 10000; // ≤1, so it only ever breaks a tie
    switch (prefer) {
      case "hero": return (t.isHero ? 10 : 0) + near1;
      case "nonhero": return (t.isHero ? 0 : 10) + near1;
      case "summon": return (t.isSummon ? 10 : 0) + near1;
      case "mana": return (t.mana >= SILENCE_MANA ? 10 : t.maxMana > 0 ? 5 : 0) + near1;
      case "dying": return (1 - t.hp / Math.max(1, t.maxHp)) * 10 + near1;
      case "level": return t.level + near1;
      case "hurt": return (1 - t.hp / Math.max(1, t.maxHp)) * 10 + near1;
      case "furthest": return d;
      default: return near1;
    }
  }

  /**
   * Where a point / no-target ability goes.
   *
   * Three shapes, and the ability's own row says which it is:
   *  * a **wave** (`NO_AOE_CURSOR`'s directional family) — the click only picks a DIRECTION,
   *    so the count is over a corridor `DataC` long and `Area1` wide, the same geometry
   *    `SPELL_HANDLERS`' wave entries sweep;
   *  * a **circle** — `Area1` around the clicked point;
   *  * **no target at all** — the circle is centred on the caster and the "point" is where he
   *    already stands.
   */
  private pickSpot(
    u: SimUnit,
    code: string,
    def: AbilityDef,
    lvl: AbilityLevel,
    rule: CastRule,
    own: SimUnit[],
    foes: SimUnit[],
  ): { x: number; y: number } | null {
    const friendly = friendlySpell(def);
    const need = rule.when === "cluster" ? (rule.count ?? CLUSTER) : friendly ? 1 : 0;
    const pool = friendly ? own : foes;

    if (def.target === "none") {
      // A self-buff already in force is not re-cast. This is the same no-restack rule
      // `pickTarget` applies to somebody else, asked of the caster — and it is what keeps
      // Immolation from being TOGGLED off half a second after it was lit (`AEim` is a toggle:
      // pressing it again douses it), and Divine Shield, Avatar, Mana Shield, Wind Walk and
      // Berserk from being paid for twice.
      if (!rule.restack && this.alreadyOn(u, lvl)) return null;
      const hits = this.catchment(u, u.x, u.y, def, lvl, rule, pool, friendly);
      if (hits.length < need) return null;
      if (rule.noAir && hits.some((t) => t.flying)) return null;
      // A no-target cast is aimed at nothing — `issueCast` ignores the point entirely — but
      // the caster's own spot is what every other route in passes (see tickAutocast's corpse
      // branch), so it is what this passes too.
      return { x: u.x, y: u.y };
    }

    const wave = NO_AOE_CURSOR.has(def.code);
    const reach = wave ? waveDistance(lvl) : lvl.castRange;
    let best: { x: number; y: number } | null = null;
    let bestCount = need - 1;
    for (const t of pool) {
      if (!near(u, t, reach)) continue;
      const hits = wave
        ? this.corridor(u, t, def, lvl, pool, friendly)
        : this.catchment(u, t.x, t.y, def, lvl, rule, pool, friendly);
      if (hits.length <= bestCount) continue;
      if (rule.noAir && hits.some((o) => o.flying)) continue;
      if (this.view.world.castError(u.id, code, 0, t.x, t.y) !== null) continue;
      bestCount = hits.length;
      best = { x: t.x, y: t.y };
    }
    return best;
  }

  /** Who a circle centred on (x, y) would actually catch — the ability's own `targs1`, asked
   *  of the sim (`targsAdmit`), so a War Stomp counts what a War Stomp hits. */
  private catchment(
    u: SimUnit,
    x: number,
    y: number,
    def: AbilityDef,
    lvl: AbilityLevel,
    rule: CastRule,
    pool: SimUnit[],
    friendly: boolean,
  ): SimUnit[] {
    const area = lvl.area || MIN_LOOK;
    const out: SimUnit[] = [];
    for (const t of pool) {
      if (Math.hypot(t.x - x, t.y - y) > area) continue;
      if (!this.counts(u, t, def, rule, friendly)) continue;
      out.push(t);
    }
    return out;
  }

  /** …and who a wave aimed through `at` would sweep: the corridor from the caster, `DataC`
   *  long and `Area1` to either side (mirrors `lineTargets` in sim/spells.ts). */
  private corridor(u: SimUnit, at: SimUnit, def: AbilityDef, lvl: AbilityLevel, pool: SimUnit[], friendly: boolean): SimUnit[] {
    const dist = waveDistance(lvl);
    const half = lvl.area || 125;
    const dx = at.x - u.x;
    const dy = at.y - u.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const out: SimUnit[] = [];
    for (const t of pool) {
      const px = t.x - u.x;
      const py = t.y - u.y;
      const along = px * ux + py * uy;
      if (along < 0 || along > dist) continue;
      if (Math.abs(px * -uy + py * ux) > half + t.radius) continue;
      if (!this.counts(u, t, def, undefined, friendly)) continue;
      out.push(t);
    }
    return out;
  }

  /** Does this unit count toward an area spell's quorum? */
  private counts(u: SimUnit, t: SimUnit, def: AbilityDef, rule: CastRule | undefined, friendly: boolean): boolean {
    if (t === u && !friendly) return false;
    if (t.invulnerable) return false;
    if (!this.view.world.targsAdmit(t, def.targetFlags)) return false;
    if (friendly) {
      // A friendly field is worth casting for units it will actually change: hurt ones for a
      // heal, and never a full-health army for a Tranquility.
      if (rule?.when === "hurtAlly" && t.hp / Math.max(1, t.maxHp) > (rule.hp ?? HURT)) return false;
      return true;
    }
    if (t.building) return false; // enemy buildings do not make a "group of units"
    if (rule?.prefer === "mana" && t.mana < SILENCE_MANA) return false; // Silence's own bar
    if (rule?.dispellable && !t.isSummon && !t.buffs.some((b) => Number.isFinite(b.timeLeft))) return false;
    return true;
  }

  // --- the fight, as the AI reads it ---------------------------------------------------

  /** Has this unit lost hit points since the previous pass, or is something visibly swinging
   *  at it? Either is "attacked" for Divine Shield's purposes — and the thread is explicit
   *  that it fires "often just before the caster is dealt damage", which is the second half. */
  private underAttack(u: SimUnit, foes: SimUnit[]): boolean {
    const was = this.lastHp.get(u.id);
    if (was !== undefined && u.hp < was) return true;
    return foes.some((f) => f.targetId === u.id && near(f, u, (f.weapon?.range ?? 0) + 100));
  }

  /** `SetHeroesFlee`'s other half — Berserk's "will not cast if outnumbered". Counted inside
   *  the caster's own eyes, both sides, workers and buildings left out of it. */
  private outnumbered(u: SimUnit, foes: SimUnit[]): boolean {
    const look = this.lookRange(u);
    let them = 0;
    for (const f of foes) if (!f.building && !f.isPeon && near(u, f, look)) them++;
    let us = 0;
    for (const a of this.view.world.units.values()) {
      if (a.hp <= 0 || a.building || a.isPeon || this.view.hostile(a)) continue;
      if (a.owner !== this.view.player) continue;
      if (near(u, a, look)) us++;
    }
    return them > us;
  }

  /** Already carrying a buff this rank of the ability applies. The sim's own no-restack rule
   *  (`autocastWants` → `findBuffFrom`), narrowed to THIS ability's buff ids so two different
   *  spells never block each other. Case-insensitively, because Blizzard's own data disagrees
   *  with itself about buff-id case (see `AbilityRegistry.buff`). */
  private alreadyOn(t: SimUnit, lvl: AbilityLevel): boolean {
    if (!lvl.buffs.length) return false;
    const want = lvl.buffs.map((b) => b.toLowerCase());
    return t.buffs.some((b) => b.buffId && want.includes(b.buffId.toLowerCase()));
  }

  private lookRange(u: SimUnit): number {
    return Math.max(u.weapon?.acquire ?? 0, MIN_LOOK);
  }
}

/** "Preference for units with at least 75 mana" — the thread's own number, for Silence and
 *  reused by every "has mana worth burning" preference. */
const SILENCE_MANA = 75;

/** Is this ability aimed at friends? The same expression `SimWorld.tickAutocast` derives from
 *  `targs1`, and for the same reason: the ability's own Targets Allowed is the only thing that
 *  knows, and a hard-coded list would drift from it. */
function friendlySpell(def: AbilityDef): boolean {
  const F = new Set(def.targetFlags.map((f) => f.toLowerCase()));
  return !F.has("enemy") && (F.has("friend") || F.has("self") || F.has("player"));
}

/** A wave's reach — `DataC` "Distance" for the Shock Wave / Carrion Swarm family, `DataA` for
 *  Impale, whose meta group numbers its columns differently (see the handlers in
 *  sim/spells.ts). Falls back to the cast range, then to the family's 700. */
function waveDistance(lvl: AbilityLevel): number {
  const c = lvl.data[2];
  if (Number.isFinite(c) && c > 0) return c;
  const a = lvl.data[0];
  if (Number.isFinite(a) && a > 0) return a;
  return lvl.castRange || 700;
}

/** Hull-to-hull, the way every range in the sim is measured. */
function near(a: SimUnit, b: SimUnit, range: number): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) - a.radius - b.radius <= range;
}

/**
 * A trigger for an ability the thread does not name, derived from its own row.
 *
 * The thread covers about seventy base abilities and the game has more, so the tail needs an
 * answer — and the answer has to come from the data rather than from a second hand-written
 * list, or it is just `KNOWN_ABILITIES` again with a chance to drift. The classes are the ones
 * the thread's own entries fall into:
 *
 *   `unitid1` set          → a SUMMON      → "casts when caster or nearby allies are engaging"
 *   `targs1` names `dead`  → a RAISE       → the same, with castUseError refusing empty ground
 *   friendly unit target   → a HEAL/BUFF   → a hurt ally
 *   enemy unit target      → a NUKE/CURSE  → spam
 *   an area                → an AoE        → the cluster of 2
 *   a bare self-buff       → a PANIC       → when attacked
 *
 * Anything left over — a point spell with no area, which is a Blink or a Far Sight — gets
 * nothing, which is the thread's own default: an ability the engine has no rule for is never
 * cast.
 */
function classDefault(def: AbilityDef, lvl: AbilityLevel): CastRule | null {
  const F = new Set(def.targetFlags.map((f) => f.toLowerCase()));
  if (lvl.summon || def.levelData.some((l) => !!l.summon)) return { when: "engaged" };
  if (F.has("dead")) return { when: "engaged" };
  const friendly = friendlySpell(def);
  if (def.target === "unit") return friendly ? { when: "hurtAlly", prefer: "hurt" } : { when: "spam" };
  if (def.target === "point") return lvl.area > 0 ? { when: "cluster" } : null;
  // no target at all
  if (lvl.area > 0) return friendly ? { when: "hurtAlly", prefer: "hurt" } : { when: "cluster" };
  return { when: "attacked" };
}
