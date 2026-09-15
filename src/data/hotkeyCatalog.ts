import { MappedData } from "mdx-m3-viewer/dist/cjs/utils/mappeddata";
import type { DataSource } from "../vfs/types";
import { readIni, splitList, type IniSection } from "./customKeysDoc";
import { parseWar3Skins, skinValue, WAR3SKINS } from "./war3skins";

// What the hotkey editor lists (issue #156): every command card a player can meet, read out of
// the install rather than written down here.
//
// The editor is Options → Gameplay → "Hotkeys:" → Custom's own screen, and its job is the one
// the community's hotkey generators do (the issue links jcfields' warcraft3-hotkey-editor): pick
// a unit, see its card, rebind a button. Those tools ship a hand-made list of units and buttons.
// This one reads it, from the same tables the command card is built from, so a button is on the
// editor's card exactly because the data puts it on the game's:
//
//   · a unit's ABILITIES are `UnitAbilities.slk` `abilList`, a hero's learnable ones
//     `heroAbilList` — on the main card at `Buttonpos`, and on the learn card at
//     `Researchbuttonpos` under `Researchhotkey`/`Researchtip`;
//   · a building's PRODUCTION is its `*UnitFunc.txt` row — `Trains`, `Researches`, `Upgrade`,
//     `Makeitems`, and a neutral shop's `Sellunits`/`Sellitems` — and each of those buttons is
//     the TRAINED THING's section (`[hfoo] Hotkey=F` is the Barracks' Footman button);
//   · a worker's `Builds` are a second card behind `[CmdBuild<Race>]`;
//   · the engine's own buttons (Move, Stop, Hold Position, Attack, Patrol, Rally, Hero Abilities,
//     Cancel) are `[Cmd*]` sections with no object row, positioned by `Units\CommandFunc.txt`
//     and worded by `Units\CommandStrings.txt` — the half of a CustomKeys.txt that moves most.
//
// Which units: `UnitUI.slk` `special` = 0, `campaign` = 0 and `inEditor` = 1 — the melee roster
// the World Editor's unit palette shows — plus the handful of FORMS a melee unit turns into
// (`MORPHS`), whose cards the player also presses and which the editor flags as special.
//
// Nothing here applies anything. The DEFAULT a button shows is the install's own value, and what
// the player's file changes is the document's business (customKeysDoc.ts).

/** The five groups the editor's race tabs show. Neutral is the tavern and the shops. */
export type CatalogRace = "human" | "orc" | "nightelf" | "undead" | "neutral";
export const CATALOG_RACES: readonly CatalogRace[] = ["human", "orc", "nightelf", "undead", "neutral"];

export type CatalogGroup = "hero" | "unit" | "building" | "special";

/**
 * Which state of a section a button speaks for — the three families `CustomKeyInfo.txt` names
 * each field in: `Hotkey`/`Buttonpos`/`Tip`, their `Un*` twins (the button an ACTIVE toggle wears:
 * Stop Defend), and their `Research*` twins (the hero's learn card).
 */
export type KeyVariant = "" | "un" | "research";

export const hotkeyField = (v: KeyVariant): string => `${v}hotkey`;
export const posField = (v: KeyVariant): string => `${v}buttonpos`;
export const tipField = (v: KeyVariant): string => `${v}tip`;

/** One button on one card. */
export interface CatalogButton {
  /** The section a CustomKeys.txt names it by, in the install's own spelling. */
  section: string;
  variant: KeyVariant;
  /** Plain name — `Name`, or for an engine button its Tip with the gilding taken off. */
  name: string;
  /** BLP path of its icon. */
  icon: string;
  /** Its twin toggle state's icon, when the section has one (`Unart`). */
  unIcon?: string;
  /** The card this button opens (Build Structure, Hero Abilities). */
  opens?: CatalogCard["id"];
}

export interface CatalogCard {
  id: "main" | "build" | "learn";
  buttons: CatalogButton[];
}

export interface CatalogUnit {
  id: string;
  name: string;
  icon: string;
  race: CatalogRace;
  group: CatalogGroup;
  cards: CatalogCard[];
}

const UNIT_STRINGS = ["Human", "Orc", "Undead", "NightElf", "Neutral", "Campaign"].map((r) => `Units\\${r}UnitStrings.txt`);
const UNIT_FUNCS = UNIT_STRINGS.map((p) => p.replace("Strings", "Func"));
const ABILITY_STRINGS = ["Human", "Orc", "Undead", "NightElf", "Neutral", "Common", "Item", "Campaign"].map((r) => `Units\\${r}AbilityStrings.txt`);
const ABILITY_FUNCS = ABILITY_STRINGS.map((p) => p.replace("Strings", "Func"));
const UPGRADE_STRINGS = ["Human", "Orc", "Undead", "NightElf", "Neutral", "Campaign"].map((r) => `Units\\${r}UpgradeStrings.txt`);
const UPGRADE_FUNCS = UPGRADE_STRINGS.map((p) => p.replace("Strings", "Func"));
const OTHER_TABLES = ["Units\\ItemStrings.txt", "Units\\ItemFunc.txt", "Units\\CommandStrings.txt", "Units\\CommandFunc.txt"];

/** The melee FORMS: not on the editor palette (`special` = 1), but a card the player presses. */
const MORPHS: Record<string, CatalogRace> = {
  ubsp: "undead", // Destroyer (Obsidian Statue's Destroyer Form)
  edcm: "nightelf", // Druid of the Claw, Bear Form
  edtm: "nightelf", // Druid of the Talon, Storm Crow Form
};

/** The neutral buildings a melee player shops at, in the World Editor's own order. */
const NEUTRAL_SHOPS = ["ntav", "ngme", "ngad", "nmrk", "nshp", "nmer"];

/** `UnitData.slk` race → the tab. `creeps`/`other` are only listed when they are a shop or a
 *  tavern hero — everything else under them is a creep, and a creep takes no orders. */
const RACE_OF: Record<string, CatalogRace> = { human: "human", orc: "orc", nightelf: "nightelf", undead: "undead" };

/** `UI\war3skins.txt` section for a race's own art (the Orc rally flag, the undead Build). */
const SKIN: Record<CatalogRace, string> = { human: "Human", orc: "Orc", nightelf: "NightElf", undead: "Undead", neutral: "Default" };

const BUILD_CMD: Record<CatalogRace, string> = {
  human: "CmdBuildHuman", orc: "CmdBuildOrc", nightelf: "CmdBuildNightElf", undead: "CmdBuildUndead", neutral: "CmdBuild",
};

const decode = (bytes: Uint8Array): string => new TextDecoder("windows-1252").decode(bytes);

/** Strip WC3 colour markup, for a name built out of a Tip. */
export const plainTip = (s: string): string => s.replace(/\|c[0-9a-f]{8}/gi, "").replace(/\|r/gi, "");

/** Absent, blank or one of the SLKs' "nothing" markers. */
const blank = (v: string | undefined): boolean => !v || v === "_" || v === "-" || v === "";

export class HotkeyCatalog {
  readonly units: CatalogUnit[] = [];
  /** Every string and func table merged: section (lower-cased) → its RAW fields. The install's
   *  own values, which is what a button shows when the player's file does not name it. */
  readonly defaults: Map<string, IniSection>;
  private readonly skins: Map<string, Map<string, string>>;
  /** section (lower-cased) → the units whose cards carry it, for "also on …". */
  private readonly users = new Map<string, CatalogUnit[]>();

  constructor(private readonly vfs: DataSource) {
    this.defaults = new Map();
    for (const path of [...UNIT_STRINGS, ...UNIT_FUNCS, ...ABILITY_STRINGS, ...ABILITY_FUNCS, ...UPGRADE_STRINGS, ...UPGRADE_FUNCS, ...OTHER_TABLES]) {
      const bytes = vfs.rawBytes(path);
      if (bytes) readIni(decode(bytes), this.defaults);
    }
    const skinBytes = vfs.rawBytes(WAR3SKINS);
    this.skins = skinBytes ? parseWar3Skins(new TextDecoder("latin1").decode(skinBytes)) : new Map();
    this.build();
  }

  /** The install's value for one field of one section, raw. */
  default(section: string, field: string): string | undefined {
    return this.defaults.get(section.toLowerCase())?.fields.get(field);
  }

  /** How many entries a section's hotkey carries — one per LEVEL for an upgrade (`Hotkey=S,S,S`). */
  levels(section: string, variant: KeyVariant): number {
    const raw = this.default(section, hotkeyField(variant));
    return raw ? Math.max(1, splitList(raw).length) : 1;
  }

  /** The other units a section's button appears on. */
  usedBy(section: string): CatalogUnit[] {
    return this.users.get(section.toLowerCase()) ?? [];
  }

  private field(section: string, field: string): string {
    return this.default(section, field) ?? "";
  }

  /** An SLK as id → lower-cased column → value. MappedData's SLK half is the right reader here
   *  (it is only its INI half that loses quotes — see customKeysDoc.ts). */
  private slk(path: string): Map<string, Record<string, string>> {
    const out = new Map<string, Record<string, string>>();
    const bytes = this.vfs.rawBytes(path);
    if (!bytes) return out;
    for (const [id, row] of Object.entries(new MappedData(decode(bytes)).map)) {
      out.set(id, (row as { map: Record<string, string> }).map);
    }
    return out;
  }

  private build(): void {
    const data = this.slk("Units\\UnitData.slk");
    const ui = this.slk("Units\\UnitUI.slk");
    const balance = this.slk("Units\\UnitBalance.slk");
    const weapons = this.slk("Units\\UnitWeapons.slk");
    const abilities = this.slk("Units\\UnitAbilities.slk");

    const listed: { id: string; race: CatalogRace; special: boolean }[] = [];
    for (const [id, u] of ui) {
      const d = data.get(id);
      if (!d) continue;
      if (MORPHS[id]) { listed.push({ id, race: MORPHS[id], special: true }); continue; }
      if (u.special !== "0" || u.campaign !== "0" || u.ineditor !== "1") continue;
      const race = RACE_OF[d.race];
      const isHero = !blank(balance.get(id)?.primary);
      if (race) listed.push({ id, race, special: false });
      else if (d.race === "creeps" && isHero) listed.push({ id, race: "neutral", special: false }); // the tavern's eight
    }
    for (const id of NEUTRAL_SHOPS) if (ui.has(id)) listed.push({ id, race: "neutral", special: false });
    // …and what the neutral shops sell that takes orders: the Goblin Laboratory's three and the
    // Shipyard's transport. The Mercenary Camp's stock are creeps, already under their camps.
    for (const shop of ["ngad", "nshp"]) {
      for (const id of this.list(shop, "sellunits")) if (ui.has(id)) listed.push({ id, race: "neutral", special: false });
    }

    for (const { id, race, special } of listed) {
      const b = balance.get(id);
      const d = data.get(id);
      const isHero = !blank(b?.primary);
      const isBuilding = b?.isbldg === "1";
      const group: CatalogGroup = special ? "special" : isHero ? "hero" : isBuilding ? "building" : "unit";
      const unit: CatalogUnit = {
        id,
        name: this.field(id, "name") || id,
        icon: this.field(id, "art"),
        race,
        group,
        cards: [],
      };
      const main: CatalogButton[] = [];
      const cmd = (section: string, opens?: CatalogCard["id"]): void => {
        const art = this.field(section, "art");
        const icon = skinValue(this.skins, SKIN[race], art) ?? art;
        main.push({ section: this.canonical(section), variant: "", name: plainTip(this.field(section, "tip")) || section, icon, opens });
      };

      const moves = !isBuilding && !blank(d?.movetp);
      const weaps = weapons.get(id);
      const attacks = !!weaps && Number(weaps.weapson) > 0;
      if (moves) {
        cmd("CmdMove");
        cmd("CmdStop");
        cmd("CmdHoldPos");
        if (attacks) cmd("CmdAttack");
        cmd("CmdPatrol");
        if (attacks && /^(artillery|aline)$/i.test(weaps?.weaptp1 ?? "")) cmd("CmdAttackGround");
      } else if (attacks) {
        cmd("CmdAttack");
        cmd("CmdStop");
      }

      const builds = this.list(id, "builds");
      if (builds.length) {
        cmd(BUILD_CMD[race], "build");
        unit.cards.push({
          id: "build",
          buttons: [...builds.map((b2) => this.objectButton(b2)).filter(isButton), this.cancel()],
        });
      }
      const heroAbils = splitList(abilities.get(id)?.heroabillist ?? "").map((s) => s.trim()).filter((s) => !blank(s));
      if (isHero) {
        cmd("CmdSelectSkill", "learn");
        unit.cards.push({
          id: "learn",
          buttons: [...heroAbils.map((a) => this.objectButton(a, "research")).filter(isButton), this.cancel()],
        });
      }

      for (const a of splitList(abilities.get(id)?.abillist ?? "")) {
        const btn = this.objectButton(a.trim());
        if (btn) main.push(btn);
      }
      for (const a of heroAbils) {
        const btn = this.objectButton(a);
        if (btn) main.push(btn);
      }
      for (const field of ["trains", "sellunits", "researches", "upgrade", "makeitems", "sellitems"]) {
        for (const x of this.list(id, field)) {
          const btn = this.objectButton(x);
          if (btn) main.push(btn);
        }
      }
      if (this.list(id, "trains").length) cmd("CmdRally");

      unit.cards.unshift({ id: "main", buttons: main });
      this.units.push(unit);
      for (const card of unit.cards) {
        for (const btn of card.buttons) {
          const key = btn.section.toLowerCase();
          const users = this.users.get(key) ?? [];
          if (!users.includes(unit)) users.push(unit);
          this.users.set(key, users);
        }
      }
    }
    this.sortUnits();
  }

  /** A comma list off a func row (`Trains`, `Builds`, …). */
  private list(id: string, field: string): string[] {
    return splitList(this.field(id, field)).map((s) => s.trim()).filter((s) => !blank(s));
  }

  /** The install's own spelling of a section, for writing a NEW one into the player's file. */
  private canonical(section: string): string {
    return this.defaults.get(section.toLowerCase())?.name ?? section;
  }

  private cancel(): CatalogButton {
    const art = this.field("CmdCancel", "art");
    return {
      section: this.canonical("CmdCancel"),
      variant: "",
      name: plainTip(this.field("CmdCancel", "tip")) || "Cancel",
      icon: skinValue(this.skins, "Default", art) ?? art,
    };
  }

  /**
   * A button for an object section — an ability, a unit, an upgrade, an item. Null for one that
   * never reaches a card: no art and no hotkey is an ability like Inventory or Locust, which the
   * game carries and never draws.
   */
  private objectButton(section: string, variant: KeyVariant = ""): CatalogButton | null {
    if (blank(section)) return null;
    const row = this.defaults.get(section.toLowerCase());
    if (!row) return null;
    const f = row.fields;
    const icon = (variant === "research" ? f.get("researchart") : undefined) ?? f.get("art") ?? "";
    const hasKey = f.has(hotkeyField(variant)) || f.has(posField(variant));
    if (!icon || !hasKey) return null;
    const unIcon = variant === "" ? f.get("unart") : undefined;
    const name = splitList(f.get("name") ?? "")[0]?.trim() || plainTip(splitList(f.get(tipField(variant)) ?? "")[0] ?? "") || row.name;
    return { section: row.name, variant, name, icon: splitList(icon)[0], ...(unIcon ? { unIcon: splitList(unIcon)[0] } : {}) };
  }

  /**
   * Heroes, then units, then buildings, then the special forms — each in the order the race's
   * own tech hands them out (the altar's `Trains`, the barracks' and the rest, the worker's
   * `Builds`), which is the order a player meets them in and the order the World Editor lists.
   */
  private sortUnits(): void {
    const rank = new Map<string, number>();
    let n = 0;
    for (const u of this.units) {
      for (const field of ["builds", "trains", "upgrade", "sellunits"]) {
        for (const x of this.list(u.id, field)) if (!rank.has(x)) rank.set(x, n++);
      }
    }
    const groupOrder: CatalogGroup[] = ["hero", "unit", "building", "special"];
    this.units.sort((a, b) =>
      CATALOG_RACES.indexOf(a.race) - CATALOG_RACES.indexOf(b.race)
      || groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group)
      || (rank.get(a.id) ?? 1e6) - (rank.get(b.id) ?? 1e6)
      || a.name.localeCompare(b.name));
  }
}

const isButton = (b: CatalogButton | null): b is CatalogButton => b !== null;
