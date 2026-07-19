import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";
import { MISC_GAME } from "./gameplayConstants";

// Ability data registry (plan §4, spells slice). Merges WC3's AbilityData.slk
// (numbers), per-race AbilityFunc.txt (icon/effect art/buttonpos) and
// AbilityStrings.txt (name/tooltip/hotkey) into one lookup keyed by ability id.
//
// The crucial field for modularity is **`code`** — the base ability an object
// derives from. A custom map's "Super Holy Light" gets a new alias id but keeps
// `code=AHhb`, so the sim dispatches its behaviour off `code`, never the alias.
// That is what lets us translate arbitrary maps without per-map code.

/** How an ability is aimed. Derived from its `code` (see KNOWN_ABILITIES). */
export type TargetType = "none" | "unit" | "point" | "passive";

/** One persistent model a buff hangs on the unit it is applied to, with the
 *  attachment point it rides. A buff row can list SEVERAL — Bloodlust puts a
 *  model on each hand, Spiked Carapace four on the chest (see parseBuffFx). */
export interface BuffFx {
  path: string; // .mdx model path
  /** The `Targetattach` tokens for this model ("origin", "overhead",
   *  ["chest","mount","left"], …). Matched — unordered — against the target
   *  model's attachment node names ("Chest Mount Left Ref"). [] = no attachment
   *  named, so the effect just sits at the unit's origin. */
  attach: string[];
}

/** Per-level numbers pulled from AbilityData's level-indexed columns. */
export interface AbilityLevel {
  cost: number; // mana cost (cost1..)
  cooldown: number; // cool1..
  duration: number; // dur1.. — effect duration on normal units
  heroDuration: number; // herodur1.. — (shorter) duration on heroes
  castRange: number; // rng1.. — how close the caster must be (0 = self/no-target)
  area: number; // area1.. — AoE radius
  castTime: number; // cast1.. — cast point / channel flag
  /** dataa1..datai1 as [a,b,c,d,e,f,g,h,i] — meaning is per-ability (see spells). */
  data: number[];
  /** The same nine columns UNPARSED. Most are numbers and `data` is what you want, but a
   *  few carry a rawcode: every morph ability keeps its "Normal Form Unit" in DataA
   *  (`[Abur] DataA1 = ucry`), which `data` can only render as NaN. Read this when the
   *  column names a unit/ability rather than measuring something. */
  dataStr: string[];
  buffs: string[]; // buffid1.. — buff/effect codes this rank applies
  summon: string; // unitid1.. — unit summoned (Water Elemental etc.)
}

export interface AbilityDef {
  id: string; // alias (row id, e.g. "AHhb" or a custom "A000")
  code: string; // base ability code — the dispatch key
  isHero: boolean; // learnable hero ability (hero=1)
  isItem: boolean;
  levels: number; // max learnable ranks
  reqLevel: number; // hero level required for rank 1 (ultimates: 6)
  levelSkip: number; // hero levels between ranks (basics: 2 → learn at 1,3,5)
  target: TargetType; // how it's cast (from KNOWN_ABILITIES; "passive" if unknown)
  targetFlags: string[]; // targs1 — air/ground/enemy/friend/organic/notself/…
  autocast: boolean; // can toggle autocast (Heal, Slow, …)
  name: string;
  icon: string; // command-button BLP path (art)
  hotkey: string; // Hotkey — the letter that CASTS it from the command card
  /** Researchhotkey — the letter that LEARNS it on the hero's skill page. A separate
   *  string in AbilityStrings, and for a passive it is the ONLY one: Bash ([AHbh]),
   *  Critical Strike, Devotion Aura, Evasion and every other passive/aura carry
   *  `Researchhotkey` with no `Hotkey` at all (nothing casts them), so keying the learn
   *  page off `hotkey` left exactly those buttons mouse-only. Falls back to `hotkey`. */
  researchHotkey: string;
  buttonX: number; // command-card column when active (buttonpos)
  buttonY: number; // command-card row when active
  learnX: number; // learn-skill page column (researchbuttonpos — usually row 0)
  learnY: number; // learn-skill page row
  research: boolean; // shown in the learn-skill page (hero ability)
  // Tooltip strings, WC3 markup intact (`|cffffcc00`/`|r`/`|n` — rendered by
  // src/ui/wc3Text.ts). `Tip` is the tooltip TITLE the game itself writes, gilded
  // hotkey letter and rank suffix included: "Holy Ligh|cffffcc00t|r - [|cffffcc00Level 1|r]".
  tips: string[]; // per-level titles (Tip)
  uberTips: string[]; // per-level bodies (Ubertip)
  researchTip: string; // learn-skill page title (Researchtip); "%d" = the rank being learned
  researchUberTip: string; // learn-skill page body (Researchubertip) — lists every rank
  levelData: AbilityLevel[]; // index 0 = rank 1
  // Effect model paths (from AbilityFunc) — the renderer plays these on cast.
  missileArt: string; // travelling projectile (Storm Bolt hammer, Death Coil orb)
  targetArt: string; // effect attached to the target (Holy Light burst, Heal); for an
  //                    aura this is the BIG model shown under its OWNER only.
  casterArt: string; // effect attached to the caster (Thunder Clap ring)
  specialArt: string; // extra one-shot effect (Flame Strike's erupting fire pillar)
  effectArt: string; // ability "beware"/effect art — Flame Strike's ground warning ring
  areaArt: string; // AoE ground effect (Blizzard, Rain of Fire)
  /** AbilityFunc `Effectsound` — a LABEL into `UI\SoundInfo\AbilitySounds.slk`, not a path
   *  (`PowerupSound` → Tomes.wav, `ReceiveGold` → ReceiveGold.wav). Most abilities carry
   *  none and sound themselves off their effect model's embedded SND event instead, which
   *  is why this is a fallback rather than the primary source: of the powerups, the runes
   *  and glyphs name `Effectsound=PowerupSound` while every TOME names nothing at all and
   *  relies on the SND…AITM event inside its Target model (verified 1.27a
   *  Units\ItemAbilityFunc.txt + AbilitySounds.slk row Y49). */
  effectSound: string;
  buffArt: string; // buffFx[0]'s path — the primary persistent model (convenience).
  /** The buff's own `Effectart` — the effect played when the buff ENDS, as distinct from
   *  buffFx (worn while it lasts) and the ability's `Effectart` (a pre-cast warning).
   *  This is where an unsummon lives: `[BOsf] Effectart = …\feralspiritdone.mdl` is what
   *  replaces a Feral Spirit wolf when its timer runs out. Verified 2026-07 against the
   *  1.27 MPQ (BOsf/BNsg/BNsq/BNsw all carry it). */
  buffEffectArt: string;
  /** The buff's own `Specialart` — a PROC, and what it means is per-ability, so read it
   *  only where you know the ability: Frost Armor's is the chill on an attacker, Mirror
   *  Image's (`[BOmi]` MirrorImageDeathCaster) is an illusion popping, and Blizzard's own
   *  comment on `[BNlm]` says the Lava Spawn's "is used when the lava monster splits".
   *  Never treat it as a generic death/unsummon slot. */
  buffSpecialArt: string;
  /** The PERSISTENT models worn by a unit carrying this ability's buff (buffid1),
   *  each with its attachment point: Divine Shield's bubble, Banish's ethereal glow,
   *  the small per-unit aura swirl (GeneralAuraTarget), Bloodlust's two hand flames.
   *  This — NOT the ability's own TargetArt — is where a buff's art lives; most
   *  buff-applying abilities have no TargetArt at all. */
  buffFx: BuffFx[];
  animNames: string[]; // caster animation tags (AbilityFunc "animnames": spell,throw,slam…)
  // The ability's ORDER STRING (AbilityFunc `Order=holybolt`, and `Orderon`/`Orderoff`
  // for an autocast toggle). This is the name a script casts it by: the GUI's "Unit -
  // Order <unit> to <ability>" compiles to IssueTargetOrder(u, "holybolt", target), so
  // without it a trigger can't make a unit cast anything (7.17).
  order: string;
  orderOn: string; // autocast on (Orderon)
  orderOff: string; // autocast off (Orderoff)
}

/** Ability behaviours we implement, keyed by base `code`. `target` tells the UI/
 *  sim how to aim it; `autocast` marks abilities that can toggle autocasting.
 *  Anything not listed here loads as data but is treated as passive/uncastable
 *  (so unknown custom abilities degrade gracefully rather than crash). */
export const KNOWN_ABILITIES: Record<string, { target: TargetType; autocast?: boolean }> = {
  // === Human heroes ===
  // -- Paladin --
  AHhb: { target: "unit" }, // Holy Light — heal ally / smite undead
  AHds: { target: "none" }, // Divine Shield — self invulnerability
  AHre: { target: "none" }, // Resurrection — raise dead allies from corpses
  AHad: { target: "passive" }, // Devotion Aura — +armour
  // -- Mountain King --
  AHtb: { target: "unit" }, // Storm Bolt — hammer: damage + stun
  AHtc: { target: "none" }, // Thunder Clap — PBAoE damage + slow
  AHbh: { target: "passive" }, // Bash — chance to stun on attack
  AHav: { target: "none" }, // Avatar — self-buff (HP/damage/immunity)
  // -- Archmage --
  AHbz: { target: "point" }, // Blizzard — channelled point AoE waves
  AHab: { target: "passive" }, // Brilliance Aura — +mana regen
  AHwe: { target: "none" }, // Summon Water Elemental
  AHmt: { target: "point" }, // Mass Teleport — warp nearby allies to a point
  // -- Blood Mage --
  AHfs: { target: "point" }, // Flame Strike — delayed point AoE burn field
  AHbn: { target: "unit" }, // Banish — debuff: slow + magic vulnerability
  AHdr: { target: "unit" }, // Siphon Mana / Life Drain — drain from target to caster
  AHpx: { target: "none" }, // Phoenix — summon a phoenix
  // === Orc heroes ===
  // -- Blademaster --
  AOwk: { target: "none" }, // Wind Walk — self invis + haste + bonus damage
  AOcr: { target: "passive" }, // Critical Strike — chance to multiply a swing
  AOmi: { target: "none" }, // Mirror Image — summon illusions of self
  AOww: { target: "none" }, // Bladestorm — self PBAoE damage field
  // -- Far Seer --
  AOfs: { target: "point" }, // Far Sight — reveal an area
  AOsf: { target: "none" }, // Feral Spirit — summon wolves
  AOcl: { target: "unit" }, // Chain Lightning — bouncing bolt
  AOeq: { target: "point" }, // Earthquake — point field: damage buildings + slow
  // -- Tauren Chieftain --
  AOsh: { target: "point" }, // Shockwave — line nuke
  AOae: { target: "passive" }, // Endurance Aura — +move & attack speed
  AOre: { target: "passive" }, // Reincarnation — revive on death
  AOws: { target: "none" }, // War Stomp — PBAoE damage + stun
  // -- Shadow Hunter --
  AOhw: { target: "unit" }, // Healing Wave — chained heal
  AOhx: { target: "unit" }, // Hex — transform/disable a target
  AOwd: { target: "point" }, // Serpent Ward — summon a ward
  AOvd: { target: "none" }, // Big Bad Voodoo — nearby allies invulnerable
  AOac: { target: "passive" }, // Command Aura — +attack damage
  // === Undead heroes ===
  // -- Death Knight --
  AUdc: { target: "unit" }, // Death Coil — heal undead / harm living
  AUdp: { target: "unit" }, // Death Pact — sacrifice a friendly unit to heal
  AUau: { target: "passive" }, // Unholy Aura — +move speed & hp regen
  AUan: { target: "point" }, // Animate Dead — temporarily raise nearby corpses
  // -- Lich --
  AUfn: { target: "unit" }, // Frost Nova — missile: AoE damage + slow on impact
  AUfu: { target: "unit", autocast: true }, // Frost Armor — +armour, slows attackers
  AUdr: { target: "unit" }, // Dark Ritual — sacrifice a summon for mana
  AUdd: { target: "point" }, // Death and Decay — point AoE % damage field
  // -- Dreadlord --
  AUav: { target: "passive" }, // Vampiric Aura — melee life steal
  AUsl: { target: "unit" }, // Sleep — disable a target (wakes on damage)
  AUcs: { target: "point" }, // Carrion Swarm — line nuke
  AUin: { target: "point" }, // Inferno — summon an infernal + impact damage
  // -- Crypt Lord --
  AUim: { target: "point" }, // Impale — line nuke + stun
  AUts: { target: "passive" }, // Spiked Carapace — bonus armour + return damage
  AUcb: { target: "point" }, // Carrion Beetles — summon a beetle
  AUls: { target: "none" }, // Locust Swarm — self PBAoE life-drain field
  // === Night Elf heroes ===
  // -- Keeper of the Grove --
  AEer: { target: "unit" }, // Entangling Roots — root + DoT
  AEfn: { target: "point" }, // Force of Nature — summon treants
  AEah: { target: "passive" }, // Thorns Aura — return melee damage
  AEtq: { target: "point" }, // Tranquility — channelled area heal field
  // -- Priestess of the Moon --
  AHfa: { target: "none", autocast: true }, // Searing Arrows — bonus fire damage on attack
  AEst: { target: "none" }, // Scout — summon a flying owl
  AEar: { target: "passive" }, // Trueshot Aura — +ranged attack damage
  AEsf: { target: "none" }, // Starfall — channelled PBAoE waves around the caster
  // -- Demon Hunter --
  AEmb: { target: "unit" }, // Mana Burn — burn mana + deal that much damage
  AEim: { target: "none" }, // Immolation — self damage field (toggle)
  AEev: { target: "passive" }, // Evasion — chance to dodge attacks
  AEme: { target: "none" }, // Metamorphosis — self transform buff
  // -- Warden --
  AEbl: { target: "point" }, // Blink — teleport a short distance
  AEfk: { target: "none" }, // Fan of Knives — PBAoE nuke
  AEsh: { target: "unit" }, // Shadow Strike — missile: damage + poison DoT + slow
  AEsv: { target: "passive" }, // Vengeance — (ultimate passive)
  // === Neutral heroes ===
  // -- Naga Sea Witch --
  ANfl: { target: "point" }, // Forked Lightning — cone nuke
  AHca: { target: "none", autocast: true }, // Cold / Frost Arrows — slow on attack
  ANms: { target: "none" }, // Mana Shield — absorb damage into mana (toggle)
  ANto: { target: "point" }, // Tornado — summon a tornado
  // -- Dark Ranger --
  ANsi: { target: "point" }, // Silence — area silence
  ANba: { target: "none", autocast: true }, // Black Arrow — bonus damage on attack
  ANch: { target: "unit" }, // Charm — take control of a target
  // -- Pandaren Brewmaster --
  ANbf: { target: "point" }, // Breath of Fire — line nuke
  ANdh: { target: "point" }, // Drunken Haze — area slow
  ANdb: { target: "passive" }, // Drunken Brawler — crit + evasion (passive)
  ANef: { target: "none" }, // Storm, Earth and Fire — summon three pandaren
  // -- Beastmaster --
  ANsg: { target: "none" }, // Summon Bear
  ANsq: { target: "none" }, // Summon Quilbeast
  ANsw: { target: "none" }, // Summon Hawk
  ANst: { target: "point" }, // Stampede — channelled point field
  // -- Pit Lord --
  ANrf: { target: "point" }, // Rain of Fire — point AoE waves
  ANht: { target: "none" }, // Howl of Terror — PBAoE enemy damage debuff
  ANca: { target: "passive" }, // Cleaving Attack — splash on attack
  ANdo: { target: "unit" }, // Doom — DoT curse
  // -- Goblin Tinker --
  ANsy: { target: "point" }, // Pocket Factory — summon a factory
  ANcs: { target: "point" }, // Cluster Rockets — point AoE
  ANeg: { target: "passive" }, // Engineering Upgrade (passive)
  ANrg: { target: "none" }, // Robo-Goblin — self transform buff
  // -- Firelord --
  ANia: { target: "none", autocast: true }, // Incinerate — bonus fire damage on attack
  ANso: { target: "unit" }, // Soul Burn — DoT + silence
  ANlm: { target: "point" }, // Summon Lava Spawn
  ANvc: { target: "point" }, // Volcano — point field
  // -- Goblin Alchemist --
  ANhs: { target: "point" }, // Healing Spray — area heal
  ANab: { target: "unit" }, // Acid Bomb — DoT + armour reduction
  ANcr: { target: "none" }, // Chemical Rage — self haste buff
  ANtm: { target: "unit" }, // Transmute — kill a non-hero for gold
  // === Unit casters ===
  Ahea: { target: "unit", autocast: true }, // Priest Heal
  Adis: { target: "point" }, // Dispel Magic — clear buffs, damage summons
  Ainf: { target: "unit", autocast: true }, // Inner Fire — +armour +damage
  Aslo: { target: "unit", autocast: true }, // Slow (Sorceress)
  Ablo: { target: "unit", autocast: true }, // Bloodlust (Shaman) — +attack & move speed
  Aprg: { target: "unit" }, // Purge (Shaman) — strip buffs, slow enemy, destroy summons
  Aens: { target: "unit", autocast: true }, // Ensnare (Raider) — root a target (air pulled down)
  Alsh: { target: "unit" }, // Lightning Shield (Shaman) — damaging shield around a unit
  Absk: { target: "none" }, // Berserk (Troll Berserker) — self: faster attack, +damage taken
  Aeye: { target: "point" }, // Sentry Ward (Witch Doctor) — summon a vision ward
  Ahwd: { target: "point" }, // Healing Ward (Witch Doctor) — summon a healing ward
  Asta: { target: "point" }, // Stasis Trap (Witch Doctor) — summon a proximity stun trap
  Aspl: { target: "unit" }, // Spirit Link (Spirit Walker) — link a group, share damage
  Aast: { target: "point" }, // Ancestral Spirit (Spirit Walker) — revive a Tauren corpse
  // Disenchant (Adcn) dispatches to the existing Adis handler (its code IS Adis).
  Aakb: { target: "passive" }, // War Drums (Kodo Beast) — damage aura (see AURA_BUFFS)
  Awar: { target: "passive" }, // Pulverize (Tauren) — chance for a splash on attack (sim hook)
  Aliq: { target: "passive" }, // Liquid Fire (Batrider) — on-attack building burn (sim hook)
  Auco: { target: "unit" }, // Unstable Concoction (Batrider) — suicide AoE vs air units
  Adev: { target: "unit" }, // Devour (Kodo Beast) — swallow & digest an enemy land unit
  Asal: { target: "passive" }, // Pillage — gold on building attacks (gated on the Ropg upgrade)
  Acpf: { target: "none" }, // Corporeal/Ethereal Form (Spirit Walker) — self toggle between forms
  // === Creep & neutral casters (issue: ability audit) ===
  // Each Data column's meaning below is the game's own, read from AbilityMetaData.slk's
  // `useSpecific` rows through WorldEditStrings.txt — not inferred from behaviour.
  Aroa: { target: "none" }, // Roar — PBAoE friendly damage buff (no Rng, Area 500)
  ANfb: { target: "unit" }, // Fire Bolt — missile: damage + stun (the creep Storm Bolt)
  ANfd: { target: "unit" }, // Finger of Death — single-target nuke
  Anhe: { target: "unit", autocast: true }, // Heal (creep) — Orderon/Orderoff = autocast
  Arej: { target: "unit" }, // Rejuvenation — hp (and mana) restored over time
  Acri: { target: "unit" }, // Cripple — slow move & attack, and cut the target's damage
  Afae: { target: "unit", autocast: true }, // Faerie Fire — armour reduction (Orderon/Orderoff)
  Auhf: { target: "unit" }, // Unholy Frenzy — attack speed at the cost of the target's life
  Aadm: { target: "unit", autocast: true }, // Abolish Magic — single-target dispel (Orderon/Orderoff)
  Asds: { target: "unit" }, // Kaboom! — the Goblin Sapper walks in and detonates (Rng 0)
  // Cannibalize — no target: the Ghoul eats whatever corpse is under its feet (Rng 50).
  Acan: { target: "none" },
  // === Upgrade-granted (issue #57) ===
  // Each of these carries `Requires=<upgradeId>` in its AbilityFunc row, so the tech graph
  // already gates it and the command card hides the button until the research lands — the
  // ability itself sits on the unit from birth, exactly as it does in WC3.
  //
  // Defend (Footman, `Rhde`) is a STANCE. The data says so: HumanAbilityFunc gives it an order
  // PAIR (`Order=defend` / `Unorder=undefend`) rather than a single cast order, which is the
  // same on/off shape as an autocast toggle — so it rides that flag. See defendStance().
  Adef: { target: "none", autocast: true },
  // Passive indicators whose EFFECT is the upgrade itself, not an ability: the button is a
  // "you have this now" badge (their art is PASBTN*, the passive button family). Bombs is the
  // `renw` weapon slot, Storm Hammers the `rasd` line spill, Barrage the `rtma` unit swap —
  // all three already land in the sim, so the badge and the behaviour agree.
  Agyb: { target: "passive" }, // Flying Machine Bombs (`Rhgb`)
  Asth: { target: "passive" }, // Storm Hammers (`Rhhb`)
  Aroc: { target: "passive" }, // Barrage (`Rhrt`)
  // === Passives the SIM reads off the ability list ===
  // These cast nothing, but recomputeStats DERIVES a unit property from them, and a unit only
  // carries an ability that survives buildInitialAbilities — which keeps exactly what is
  // listed here. Leaving them out doesn't merely hide a button: it silently switches the
  // property off for every unit in the game. True Sight sat at radius 0 and magic immunity at
  // `false` for precisely that reason, each with a working derivation behind it and nothing
  // to derive from.
  //
  // They are genuine passive BUTTONS in WC3 too, the Devotion Aura shape — each carries its
  // own PASBTN art (PASBTNShadeTrueSight, PASBTNMagicalSentry, PASBTNMagicImmunity) and a
  // Buttonpos — so showing them on the card is authentic, not a side-effect.
  // Shadow Meld — the night elf racial. Self-cast (order `ambush`), night only; see the
  // handler in spells.ts. `Sshm` is the same code with a 0.1s fade instead of 1.5s.
  Ashm: { target: "none" },
  // Root/Unroot — the Ancients' stance toggle (`Order=root` / `Unorder=unroot`). Self-cast:
  // it takes no target, it just changes what the Ancient is. Aro1/Aro2 alias it.
  Aroo: { target: "none" },
  // Burrow — the Crypt Fiend digs in (`Order=burrow` / `Unorder=unburrow`). A form toggle
  // between the two units the ability names; Abu2/Abu3/Abu5 alias it for the scarabs and the
  // Barbed Arachnathid. See the handler for why its sibling morphs are not listed here yet.
  Abur: { target: "none" },
  Atru: { target: "passive" }, // True Sight — the Shade (`ushd`), Rng1 900
  Adts: { target: "passive" }, // Magic Sentry — the four Human towers, Rng1 900, gated on `Rhse`
  Amim: { target: "passive" }, // Magic Immunity — Dryad, Faerie Dragon, Spirit Walker, nbel
  // `Adet` "Detect (Sentry Ward)" (Rng1 1100) is in AbilityData.slk but NO unit lists it in
  // 1.27a's UnitAbilities.slk — it is a dead row. It stays out of this table (nothing would
  // ever carry it) while the sim's detect derivation still honours the code, so a custom map
  // that hands it out gets the radius the data promises.
};

interface Row {
  string(key: string): string | undefined;
}

export class AbilityRegistry {
  // Per-map custom overlay from war3map.w3a (see src/data/objectData.ts), mirroring
  // UnitRegistry: get() checks it first; cleared on map change.
  constructor(
    private defs: Map<string, AbilityDef>,
    private custom = new Map<string, AbilityDef>(),
    /** Every `[B….]` buff section's persistent models, by buff id. `AbilityDef.buffFx` is
     *  only buffid1's, which is right for the many abilities that apply one buff — but an
     *  ability may list SEVERAL and choose between them at cast time off its own numbers.
     *  The regeneration items are the clear case: `BIrg,BIrl,BIrm` is life-and-mana, life,
     *  mana, and which one a Healing Salve wears depends on whether DataB is 0. */
    private buffs = new Map<string, BuffFx[]>(),
  ) {}
  /** The persistent models a given buff id hangs on its holder ([] if unknown). */
  buffFx(buffId: string): BuffFx[] {
    return this.buffs.get(buffId) ?? [];
  }
  get(id: string): AbilityDef | undefined {
    return this.custom.get(id) ?? this.defs.get(id);
  }
  has(id: string): boolean {
    return this.custom.has(id) || this.defs.has(id);
  }
  get size(): number {
    return new Set([...this.defs.keys(), ...this.custom.keys()]).size;
  }
  all(): AbilityDef[] {
    return [...new Map([...this.defs, ...this.custom]).values()];
  }
  /** The base (install) def for `id`, ignoring the custom overlay — what a custom
   *  ability clones from. */
  base(id: string): AbilityDef | undefined {
    return this.defs.get(id);
  }
  setCustom(id: string, def: AbilityDef): void {
    this.custom.set(id, def);
  }
  clearCustom(): void {
    this.custom.clear();
  }
}

const FUNC_FILES = [
  "Units\\HumanAbilityFunc.txt",
  "Units\\OrcAbilityFunc.txt",
  "Units\\UndeadAbilityFunc.txt",
  "Units\\NightElfAbilityFunc.txt",
  "Units\\NeutralAbilityFunc.txt",
  "Units\\CommonAbilityFunc.txt",
  "Units\\ItemAbilityFunc.txt",
  "Units\\CampaignAbilityFunc.txt",
];
const STRING_FILES = FUNC_FILES.map((f) => f.replace("Func", "Strings"));

export function loadAbilityRegistry(vfs: DataSource): AbilityRegistry {
  const defs = new Map<string, AbilityDef>();
  const bytes = vfs.rawBytes("Units\\AbilityData.slk");
  if (!bytes) return new AbilityRegistry(defs);
  const data = new MappedData(new TextDecoder("windows-1252").decode(bytes));

  const func = new MappedData();
  for (const p of FUNC_FILES) {
    const b = vfs.rawBytes(p);
    if (b) func.load(new TextDecoder("windows-1252").decode(b));
  }
  const strs = new MappedData();
  for (const p of STRING_FILES) {
    const b = vfs.rawBytes(p);
    if (b) strs.load(new TextDecoder("windows-1252").decode(b));
  }

  for (const id of Object.keys(data.map)) {
    const r = data.getRow(id) as Row | undefined;
    if (!r) continue;
    const code = str(r, "code") || id;
    // Skip rows with no real code (SLK header/comment artefacts).
    if (!code || code.length < 2) continue;
    const levels = Math.max(1, num(r, "levels", 1));
    const f = func.getRow(id) as Row | undefined;
    const s = strs.getRow(id) as Row | undefined;
    const [bx, by] = f ? parseButtonPos(str(f, "buttonpos") || str(f, "researchbuttonpos")) : [0, 0];
    const [lx, ly] = f ? parseButtonPos(str(f, "researchbuttonpos") || str(f, "buttonpos")) : [0, 0];
    const known = KNOWN_ABILITIES[code];
    const buffFx = buffFxOf(func, str(r, "buffid1"));

    const levelData: AbilityLevel[] = [];
    for (let L = 1; L <= levels; L++) {
      levelData.push({
        cost: num(r, `cost${L}`, levelData[L - 2]?.cost ?? 0),
        cooldown: num(r, `cool${L}`, levelData[L - 2]?.cooldown ?? 0),
        duration: num(r, `dur${L}`, levelData[L - 2]?.duration ?? 0),
        heroDuration: num(r, `herodur${L}`, levelData[L - 2]?.heroDuration ?? 0),
        castRange: num(r, `rng${L}`, levelData[L - 2]?.castRange ?? 0),
        area: num(r, `area${L}`, levelData[L - 2]?.area ?? 0),
        castTime: num(r, `cast${L}`, levelData[L - 2]?.castTime ?? 0),
        data: "abcdefghi".split("").map((c) => num(r, `data${c}${L}`, NaN)),
        dataStr: "abcdefghi".split("").map((c) => str(r, `data${c}${L}`) || ""),
        buffs: (str(r, `buffid${L}`) || "").split(",").map((x) => x.trim()).filter(Boolean),
        summon: str(r, `unitid${L}`),
      });
    }

    defs.set(id, {
      id,
      code,
      isHero: num(r, "hero", 0) === 1,
      isItem: num(r, "item", 0) === 1,
      levels,
      reqLevel: num(r, "reqlevel", 0),
      levelSkip: num(r, "levelskip", 0),
      target: known ? known.target : "passive",
      targetFlags: (str(r, "targs1") || "").split(",").map((x) => x.trim()).filter((x) => x && x !== "_"),
      autocast: !!known?.autocast,
      name: (s && str(s, "Name")) || id,
      icon: f ? str(f, "art") : "",
      hotkey: (s ? (str(s, "Hotkey").trim()[0] ?? "") : "").toUpperCase(),
      researchHotkey: (s ? (str(s, "Researchhotkey").trim()[0] ?? str(s, "Hotkey").trim()[0] ?? "") : "").toUpperCase(),
      buttonX: bx,
      buttonY: by,
      learnX: lx,
      learnY: ly,
      research: num(r, "hero", 0) === 1,
      tips: splitTips(s ? str(s, "Tip") : ""),
      uberTips: splitList(s ? str(s, "Ubertip") : ""),
      researchTip: rawTip(s ? str(s, "Researchtip") : ""),
      researchUberTip: rawTip(s ? str(s, "Researchubertip") : ""),
      levelData,
      missileArt: mdlPath(f ? str(f, "Missileart") : ""),
      targetArt: mdlPath(f ? str(f, "TargetArt") : ""),
      casterArt: mdlPath(f ? str(f, "Casterart") : ""),
      specialArt: mdlPath(f ? str(f, "SpecialArt") : ""),
      effectArt: mdlPath(f ? str(f, "Effectart") : ""),
      areaArt: mdlPath(f ? str(f, "Areaeffectart") : ""),
      effectSound: f ? str(f, "Effectsound") : "", // a SLK label, NOT a path — no mdlPath here
      // The persistent buff model lives on the BUFF, not the ability: resolve
      // buffid1's own [B….] func section TargetArt (Banish → BanishTarget, an aura →
      // GeneralAuraTarget, Flame Strike → FlameStrikeDamageTarget). Verified 2026-07
      // against the 1.27 MPQ (docs/wc3-data-formats.md).
      buffFx: buffFx,
      buffArt: buffFx[0]?.path ?? "",
      buffEffectArt: mdlPath(buffField(func, str(r, "buffid1"), "Effectart")),
      buffSpecialArt: mdlPath(buffField(func, str(r, "buffid1"), "Specialart")),
      animNames: (f ? str(f, "animnames") : "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      // Order strings (AbilityFunc `Order`/`Orderon`/`Orderoff`) — how a trigger casts it.
      order: (f ? str(f, "Order") : "").trim().toLowerCase(),
      orderOn: (f ? str(f, "Orderon") : "").trim().toLowerCase(),
      orderOff: (f ? str(f, "Orderoff") : "").trim().toLowerCase(),
    });
  }
  for (const id of UI_BUTTON_IDS) addUiButton(defs, id, func, strs);
  // Index every buff section's models, so an ability that lists several buffs can pick the
  // one its numbers call for (see AbilityRegistry.buffFx).
  const buffs = new Map<string, BuffFx[]>();
  for (const id of Object.keys(func.map)) {
    if (id[0] !== "B") continue;
    const fx = buffFxOf(func, id);
    if (fx.length) buffs.set(id, fx);
  }
  return new AbilityRegistry(defs, new Map(), buffs);
}

/** Command buttons the ENGINE draws that are not abilities: they have a `[…]` section in
 *  AbilityFunc/AbilityStrings (name, tooltip, hotkey, icon, buttonpos) but no row in
 *  AbilityData.slk, because nothing casts them and no unit lists them in `abilList`.
 *
 *  `Anei` — "Select User", hotkey U, `BTNSelectUnit.blp` at Buttonpos 3,2 — is the shop's
 *  purchaser button. Do NOT reach for `Aneu`/`Ane2` for its text: those are the real
 *  abilities that give a shop its radius and flags, and their names ("Select Hero" with
 *  hotkey H, "Select Unit" with U) are RoC-era leftovers. `Anei` is what TFT actually
 *  labels the button with. */
const UI_BUTTON_IDS = ["Anei"];

/** Synthesize a def for a UI-only button (see UI_BUTTON_IDS). Everything an ability would
 *  carry — levels, targets, effect art — is absent by construction; this is presentation. */
function addUiButton(defs: Map<string, AbilityDef>, id: string, func: MappedData, strs: MappedData): void {
  if (defs.has(id)) return; // a real ability row wins
  const f = func.getRow(id) as Row | undefined;
  const s = strs.getRow(id) as Row | undefined;
  if (!f && !s) return; // this install doesn't have it
  const [bx, by] = f ? parseButtonPos(str(f, "buttonpos")) : [0, 0];
  defs.set(id, {
    id,
    code: id,
    isHero: false,
    isItem: false,
    levels: 0,
    reqLevel: 0,
    levelSkip: 0,
    target: "passive", // nothing casts it; the host wires up what the click does
    targetFlags: [],
    autocast: false,
    name: (s && str(s, "Name")) || id,
    icon: f ? str(f, "art") : "",
    hotkey: (s ? (str(s, "Hotkey").trim()[0] ?? "") : "").toUpperCase(),
    researchHotkey: "",
    buttonX: bx,
    buttonY: by,
    learnX: bx,
    learnY: by,
    research: false,
    tips: splitTips(s ? str(s, "Tip") : ""),
    uberTips: splitList(s ? str(s, "Ubertip") : ""),
    researchTip: "",
    researchUberTip: "",
    levelData: [],
    missileArt: "",
    targetArt: "",
    casterArt: "",
    specialArt: "",
    effectArt: "",
    areaArt: "",
    effectSound: "",
    buffFx: [],
    buffArt: "",
    buffEffectArt: "",
    buffSpecialArt: "",
    animNames: [],
    order: "",
    orderOn: "",
    orderOff: "",
  });
}

/** Value of a tooltip-referenced column on ONE rank (`DataA1`, `Dur1`, `Cost1`, …) — every
 *  rank-indexed column an Ubertip may name. The caller has already picked the rank off the
 *  column's trailing digit (see src/data/tipRefs.ts), so the digit is stripped here. */
export function tipFieldValue(lvl: AbilityLevel, field: string): number | null {
  const f = field.toLowerCase().replace(/\d+$/, "");
  const dataIdx = "abcdefghi".indexOf(f.replace(/^data/, ""));
  if (f.startsWith("data") && dataIdx >= 0) return lvl.data[dataIdx] ?? null;
  switch (f) {
    case "dur":
      return lvl.duration;
    case "herodur":
      return lvl.heroDuration;
    case "cost":
      return lvl.cost;
    case "cool":
      return lvl.cooldown;
    case "area":
      return lvl.area;
    case "rng":
      return lvl.castRange;
    case "cast":
      return lvl.castTime; // "<AEsh,Cast1>" — Shadowmeld's own channel time
    default:
      return null;
  }
}

/** Hero level required to learn a given rank (1-based) of an ability — MiscGame's
 *  "baseReq + levelSkip*abilityLevel". Basics take the default 2-level skip (ranks
 *  at hero 1/3/5); ultimates carry reqLevel 6 directly. */
export function requiredHeroLevel(def: AbilityDef, rank: number): number {
  const skip = def.levelSkip > 0 ? def.levelSkip : MISC_GAME.HeroAbilityLevelSkip;
  return Math.max(1, def.reqLevel) + skip * (rank - 1);
}

// AbilityStrings pack per-level Ubertips as a QUOTED, comma-separated list
// `"level 1","level 2","level 3"` — but the SLK reader strips the OUTER quotes,
// leaving `level 1","level 2","level 3`. Split on the `","` separator (not quote
// pairs — that matched the `","` gap and returned commas) and trim stray quotes.
// A single-level ability has no separator left, so it stays one entry — which is
// why this must NOT split on bare commas: an Ubertip sentence is full of them.
function splitList(v: string): string[] {
  if (!v) return [];
  return v
    .split(/",\s*"/)
    .map((p) => rawTip(p))
    .filter(Boolean);
}

// `Tip`, unlike `Ubertip`, is an UNQUOTED comma-separated list — one title per rank
// (`AHbz`: "|cffffcc00B|rlizzard - [|cffffcc00Level 1|r],…"). No stock Tip contains a
// literal comma, so a bare split is safe here and splitList's `","` rule is not.
function splitTips(v: string): string[] {
  if (!v) return [];
  return v.split(",").map((p) => rawTip(p)).filter(Boolean);
}

// Keep the WC3 markup — it's the tooltip's formatting (src/ui/wc3Text.ts). Only the
// quotes the reader leaves on come off.
function rawTip(v: string): string {
  return v.replace(/^"|"$/g, "").trim();
}

/** A buff's `[B….]` section in the same AbilityFunc files (buffs live alongside
 *  abilities there). `buffId` may be a comma-list (multi-buff abilities); we take
 *  the first. */
function buffRow(func: MappedData, buffId: string): Row | undefined {
  const first = (buffId || "").split(",")[0]?.trim();
  return first ? (func.getRow(first) as Row | undefined) : undefined;
}

/** One art field off a buff's own row ("" if the buff or the field is absent). */
function buffField(func: MappedData, buffId: string, key: string): string {
  const row = buffRow(func, buffId);
  return row ? str(row, key) : "";
}

/** A buff's own persistent models, read from its `[B….]` section.
 *
 *  NOTE the buff row carries THREE distinct art fields, and they are not
 *  interchangeable: `Targetart` (worn while the buff lasts — this function),
 *  `Effectart` (played when the buff ENDS — see buffEffectArt), and `Specialart`
 *  (a proc, e.g. Frost Armor's chill on an attacker).
 *
 *  The buff row pairs a comma-list of models with one attach spec each:
 *    [Bblo]  Targetart = …\BloodlustTarget.mdl,…\BloodlustSpecial.mdl
 *            Targetattachcount = 2
 *            Targetattach  = hand,left      ← model 0
 *            Targetattach1 = hand,right     ← model 1
 *  So `Targetattach` is model 0's spec and `Targetattach<i>` is model i's — and each
 *  spec is ITSELF a comma-list of tokens ("hand" + "left"), not two attach points.
 *  Verified 2026-07 against the 1.27 MPQ (Bblo/BUts/Bbsk/BHds; docs/wc3-data-formats.md).
 */
function buffFxOf(func: MappedData, buffId: string): BuffFx[] {
  const row = buffRow(func, buffId);
  if (!row) return [];
  const paths = str(row, "Targetart")
    .split(",")
    .map((p) => mdlPath(p))
    .filter(Boolean);
  return paths.map((path, i) => ({
    path,
    // Model 0 reads `Targetattach`, model i>0 reads `Targetattach<i>`.
    attach: str(row, i === 0 ? "Targetattach" : `Targetattach${i}`)
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  }));
}

// Effect-art fields are ".mdl" model paths (comma-lists sometimes). Take the
// first, normalise to the compiled ".mdx" the MPQ actually ships.
export function mdlPath(v: string): string {
  if (!v) return "";
  const pick = v.split(",")[0]?.trim();
  if (!pick) return "";
  const p = pick.replace(/\//g, "\\").replace(/\.mdl$/i, "");
  return /\.mdx$/i.test(p) ? p : `${p}.mdx`;
}

function parseButtonPos(v: string): [number, number] {
  const m = /(\d+)\s*,\s*(\d+)/.exec(v || "");
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [0, 0];
}

function str(row: Row, key: string): string {
  const v = row.string(key);
  return v === undefined || v === "-" ? "" : v;
}
function num(row: Row, key: string, fallback: number): number {
  const v = row.string(key);
  if (v === undefined || v === "-" || v === "") return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}
