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
  hotkey: string; // cast/learn hotkey letter
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
  buffArt: string; // TargetArt of this ability's primary buff (buffid1): the PERSISTENT
  //                  model worn by a buffed unit — Banish's ethereal glow, the small
  //                  per-unit aura swirl (GeneralAuraTarget), Flame Strike's burn.
  animNames: string[]; // caster animation tags (AbilityFunc "animnames": spell,throw,slam…)
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
};

interface Row {
  string(key: string): string | undefined;
}

export class AbilityRegistry {
  constructor(private defs: Map<string, AbilityDef>) {}
  get(id: string): AbilityDef | undefined {
    return this.defs.get(id);
  }
  has(id: string): boolean {
    return this.defs.has(id);
  }
  get size(): number {
    return this.defs.size;
  }
  all(): AbilityDef[] {
    return [...this.defs.values()];
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
      // The persistent buff model lives on the BUFF, not the ability: resolve
      // buffid1's own [B….] func section TargetArt (Banish → BanishTarget, an aura →
      // GeneralAuraTarget, Flame Strike → FlameStrikeDamageTarget). Verified 2026-07
      // against the 1.27 MPQ (docs/wc3-data-formats.md).
      buffArt: mdlPath(buffTargetArt(func, str(r, "buffid1"))),
      animNames: (f ? str(f, "animnames") : "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    });
  }
  return new AbilityRegistry(defs);
}

/** Value of a tooltip-referenced field on a level (`DataA1`, `Dur1`, `Cost1`, …).
 *  The trailing level digit is ignored — we read the field for the shown rank. */
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

/** A buff's own persistent TargetArt, read from its `[B….]` section in the same
 *  AbilityFunc files (buffs live alongside abilities there). `buffId` may be a
 *  comma-list (multi-buff abilities); we take the first. "" if absent. */
function buffTargetArt(func: MappedData, buffId: string): string {
  const first = (buffId || "").split(",")[0]?.trim();
  if (!first) return "";
  const row = func.getRow(first) as Row | undefined;
  return row ? str(row, "Targetart") : "";
}

// Effect-art fields are ".mdl" model paths (comma-lists sometimes). Take the
// first, normalise to the compiled ".mdx" the MPQ actually ships.
function mdlPath(v: string): string {
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
