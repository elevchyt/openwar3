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

/** The three base codes REPAIR ships as — Repair, Restoration and Renew. One behaviour, three
 *  rows, and the only reason to tell them apart is Renew's missing `nonancient` (see
 *  KNOWN_ABILITIES). Shared so the sim and the command card agree on what a repair ability is. */
export function isRepairCode(code: string): boolean {
  return code === "Arep" || code === "Arst" || code === "Aren";
}

/** The base codes CRITICAL STRIKE ships as. One behaviour, two rows — and the sibling
 *  aliases fold into them for free, because AbilityData.slk gives each clone the base row's
 *  `code`: "Critical Strike (creep)" (ACct) and "Critical Strike (item)" (AIcs) both carry
 *  `code=AOcr`, and Chen's campaign Drunken Brawler (Acdb) carries `code=ANdb`.
 *
 *  Why they are one implementation rather than two: AbilityMetaData.slk hands both rows the
 *  SAME field group — `Ocr1..Ocr6` are declared `useSpecific=AOcr,ACct,ANdb` — so dataA is
 *  "Chance to Critical Strike" (a percent, maxVal=100), dataB the damage multiplier and dataD
 *  "Chance to Evade" (a fraction, maxVal=1) on the Brewmaster exactly as on the Blademaster.
 *  Drunken Brawler is Critical Strike with the evasion half switched on:
 *  AOcr = 15% × 2/3/4, ANdb = 10% × 2/3/4 with a 7/14/21% dodge. */
export function isCriticalStrikeCode(code: string): boolean {
  return code === "AOcr" || code === "ANdb";
}

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

/** A buff — its own object type in the data, with its own `[B….]` section in the same
 *  AbilityFunc/AbilityStrings files the abilities live in. What the info panel's
 *  **Status** row shows comes from HERE, not from the ability that applied it:
 *
 *      [Bblo]  Buffart     = ReplaceableTextures\CommandButtons\BTNBloodLust.blp
 *              Bufftip     = Bloodlust
 *              Buffubertip = "This unit has Bloodlust; its attack rate and movement
 *                             speed are increased."
 *
 *  `Buffart` is an ICON (a CommandButtons BLP), unlike every other art field on the row,
 *  which names a model. And the name is often NOT the ability's: Slow (`Aslo`) hangs
 *  `Bfro`, whose Bufftip is "Slowed" — the state the unit is in, which is what a status
 *  row is for. */
export interface BuffDef {
  id: string; // the `B….` code
  icon: string; // Buffart — the status-row icon
  name: string; // Bufftip — the tooltip title
  tip: string; // Buffubertip — the tooltip body (WC3 markup intact)
  fx: BuffFx[]; // Targetart(s) — the models it hangs on its holder (see buffFxOf)
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

/** A blank rank — every field present, nothing set. Lives beside the interface so the one
 *  place that knows the shape is the only place that has to spell it out: the custom-object
 *  overlay pads its level array with these, and the headless tests build their stub abilities
 *  from one. Hand-rolled level literals drift (a `.cjs` test stub with no `dataStr` is what
 *  sent cloneLevel's `[...l.dataStr]` through an undefined and crashed the whole JASS suite);
 *  spreading this can't. Nine slots because DataA..DataI is nine. */
export const emptyAbilityLevel = (): AbilityLevel => ({
  cost: 0, cooldown: 0, duration: 0, heroDuration: 0, castRange: 0, area: 0, castTime: 0,
  data: new Array(9).fill(NaN), dataStr: new Array(9).fill(""), buffs: [], summon: "",
});

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
  /** The REVERSE direction's button, for the abilities that are one row wearing two faces:
   *  `Unart`/`Unbuttonpos`/`Unhotkey`/`Untip`/`Unubertip` beside the plain ones. Every
   *  Order/Unorder pair carries them (`[Aroo]` Order=root Art=BTNRoot Tip="Root" against
   *  Unorder=unroot Unart=BTNUproot Untip="Uproot"), as does every autocast toggle
   *  (Renew's WispHealOn/Off). The plain half is what the ability can DO next, so a rooted
   *  Ancient — whose next move is to pull itself up — wears the `un` half.
   *
   *  Empty strings / -1 when the row names none, which is the overwhelming majority. */
  unIcon: string;
  unHotkey: string;
  unTip: string;
  unUberTip: string;
  unButtonX: number;
  unButtonY: number;
  levelData: AbilityLevel[]; // index 0 = rank 1
  // Effect model paths (from AbilityFunc) — the renderer plays these on cast.
  missileArt: string; // travelling projectile (Storm Bolt hammer, Death Coil orb)
  /** `Missilespeed` — how fast that projectile flies, in world units a second. Real data
   *  (Shock Wave 1050, Carrion Swarm 1100, Breath of Fire 1050), and it MATTERS for the
   *  wave spells: their missile is the spell, so its speed is how long the line takes to
   *  sweep and therefore when each unit along it is struck. 0 when the row names none. */
  missileSpeed: number;
  targetArt: string; // effect attached to the target (Holy Light burst, Heal); for an
  //                    aura this is the BIG model shown under its OWNER only.
  /** `Targetattach` — the attachment point `targetArt` rides, in the same token form as a
   *  buff's (see BuffFx.attach). Almost every ability leaves it empty, because its target
   *  art is a one-shot burst at the victim's feet. The ORBS are what it exists for here:
   *  `[AIfb] Targetattach = weapon` hangs the fire orb on the carrier's weapon hand, and
   *  those models are loops rather than bursts (src/sim/orbs.ts, World.orbAttachments). */
  targetAttach: string[];
  casterArt: string; // effect attached to the caster (Thunder Clap ring)
  specialArt: string; // extra one-shot effect (Flame Strike's erupting fire pillar)
  /** `Specialattach` — where `specialArt` rides, in the same token form as `targetAttach`.
   *  Eat Tree hangs its sprite on the Ancient's own `eattree` bone; most rows name nothing
   *  and the model simply sits at the unit's origin. */
  specialAttach: string[];
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
  /** AbilityFunc `Effectsoundlooped` — the LABEL of the bed that plays for as long as the
   *  ability's effect runs (`[ANst] Effectsoundlooped = StampedeLoop`, `[AUls]` →
   *  LocustSwarmLoop). The channelled FIELDS mostly carry theirs on their effect object
   *  instead (see fxLoopSound); these two carry it on the ability itself. */
  effectSoundLooped: string;
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
  /** The `EfctID1` column's own `[X….]` section in AbilityFunc — the EFFECT OBJECT, a
   *  third art carrier alongside the ability and its buff, and the one an area FIELD's
   *  art actually lives on. Six of the fields are Blizzard's own: `[AHbz] EfctID1 = XHbz`,
   *  and `[XHbz]` is where `BlizzardTarget.mdl` and `Effectsoundlooped=BlizzardLoop` sit.
   *  The ability row itself names no art at all for any of them, which is why Tranquility,
   *  Earthquake and Death and Decay used to land in silence with nothing on the ground.
   *
   *    [XEtq]  Effectart = …\Tranquility\Tranquility.mdl   Effectsoundlooped = TranquilityLoop
   *    [XOeq]  Effectart = …\EarthQuake\EarthQuakeTarget.mdl  Effectsoundlooped = EarthquakeLoop
   *    [XUdd]  Effectart = …\DeathandDecay\DeathandDecayTarget.mdl
   *    [XNhs]  Specialart = …\Human\Heal\HealTarget.mdl     (Healing Spray's per-target burst)
   *
   *  `fxLoopSound`/`fxSound` are AbilitySounds.slk LABELS, like `effectSound` — not paths. */
  fxArt: string; // the effect object's Effectart — the field/area model
  fxSpecialArt: string; // its Specialart — the per-target burst (Healing Spray)
  fxMissileArt: string; // its Missileart (Volcano's rising rock)
  fxLoopSound: string; // Effectsoundlooped — the bed under a running field
  fxSound: string; // Effectsound — the one-shot per wave (BlizzardWave)
  /** AbilityFunc `LightningEffect` — the LightningData row ids this ability strings between
   *  its caster and its targets (`CLPB,CLSB` for Chain Lightning, `DRAB,DRAL,DRAM` for the
   *  Drains). These are NOT models: a lightning is a ribbon linking two moving points, drawn
   *  by src/render/lightningOverlay.ts off `Splats\LightningData.slk` (src/data/lightning.ts).
   *  Order matters — the primary bolt (caster → first target) comes first, the secondary
   *  (target → target) second; the Drain's three are life+mana, life, mana in that order. */
  lightning: string[];
  animNames: string[]; // caster animation tags (AbilityFunc "animnames": spell,throw,slam…)
  // The ability's ORDER STRING (AbilityFunc `Order=holybolt`, and `Orderon`/`Orderoff`
  // for an autocast toggle). This is the name a script casts it by: the GUI's "Unit -
  // Order <unit> to <ability>" compiles to IssueTargetOrder(u, "holybolt", target), so
  // without it a trigger can't make a unit cast anything (7.17).
  order: string;
  orderOn: string; // autocast on (Orderon)
  orderOff: string; // autocast off (Orderoff)
}

/**
 * Point-target spells that arm with NO `SpellAreaOfEffect` circle under the cursor.
 *
 * The circle answers one question — *which units will this catch if I click here* — so
 * WC3 draws it for a spell whose `Area` is a radius of EFFECT ON UNITS centred on the
 * clicked point (Blizzard, Flame Strike, Rain of Fire) and for nothing else. Two shapes
 * carry an `Area` that is not that, and get a bare cursor in the real client:
 *
 *  1. **A directional wave.** The line/cone leaves the CASTER and travels toward the
 *     click, so `Area` is its WIDTH where it starts, not a radius at the cursor — the
 *     click only picks a direction. The family is readable straight off
 *     `Units\AbilityMetaData.slk`: abilities sharing a hardcoded implementation share a
 *     `useSpecific` group for their Data fields, and the three wave groups are exactly
 *     `Osh1..4` (AOsh,ACsh,ACst), `Ucs1..4` (AUcs,ANbf,ACbc,ACbf,ACca,ACcv) and `Uim1..4`
 *     (AUim,ACmp). `AbilityData.slk` agrees: Carrion Swarm reads `Area1`=100 as its START
 *     width and `DataD1`=300 as its end width, `DataC1`=800 out from the caster.
 *  2. **An area that touches no units at all.** Far Sight's `Area1`=900 is a REVEAL
 *     radius — "Reveals the area of the map that it is cast upon for <Dur1> seconds"
 *     (`OrcAbilityStrings [AOfs]`), and its `targs1` is `_` because there is nothing to
 *     target. Nothing gets caught, so there is nothing to preview.
 *
 * Not in here, and worth saying why: Forked Lightning shares Carrion Swarm's `Ucs3`/`Ucs4`
 * cone fields but is cast on a UNIT, so it never arms a point in the first place.
 */
export const NO_AOE_CURSOR = new Set<string>([
  // 1 — directional waves
  "AOsh", "ACsh", "ACst", // Shockwave, and the creep/trap variants
  "AUcs", "ACca", // Carrion Swarm (+ creep)
  "ANbf", "ACbc", "ACbf", "ACcv", // Breath of Fire/Frost, Crushing Wave
  "AUim", "ACmp", // Impale (+ creep)
  // 2 — an Area that is not an effect on units
  "AOfs", // Far Sight — `Area1` is the radius of map it reveals
]);

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
  // Mass Teleport — cast on a UNIT, not a spot: "Teleports <DataA1> of the player's nearby
  // units, including the Archmage, to a friendly ground unit or structure"
  // (`HumanAbilityStrings [AHmt]`), and its Func says the same from the other side —
  // "// The targeted unit shouldn't show an effect, so there is no Targetart." Its
  // `Rng1`=99999 + `Area1`=800 read as a point spell in the tables; the tables cannot tell.
  // (`Area1` is the radius around the CASTER that comes along, not anything at the target.)
  AHmt: { target: "unit" },
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
  // Animate Dead is the same corpse-eating family (`targs1 = air,ground,dead`) and is cast
  // the same way: pressed, then it sweeps `Area1` = 900 around the Death Knight for bodies.
  AUan: { target: "none" }, // Animate Dead — temporarily raise nearby corpses
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
  // Carrion Beetles' `targs1` is the single flag `dead`: it eats a CORPSE, and the Crypt Lord
  // finds his own inside `Rng1` = 900 the moment the button is pressed. Nothing to aim.
  AUcb: { target: "none" }, // Carrion Beetles — raise a beetle from the nearest corpse
  AUls: { target: "none" }, // Locust Swarm — self PBAoE life-drain field
  // === Night Elf heroes ===
  // -- Keeper of the Grove --
  AEer: { target: "unit" }, // Entangling Roots — root + DoT
  AEfn: { target: "point" }, // Force of Nature — turn the TREES at a point into treants
  AEah: { target: "passive" }, // Thorns Aura — return melee damage
  // Tranquility takes no target at all: `Rng1` is literally "-" in AbilityData.slk (no cast
  // range = nothing to aim at), and the rain falls on `Area1` = 900 around the Keeper. The
  // tooltip agrees — "Causes rains of healing energy to pour down in a large area" names no
  // target — and so does the button in the real game, which fires on the click.
  AEtq: { target: "none" }, // Tranquility — channelled heal field, centred on the caster
  // -- Priestess of the Moon --
  AHfa: { target: "unit", autocast: true }, // Searing Arrows — bonus fire damage on attack
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
  // Vengeance is not a passive — it SUMMONS: "Creates a powerful avatar that summons
  // invulnerable spirits from nearby corpses" (Ubertip), i.e. `Esv1` = 1 of `UnitID1 = espv`
  // (the Avatar of Vengeance) for `Dur1` = 180s. Filed as a passive it had no target type,
  // so the button could issue no order and the Warden's ultimate simply did nothing.
  AEsv: { target: "none" }, // Vengeance — summon the Avatar of Vengeance
  // === Neutral heroes ===
  // -- Naga Sea Witch --
  // Forked Lightning — a cone of bolts, but AIMED AT A UNIT: "Calls forth a cone of
  // lightning on a target enemy unit" (`NeutralAbilityStrings [ANfl]` Ubertip, level 1).
  // Its `Rng1`=600 + `Area1`=125 make it look like a point spell in the tables; they can't
  // tell the two apart, and the tooltip is the only thing in the data that can.
  ANfl: { target: "unit" },
  AHca: { target: "unit", autocast: true }, // Cold / Frost Arrows — slow on attack
  ANms: { target: "none" }, // Mana Shield — absorb damage into mana (toggle)
  ANto: { target: "point" }, // Tornado — summon a tornado
  // -- Dark Ranger --
  ANsi: { target: "point" }, // Silence — area silence
  ANba: { target: "unit", autocast: true }, // Black Arrow — bonus damage on attack
  ANch: { target: "unit" }, // Charm — take control of a target
  // -- Pandaren Brewmaster --
  ANbf: { target: "point" }, // Breath of Fire — line nuke
  // Drunken Haze is thrown AT A UNIT and splashes: `targs1 = air,ground,enemy,organic,neutral`
  // with `Rng1` = 550, and its `Area1` = 200 is the spill around whoever it lands on — the
  // same shape as the Alchemist's Acid Bomb, which is the other half of the same throw. The
  // tooltip's "Drenches enemy units" is about the splash, not about aiming at the ground.
  ANdh: { target: "unit" }, // Drunken Haze — flask at a unit; slow + miss chance, splashed
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
  ANia: { target: "unit", autocast: true }, // Incinerate — bonus fire damage on attack
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
  // === ITEM abilities that must be AIMED ===
  // An item's behaviour is dispatched off its ability `code` in world.ts useItem, and most
  // item actives need no aiming at all (a potion drinks itself), so they stay out of this
  // table and load as "passive" — which is what makes the HUD fire them on the click. The
  // ones listed here are the ones the player has to point at something: without a row the
  // inventory button would fire them instantly at nothing.
  //
  // The STAVES (docs: Liquipedia Staff_of_Preservation / Staff_of_Sanctuary). Both take a
  // unit — `targs1 = ground,air,vuln,invu,player,neutral`, Rng1 700 — and send it home.
  ANpr: { target: "unit" }, // Staff of Preservation (`spre`) — teleport a unit to its own base
  ANsa: { target: "unit" }, // Staff of Sanctuary (`ssan`) — the same, plus a stun + heal-over-time
  // === ORB EFFECTS the unit TYPE carries (src/sim/orbs.ts) ===
  // Attack modifiers, not casts: each rides the unit's own blows and competes with every
  // other orb for the one slot a blow has (see the priority ladder in orbs.ts). Listed here
  // for the same reason the passive derivations above are — a code this table omits is a
  // code no unit ever carries, so leaving one out silently switches the effect off for the
  // whole game rather than merely hiding a button.
  Aspo: { target: "passive" }, // Slow Poison — Dryad (`edry`), Hydra, Snap Dragon; `AIsz` is the item twin
  Aven: { target: "passive" }, // Envenomed Spears — Wind Rider (`owyv`, gated on `Rovs`); `ACvs` on creeps
  Apoi: { target: "passive" }, // Poison Sting; `Apo2` is Orb of Venom's half of the same effect
  Afbk: { target: "passive" }, // Feedback — Spell Breaker (`hspt`), Arcane Tower (`Afbt`, `hatw`)
  Afra: { target: "passive" }, // Frost Attack — Nerubian Tower, Halls of the Dead / Black Citadel
  Afrb: { target: "passive" }, // Frost Attack (long) — Frost Wyrm (`ufro`), the Blue Dragons
  Afak: { target: "unit", autocast: true }, // Orb of Annihilation — Destroyer (`ubsp`), 25 mana a shot
  AEpa: { target: "unit", autocast: true }, // Poison Arrows — the arrow-shaped poison
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
  // Entangle Gold Mine (`Order=entangle`) — the Tree of Life's. targs1 is literally `_`: it
  // takes NO target, and the mine it wraps is whichever un-entangled one is inside Rng1=500.
  // What it creates is named on the row itself (UnitID1 = egol). See SimWorld.entangleMine.
  Aent: { target: "none" },
  // Replenish Mana and Life — the Moon Well pouring its own mana into a friendly organic unit
  // (`Order=replenish`, Orderon/Orderoff make it autocast). See SimWorld.tickReplenish.
  Ambt: { target: "unit", autocast: true },
  // Detonate (`Order=detonate`) — the Wisp destroys itself, dispelling and burning mana in
  // Area1. No target: it goes off where the wisp is standing.
  Adtn: { target: "none" },
  // Eat Tree (`Order=eattree`) — an Ancient consumes a tree for a 500-hp heal over 30s.
  // Aimed at a POINT rather than at the tree itself: a tree is not a unit here, so the
  // handler takes the nearest one to the click that the Ancient can reach.
  Aeat: { target: "point" },
  // REPAIR, all four of it. It is one ability wearing four skins, and unusually the skins
  // are separate BASE CODES rather than aliases of one: `Arep` (Repair — the human `Ahrp`
  // derives from it, and the orc row IS it), `Arst` (Restoration, undead) and `Aren` (Renew,
  // night elf). All three carry the same two numbers, Rep1 "Repair Cost Ratio" 0.35 and Rep2
  // "Repair Time Ratio" 1.5 — a third of the building's price over half again its build time
  // (Liquipedia lists both on Renew's own card) — so a wisp mends at exactly a peasant's rate.
  //
  // Listing them here is what gives each race's worker its OWN button: the row's art, its
  // Buttonpos 1,1 and the autocast toggle its `Orderon`/`Orderoff` promise, in place of the
  // one hand-rolled Repair button they all used to share.
  //
  // They are NOT dispatched as spells. Repair is a JOB — it runs for as long as the building
  // is hurt and the owner can pay — so `ability:<code>` arms the ordinary repair order
  // (mapViewer.runCommand) and the autocast is ticked by SimWorld.tickRenew.
  //
  // What makes Renew the night elf one is its Targets Allowed: `Arep`/`Ahrp`/`Arst` all list
  // `nonancient` and `Aren` does not, so only a Wisp may mend an Ancient (repairRefusal).
  Arep: { target: "unit", autocast: true },
  Arst: { target: "unit", autocast: true },
  Aren: { target: "unit", autocast: true },
  // Call to Arms — the Human militia. `Amil` is the Peasant's own form toggle
  // (`Order=militia` / `Unorder=militiaoff`); `Amic` is the town bell on the hall
  // (`townbellon` / `townbelloff`) that rings for every Peasant within 2000. Both self-cast.
  Amil: { target: "none" },
  Amic: { target: "none" },
  // Burrow — the Crypt Fiend digs in (`Order=burrow` / `Unorder=unburrow`). A form toggle
  // between the two units the ability names; Abu2/Abu3/Abu5 alias it for the scarabs and the
  // Barbed Arachnathid. See the handler for why its sibling morphs are not listed here yet.
  Abur: { target: "none" },
  // The three REGENERATION auras — and the two Fountains, which are nothing else. A Fountain
  // of Health's whole ability list is `Avul,ACnr` and a Fountain of Mana's `Avul,ANre`
  // (Units\UnitAbilities.slk); those rows' base codes are `Aoar` and `Aarm`, which are also
  // the Witch Doctor's Healing Ward and the Marketplace statue's aura. Listed here because
  // `buildInitialAbilities` keeps only what this table names, and an aura a unit does not
  // carry is an aura nothing applies — which is exactly why the fountains did nothing.
  Aoar: { target: "passive" }, // Regeneration aura, life (Fountain of Health `ACnr`, Healing Ward)
  Aabr: { target: "passive" }, // Regeneration aura, life (the Marketplace statue) — 0.4% / 700
  Aarm: { target: "passive" }, // Regeneration aura, mana (Fountain of Mana `ANre`)
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
    /** Every `[B….]` buff section, by buff id — its icon, name, tooltip and persistent
     *  models. `AbilityDef.buffFx` is only buffid1's, which is right for the many abilities
     *  that apply one buff — but an ability may list SEVERAL and choose between them at cast
     *  time off its own numbers. The regeneration items are the clear case: `BIrg,BIrl,BIrm`
     *  is life-and-mana, life, mana, and which one a Healing Salve wears depends on whether
     *  DataB is 0. */
    private buffs = new Map<string, BuffDef>(),
  ) {}
  /** The persistent models a given buff id hangs on its holder ([] if unknown). */
  buffFx(buffId: string): BuffFx[] {
    return this.buff(buffId)?.fx ?? [];
  }
  /** A buff's own row — icon/name/tooltip for the info panel's Status row.
   *
   *  Looked up CASE-INSENSITIVELY, because Blizzard's own data does not agree with itself:
   *  `AbilityData.slk` sends Unholy Frenzy to `BUhf` and Frost Nova's stun to `Bust`, while
   *  the sections that define them are `[Buhf]` and `[BUst]`. Two rows out of 194, and an
   *  exact match loses both — Unholy Frenzy's icon among them. */
  buff(buffId: string): BuffDef | undefined {
    return buffId ? this.buffs.get(buffId.toLowerCase()) : undefined;
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
    const [ux, uy] = f && str(f, "unbuttonpos") ? parseButtonPos(str(f, "unbuttonpos")) : [bx, by];
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
      unIcon: f ? str(f, "Unart") : "",
      unHotkey: (s ? (str(s, "Unhotkey").trim()[0] ?? "") : "").toUpperCase(),
      unTip: rawTip(s ? str(s, "Untip") : ""),
      unUberTip: rawTip(s ? str(s, "Unubertip") : ""),
      unButtonX: ux,
      unButtonY: uy,
      levelData,
      missileArt: mdlPath(f ? str(f, "Missileart") : ""),
      missileSpeed: f ? Number(str(f, "Missilespeed")) || 0 : 0,
      targetArt: mdlPath(f ? str(f, "TargetArt") : ""),
      targetAttach: (f ? str(f, "Targetattach") : "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
      casterArt: mdlPath(f ? str(f, "Casterart") : ""),
      specialArt: mdlPath(f ? str(f, "SpecialArt") : ""),
      specialAttach: (f ? str(f, "Specialattach") : "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
      effectArt: mdlPath(f ? str(f, "Effectart") : ""),
      areaArt: mdlPath(f ? str(f, "Areaeffectart") : ""),
      effectSound: f ? str(f, "Effectsound") : "", // a SLK label, NOT a path — no mdlPath here
      effectSoundLooped: f ? str(f, "Effectsoundlooped") : "", // ditto — a label
      // The persistent buff model lives on the BUFF, not the ability: resolve
      // buffid1's own [B….] func section TargetArt (Banish → BanishTarget, an aura →
      // GeneralAuraTarget, Flame Strike → FlameStrikeDamageTarget). Verified 2026-07
      // against the 1.27 MPQ (docs/wc3-data-formats.md).
      buffFx: buffFx,
      buffArt: buffFx[0]?.path ?? "",
      buffEffectArt: mdlPath(buffField(func, str(r, "buffid1"), "Effectart")),
      buffSpecialArt: mdlPath(buffField(func, str(r, "buffid1"), "Specialart")),
      // …and the EFFECT OBJECT the `EfctID1` column names (see AbilityDef.fxArt) — read
      // from the same AbilityFunc file through the same helper the buff uses.
      fxArt: mdlPath(buffField(func, str(r, "efctid1"), "Effectart")),
      fxSpecialArt: mdlPath(buffField(func, str(r, "efctid1"), "Specialart")),
      fxMissileArt: mdlPath(buffField(func, str(r, "efctid1"), "Missileart")),
      fxLoopSound: buffField(func, str(r, "efctid1"), "Effectsoundlooped"), // a LABEL, not a path
      fxSound: buffField(func, str(r, "efctid1"), "Effectsound"),
      lightning: (f ? str(f, "LightningEffect") : "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
      animNames: (f ? str(f, "animnames") : "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      // Order strings (AbilityFunc `Order`/`Orderon`/`Orderoff`) — how a trigger casts it.
      order: (f ? str(f, "Order") : "").trim().toLowerCase(),
      orderOn: (f ? str(f, "Orderon") : "").trim().toLowerCase(),
      orderOff: (f ? str(f, "Orderoff") : "").trim().toLowerCase(),
    });
  }
  for (const id of UI_BUTTON_IDS) addUiButton(defs, id, func, strs);
  // Index every buff section — its models (so an ability that lists several buffs can pick
  // the one its numbers call for) AND its icon/name/tooltip (the info panel's Status row).
  //
  // Buff ids are the `B….` space, but that is not the whole test: a `BuffID` column may name
  // something outside it, and Tranquility's does — `AEtq` lists `AEtr`, an ABILITY row, as its
  // buff. So every id the ability table actually points at is indexed too, or that buff has no
  // row and the panel falls back to art the game never shows there.
  //
  // A buff that hangs no model has no `[…]` section in AbilityFunc at all — the STRINGS file
  // still names it — which is why both files are consulted. Keys are lower-cased: see
  // AbilityRegistry.buff for the two rows whose case the data gets wrong.
  const referenced = new Set<string>();
  for (const def of defs.values()) for (const lvl of def.levelData) for (const b of lvl.buffs) referenced.add(b);
  const buffs = new Map<string, BuffDef>();
  for (const id of new Set([...Object.keys(func.map), ...Object.keys(strs.map)])) {
    if (id[0] !== "B" && !referenced.has(id)) continue;
    const f = func.getRow(id) as Row | undefined;
    const s = strs.getRow(id) as Row | undefined;
    if (!f && !s) continue;
    buffs.set(id.toLowerCase(), {
      id,
      icon: f ? str(f, "Buffart") : "",
      name: rawTip(s ? str(s, "Bufftip") : "") || id,
      tip: rawTip(s ? str(s, "Buffubertip") : ""),
      fx: buffFxOf(func, id),
    });
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
    unIcon: "",
    unHotkey: "",
    unTip: "",
    unUberTip: "",
    unButtonX: bx,
    unButtonY: by,
    levelData: [],
    missileArt: "",
    missileSpeed: 0,
    targetArt: "",
    targetAttach: [],
    casterArt: "",
    specialArt: "",
    specialAttach: [],
    effectArt: "",
    areaArt: "",
    effectSound: "",
    effectSoundLooped: "",
    buffFx: [],
    buffArt: "",
    buffEffectArt: "",
    buffSpecialArt: "",
    fxArt: "",
    fxSpecialArt: "",
    fxMissileArt: "",
    fxLoopSound: "",
    fxSound: "",
    lightning: [],
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
