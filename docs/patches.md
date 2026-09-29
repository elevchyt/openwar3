# Patches after 1.30.4 — the ledger (issue #160)

OpenWar3 reads the game data of **1.30.4** (build 11274, 2019-01-14; the install's own
`.build.info` says `1.30.4.11274`). Blizzard has kept patching Warcraft III since, and issue #160
is how we catch up: our OWN patch files, laid over the install's tables, so a melee game can play
on a later balance without a byte of Blizzard's later data in this repository.

This file is the RECORD — every patch since 1.30.4, what it changed, and where that is written
down — and the account of the pipeline that turns each release into a patch file
(`src/patches/data/<version>.json`, format in [`src/patches/README.md`](../src/patches/README.md)).
Read it before touching `src/patches/`, `src/vfs/patch.ts` or `tools/patch-*`.

**Scope rule: the Forsaken Paladin does not exist.** 3.0.0 added a tavern hero (`Npal`). We treat
the game as though it never shipped: no unit row, no abilities, no Tavern `Sellunits` entry, no
`ReducePlayerTechMaxAllowed(…, 'Npal', …)` line in `MeleeStartingHeroLimit`, and none of the PTR
nerfs to him. Whatever tool imports a patch must refuse his ids by name (a DENYLIST), not rely on
somebody remembering. That is `DENIED_IDS` in `src/patches/index.ts`.

## What a patch touches — the four corners

The install keeps four copies of the object tables (docs/editions.md). Every balance change after
1.30.4 was aimed at ONE of them:

|  | The Frozen Throne | Reign of Chaos |
|---|---|---|
| **melee** | **patched** — every balance line below | frozen (its AI scripts are byte-identical 1.32.0 → 3.0.0; its SLKs are unchecked) |
| **custom / campaign** | frozen — proved by 2.0.1.22490, which lost the `_balance` sets and made custom maps read melee values; the players' list of what changed (Call to Arms on the Town Hall, Improved Masonry 20 %, Rod of Necromancy 75 g / 2 charges, no Wand of Negation at the Tomb) is exactly the post-1.30 melee work missing from `Custom_V1` | frozen |

So a patch is **a newer copy of the live melee tables**, and nothing else moves. Unverified: whether
2.0.3's Piercing-vs-Heavy change also reached `Custom_V1\Units\MiscGame.txt`.

Three more facts that shape the pipeline:

- **Blizzard adds NEW ids rather than editing old rows** for a new mechanic — Sundering Blades,
  Incite Unholy Frenzy and the Ritual Dagger (1.31.0), `AIno`/`Bson` Orb of Slow (2.0.2),
  `Amgi`/`AUa2` (2.0.3). A patch file needs whole new rows, not only edited values, and a new row
  may need ART a 1.30.4 install does not have.
- **Some changes are ENGINE behaviour, not data** — orb effects triggering on auto-acquire (2.0.3),
  hero-inventory items no longer destroyed by projectiles (1.32.6), Anti-magic Shell taking damage
  from dispels (1.35.0), Defense Type Change upgrades actually changing armour (2.0.2). No table
  carries them; they need code gated on the patch level.
- **The race AI scripts did not change** from 1.30.4 to 3.0.0 (`common.ai` gained four constants:
  `nftr`, `ndrb`, `ncta`, `ncte`), so the ports in `src/ai/` stay the game's at every patch level.

## The ledger

Official notes are on `us.forums.blizzard.com/en/warcraft3/t/` (path given); Liquipedia keeps one
page per patch at `liquipedia.net/warcraft/Patch_<ver>`, with per-race subpages
(`/human`, `/orc`, `/undead`, `/night_elf`, `/neutral`, `/item`), and warcraft.wiki.gg at
`/wiki/Warcraft_III/Patch_<ver>`. Small patches were posted as replies to the hotfix thread `28629`.

| version (build) | date | balance | headline | official notes |
|---|---|---|---|---|
| 1.31.0 (12071) | 2019-05-28 | **big** | Lua, object-editing natives, 64-bit, `.w3mod` layout, RoC melee off Battle.net | `1-31-0-patch-notes/5721` |
| 1.31.1 (12164) | 2019-06-10 | map only | natives zero-indexed; Terenas Stand creeps | `1-31-1-patch-notes/6290` |
| 1.32.0 (14481) | 2020-01-28 | undocumented revert | Reforged launch; 1.31's Necromancer rework reverted | `warcraft-iii-reforged-patch-notes/14023` |
| 1.32.1 (14604) | 2020-02-06 | — | bug fixes | `…-version-1321-patch-notes/19379` |
| 1.32.2 (14722) | 2020-02-24 | — | Bladestorm/Ensnare fix | `…-patch-notes-version-1322/21944` |
| 1.32.3 (14857) | 2020-03-18 | map drops | Market Square / Timbermaw Hold drop tables | `…-version-1323-patch-notes/22869` |
| 1.32.4 (15098) | 2020-04-28 | — | art pass | `…-version-1324-patch-notes/23855` |
| 1.32.5 (15129) | 2020-04-29 | — | hotfix | `hotfixes-april-29-2020/23979` |
| 1.32.6 (15355) | 2020-06-02 | **big** | charged items, mercenary camps per tileset, Transport Ship | `…-patch-notes-1326/24578` |
| 1.32.7 (15572) | 2020-07-07 | fix | Frost Wyrm illusions don't slow | `…-patch-notes-1327/25039` |
| 1.32.8 (15762) | 2020-08-11 | 1 row | Carrion Beetles | `…-version-1328/25373` |
| 1.32.9 (16207) | 2020-10-21 | **yes** | HU vs UD, OR vs NE | `…-version-1329/25912` |
| 1.32.10 (17165) | 2021-04-13 | **yes** | aura items, item resell 60 % | `…-version-13210/26961` |
| 1.33.0 | 2022-08-17 | — | campaign tuning only | news.blizzard.com/en-us/warcraft3/23816417 |
| 1.34.0 | 2022-12-01 | — | clans, reporting | `patch-1340-arrives-december-1/29471` |
| 1.35.0 (19882) | 2023-01-19 | **big** | altar heroes 400 g, `ReviveTimeFactor` 0.6 | `…-patch-1350-notes-january-19/29812` |
| 1.35.0a (20063) | 2023-03-21 | yes | Immolation, Mirror Image, Anti-magic Shell | `28629/9` |
| 1.36.0 (20210) | 2023-05-09 | **yes** | observer UI | news.blizzard.com/en-us/warcraft3/23951676 |
| 1.36.0 (20214) | 2023-05-10 | prices | Ring of Protection +3/+4/+5, Ring of the Archmagi (a 1.36.0 hotfix build) | `28629/11` |
| 1.36.1 (20719) | 2023-11-20 | **yes** | Keep/Castle food, Spiked Carapace | `…-version-1361/31486` |
| 1.36.2 (21179) | 2024-06-04 | **big** | **Tomb of Relics: Scroll of Healing → Wand of Negation**; creep pass | `…-version-1362/32218` |
| 1.36.2 (21214) | 2024-06-17 | yes | charged cooldown kept on hand-over; Rod of Necromancy 22 s | `28629/16` |
| 1.36.2 (21228) | 2024-06-18 | yes | reverts most of 21214 | `28629/17` |
| 2.0.0 (22365) | 2024-11-13 | — | Classic HD, addons | `…-version-20/33148` |
| 2.0.1 (22474) | 2024-12-17 | — | Reforged FOV (22490 lost the `_balance` sets — see above) | `…-version-201/33148/4` |
| 2.0.2 (22692) | 2025-04-16 | **big** | Orb of Slow replaces Orb of Fire, wards magic immune, creep pass | `…-version-202/35355` |
| 2.0.2 (22796) | 2025-04-29 | yes | Siphon Mana, Sentinel, reverts | `28629/23` |
| 2.0.3 (22968) | 2025-07-17 | **yes** | **Piercing vs Heavy 90 %**; w3i v32/v33 | PTR `36314`, `36388`, `36490` (final post overwritten) |
| 2.0.3 (23101) | 2025-09-15 | yes | Ghoul damage 9; w3e v12 (64 tilesets) | `36567/4` |
| 2.0.4 (23452) | 2026-01-26 | **yes** | Master Training times, Wand of Negation 120 g | `…-version-204/36567/5` |
| 2.0.4 (23556–23745) | 2026-02-24 → 04-21 | — | bug fixes | `36567/6`, `28629/27` |
| 3.0.0 (24268) | 2026-09-12 | **Forsaken Paladin only — ignored** | equipment system, ~142 natives, `ITEM_TYPE_EQUIPMENT` renumbers `ITEM_TYPE_UNKNOWN`/`ANY` | `…-forsaken-kingdom-patch-notes/38400` |

**So the balance we can reach is 2.0.4 (build 23745).** 3.0.0 adds nothing to melee balance
beyond the hero we are ignoring; its PTR (3.0.1.24323) changes only him so far.

## Per-patch balance, as documented

Numbers are the official notes' where they were checked, otherwise Liquipedia's. These are the
PROSE claims; each must be confirmed against the patched data before it becomes a patch entry
(see "Where the numbers come from").

**1.31.0** —
*Human:* new research Sundering Blades (100/100, 40 s, Barracks; Castle + Lumber Mill +
Blacksmith: Knights +15 % vs Medium); Knight, Gryphon Rider, Dragonhawk Rider +50 HP; Animal War
Training +100 HP (was 150) for 125 lumber (was 175); Control Magic 45 % of target HP; Orb of Fire
+7, no splash, −35 % healing/regeneration for 3 s.
*Orc:* Wind Walk cooldown starts on break, 2 s; Critical Strike multiplies all damage; Devour on
Mountain Giants without Resistant Skin; Pulverize 20 base, "Upgrade Pulverize" to 60 (225 lumber);
Spiked Barricades two levels (5 + 20 %, 5 + 50 %).
*Night Elf:* Ultravision on Mountain Giant and both Vengeances; Mana Burn 50; bear 23; Vorpal
Blades 2000 speed, can miss, circular splash; Hippogryph Rider 785 HP; Keeper night sight 800,
Int 18, Tranquility invulnerability 1 s, Treants 14.
*Undead:* Gargoyle 375 speed, 175 gold; Necromancer rework (Cripple 85 mana; Incite Unholy
Frenzy; Skeletal Mastery and Raise Dead need Adept Training); Ghoul Frenzy 35 %; **new item
Ritual Dagger at the Tomb** (125 g, 2 charges, heals 100 in 300).
*Neutral:* Alchemist Healing Spray 6 s cooldown, Acid Bomb 5/3 and 10/6, Transmute 100 %;
Soul Burn 65 mana, 80/200/340; Breath of Fire burn 7/14/21; Life Drain applies Dark Minion.
*Items/shops:* Boots of Speed out of drops, Goblin Merchant stock 2; Cloak of Shadows by day;
Crystal Ball level 3, 300 g; Periapt 325 g; Lion Horn +2; Bone Chimes 20 %; Warsong Drums use
the Kodo aura; Sentry Wards 3 min; Tome of Experience out of drops; Ring of Protection +2 out,
+3 level 2/125 g, +4 level 3/300 g, +5 level 6/600 g. New item field "Stock Initial After Start
Delay".

**1.32.0** (undocumented) — the Necromancer rework reverted: Cripple 125 mana −50 % / −50 %,
Master Training; Unholy Frenzy 50 mana, 1 s, +75 %, 3 HP/s; Raise Dead and Skeletal Mastery
need nothing.

**1.32.6** —
*Human:* Thunder Clap 7 s; Resurrection 150; Rifleman cooldown 1.4.
*Orc:* Big Bad Voodoo 150; Earthquake 20 s, 60/s to buildings, 125 mana, no friendly damage;
War Stomp 7 s; Stasis Trap 9 s / 175 / 0.5 s.
*Night Elf:* Roots level 3 range 800; Tranquility no invulnerability, 12 s, heals 48; bear 24;
Druid of the Talon 135 g.
*Undead:* Impale uninterruptible, hits air; Crypt Lord cast point 0.5; Carrion Beetles 45 mana,
2 per cast, max 6, 9 s; Animate Dead 125; Skeleton Warrior 180 HP; Ritual Dagger heals 175.
*Neutral:* Summon Bear 100; Doom slows 50 %; Volcano 5 waves / 3 s, ×3 to buildings, no friendly
damage; Tornado no wander, 125 mana, 20 s, 100 / 14/s to buildings.
*Items:* Greater Mana 250; Potion of Mana 125 mana, 150 g; Pendant of Energy +100; Scroll of
Restoration 150; Mana Stone 250; level-5 charged drops Blue Drake Egg + Idol of the Wild (new),
level-6 Scepter of Avarice, Engraved Scale, Scepter of Mastery (new); Inferno Stone to level 7;
**hero-inventory items not destroyed by projectiles (engine)**.
*Shops:* Transport Ship (level 1, 900 HP, Light, stock 2, 120 s delay, 30 s restock).
*Mercenary camps:* overhauled, line-up per tileset, delays 120/220/440 s.

**1.32.7** — Frost Wyrm illusions don't slow. **1.32.8** — Carrion Beetle HP 275/410, 50 mana.

**1.32.9** —
*Human:* Castle 320 g; Peasant 230 HP; Thunder Clap 60/110/150; Rifleman 1.35; Spell Breaker
armour 2; Slow 55 %; Siege Engine bounty 85.
*Orc:* Great Hall 11 food; Mirror Image 80; War Stomp hero stun 2/2.5/3; Shockwave 90.
*Undead:* Spirit/Nerubian Tower repair 45; Unholy Aura 10/17.5/25 %; Carrion Beetles 300/440 HP,
280 speed, Burrow needs the research, level 2 collision 32; Destroyer cast point 0.66; Gargoyle
"Prioritize" air toggle; Unholy Frenzy 2 HP/s; Rod of Necromancy 26 s.
*Night Elf:* Detonate 40 mana; Archer 255; Hippogryph Rider 780; bear 25; Chimaera no friendly
fire.
*Neutral:* Rain of Fire level 1 range 700.
*Items:* Helm of Valor / Medallion of Courage / Hood of Cunning +5; Claws +6 → +5; Tome of
Retraining 200 g; Wand of the Wind 2 charges.

**1.32.10** —
*Human:* Improved Lumber Harvesting needs nothing, Advanced needs Keep; Knights have Sundering
Blades built in; Dispel range 700; towers repair 5 s faster; Thunder Clap area 300/325/350.
*Orc:* Scroll of Speed 70 g; Serpent Ward bounty 12.5/30/42.5.
*Undead:* Acolyte blight regeneration 3; Rod 24 s; Ritual Dagger 100 g; Impale 60/105/150 and
1/1.5/2 s on heroes; Boneyard no Sacrificial Pit; Frost Armor slow 3/5/7 s.
*Night Elf:* Druid of the Claw 125 starting mana; Mountain Giant one Taunt, 14 s; Mana Flare
4 per mana, cap 100; Faerie Dragon 12.
*Neutral:* Brewmaster +1 Str/Int; Breath of Fire caps 480/800/1200.
*Items:* aura items nerfed (Alleria's Flute 7.5 %, Janggo 3/7.5 %, Khadgar's Pipe 0.5, Doom-Horn,
Bone Chimes 15 %, Warsong Drums 7.5 %, Lion Horn 1.5); Town Portal 325 g; **item resell 60 %**
(presumably `MiscGame.txt` `PawnItemRate`).

**1.35.0** —
*General:* **altar heroes 400 g**; **`ReviveTimeFactor` 0.6**.
*Human:* Blacksmith 40 lumber; Peasant 240; Spell Breaker armour 3; Control Magic tier 3; Siphon
Mana 15/25/40; Polymorph 200; Mechanical Critter sight 500; Barrage 16; Mass Teleport 30 s;
Staff of Sanctuary 200 g; Orb of Fire +5, 250 g.
*Orc:* Headhunter 22 s; Mirror Images 15 % damage with level-based XP; Bladestorm 120 s; Liquid
Fire −75 % repair; Endurance Aura 10/15/20 %; Stasis Trap 7 s; Brute Strength +125; Great Hall
140 s; Feral Spirit 85; Chain Lightning 110.
*Night Elf:* Tranquility 120 s; Roots 9/17/25; Thorns 15/30/45 %; Starfall 120 s, 150; Mountain
Giant +2 armour, Hardened Skin 8; Ultravision tier 2; Immolation 8/12/18 per 0.5 s, 6 drain,
20 to activate / 10 required; Talon crow piercing 26, 25 mana; Claw 100 starting mana.
*Undead:* **Anti-magic Shell takes dispel damage (engine)**; Unholy Aura 10/15/20 %; animated
corpses killable, carry Disease Cloud; Disease Cloud 75 s; Obsidian Statue level 3, 2 mana;
Haunted Gold Mine 110 s; Dark Ritual 20 s, 33/55/80 %.
*Items:* Wand of Illusion 2 charges; Wand of Mana Stealing 65; Doom-Horn/Janggo speed 5 %.

**1.35.0a** — Mirror Image 20 %, XP capped 30; Immolation 7/12/18, 7 drain, 1 / 9; Anti-magic
Shell 420. **Hotfix 2023-05-10** — Ring of Protection +3/+4/+5 and Ring of the Archmagi prices.

**1.36.0** — Arcane Tower hero Feedback 16; Sundering Blades 10 %; Headhunter 350, Berserker 450;
Pulverize research 100/175; Immolation 6/11/17; Sentinel research 50/50; Cannibalize research
50 g / 15 s; Claws +5/+9 → +4/+8; Greater Mana and Mana Stone 200; Circlet level 3; Ring of
Protection +3/+4/+5 levels 1/2/3; Ring of Superiority and Ring of the Archmagi into drops; Wand of
Mana Stealing 60; Wand of Lightning Shield out.

**1.36.1** —
*Human:* Archmage Str/level 2.0; Bash 25/40/55; Devotion Aura 2/4/6; Paladin 300 speed; Militia
42.5 s; **Keep 14 food, Castle 16 food**; Priest cast point 0.4, Heal cooldown 1.1.
*Orc:* Bladestorm 140/s; Spirit Walker 35 s, 50/65 s training; Steel Armor lumber +125, weapons
+75; Headhunter 375, Berserker 475; Tauren 39 s.
*Night Elf:* Moon Well regen 1.35; Immolation 10/10; Blink 10/5/2.5; Fan of Knives 5/6/7
targets; Mana Flare cap 80; Mark of the Talon Adept Training.
*Undead:* Spiked Carapace 15/30/45 % and +4/8/12 armour; Dreadlord 300; Cripple 100; Skeletal
Mastery 150/100; Nerubian Tower 1.3, heroes 3 s; Abomination turn 0.5; Crypt Fiend turn 0.6.
*Neutral:* Incinerate 3 mana; Lava Spawn 13 hits; Volcano 125.
*Creeps:* some trolls and the Assassin 270 speed; creep Frost Armor 3 s.
*Items:* Tome of Retraining and Staff of Teleportation stock 2; Crystal Ball level 2 charged,
3 charges, no cooldown; Ring of Protection +3 out of drops; Claws +4 → +5; Periapt 300 g.

**1.36.2** —
*Human:* Polymorph on heroes (1.5 s); Arcane Tower hero Feedback 14; Knights and Sundering Blades
no Lumber Mill, Sundering Blades a research again 100/150; Flame Strike 0.8 cast; Control Magic
0.35 × HP + 40; Dragonhawk 19.
*Orc:* Headhunter 21 (reverted to 22 by 21228); Healing Ward 150; Tauren 290; Serpent Ward
level 3 45; Demolisher 240.
*Night Elf:* Searing Arrows 12/24/48; Starfall 30 s at 60/wave; Vorpal Blades 45 s; Moon Well
1.45; Well Spring +100; Fan of Knives 6/6/6 at 70/130/200; Wisp 125 HP; Glaive Thrower 240;
undocumented Nature's Blessing 150 lumber (200 after 21228), Tranquility 100 s.
*Undead:* Anti-magic Shell immune to Devour Magic; Haunted Gold Mine 105 s; Nerubian Tower
piercing; Ghoul Frenzy 50 s; Curse 60/30 s; Cripple on mechanical; **Tomb of Relics: Scroll of
Healing out, Wand of Negation in** ("2 Charges, 150 Gold, 5-second cooldown – Available at tier
2"); Meat Wagon 240; Frost Nova slow 4/5/6; Impale 90; Death and Decay 200; Web 100/100;
Boneyard 150/200; Freezing Breath 225 lumber; Abomination 34.
*Neutral:* Volcano ×2 to buildings; Soul Burn −75 %, 8/9/10 s on heroes; Tornado 150 speed;
Mana Shield 10 to activate; **Goblin Zeppelin 1 food**.
*Items:* Ankh delay 5 s; Gloves of Haste 18 % (Liquipedia's race page says 20 %); Circlet 200 g.
*Creeps:* Sleep not on heroes, 8 s, 10 s, 100; Enforcer and Bandit Lord lose Shadowmeld,
Enforcer 600; Dark Troll High Priest Abolish Magic; Rogue Wizard sleeps; Rune of Speed 20 s;
Infernal Machine 200; creep Mana Burn 50; creep Force of Nature 2 for 100; Sea Giant Pulverize
30/15; creep Cripple 20 s, 125; Centaur Archer, Impaler (400 HP), Sorcerer Medium armour.

**2.0.2** —
*Human:* **Orb of Slow replaces Orb of Fire** (325 g, +5, 25 % / 10 % heroes, −25 % attack
−55 % move, 10/5 s; new ids `AIno`, `Bson`); Flame Strike 125; Siphon Mana 700 range; Banish
4/2/0 s; Holy Light 5.5 s; Devotion Aura 2/3.5/5; Militia armour 3; Defend 50 % piercing, 25 %
deflect, 125/75, 40 s; Slow 45 s; Invisibility 400 range; Heal 350 range; Flying Machine 375;
Dragonhawk and Cloud need no Arcane Vault.
*Orc:* Orb of Lightning 200 to summons; Mirror Image 5 s; Great Hall 135 s; Wind Rider level 3,
Envenomed Spears 3/tick, 310 speed; wards magic immune; Sentry Ward 1200 sight, 50 HP; Stasis
Trap 25 HP, 350, 4/2 s; Healing Ward 25 s, 450; **Tauren Resistant Skin, 300/100**.
*Night Elf:* Orb of Venom 8/tick; Keeper Str gain 2.0; Treant cooldown 1.65; **Wisp lumber cycle
7 s**; Huntress 340; **Moon Glaive makes the Huntress Heavy-armoured**, 125/175, 60 s; Chimaera
270; Vorpal Blades +10.
*Undead:* Wand of Negation 4 charges, single target, 200 to summons; Ritual Dagger 75 g,
1 charge, heals 200; Frost Nova 700 range; Carrion Swarm 75/135/200; Nerubian Tower 1.15;
Burrow 30 s; Gargoyle 350; Cripple 90; Anti-magic Shell 300; death clouds no collision;
**Frost Wyrm 375 range, splash hits air**.
*Neutral:* Rain of Fire 800 range; Life Drain on allies.
*Items:* Sentry and Healing Wards magic immune (2 charges, 25 s, 450); Ring of Protection +4 out,
+3 back at 125 g; **Backpack needs nothing**; Orb of Darkness full Dark Minions; Janggo/Doom-Horn
7.5 %.
*Creeps:* large pass (Poison Treants, Spitting Spider Medium 350, Giant Spider 500, Satyr
Hellcaller level 8, Giant Wolf delay 440, Shadowdancer 190 g, creep Immolation 5, Roots 6/3,
many casters' cast times 0.599, stat changes to a dozen creeps).
*Engine:* **Defense Type Change upgrades change the armour type**.
**2.0.2 (22796)** — Siphon Mana 25, 8 s; Ultravision 45 s; Sentinel 120 s; Ritual Dagger
restock 75 s; Infernal/Fire permanent Immolation back to 10; Life Drain ignores caster
resistance.

**2.0.3** —
*General:* ground splash hits Wards; **Piercing vs Heavy 90 %** (`DamageBonusPierce`, Heavy
column — inferred); **orb effects fire on auto-acquire (engine)**.
*Human:* Bash stuns magic-immune air with an orb.
*Night Elf:* Wisp cycle 7.5 s; Archer 275; Hippogryph Rider 800; pick-up/mount cooldown 5 s;
Huntress glaives don't bounce off structures (new `Amgi`); Moon Glaive 50 s.
*Undead:* Animate Dead keeps abilities (new `AUa2`); Frost Nova 750; Prioritize fixed for groups.
*Neutral:* Cleave hits Wards; Drain Life self-damage Universal (mana contested — see below);
Pocket Factory 4.5/4/3.5/3 s; Cluster Rockets 200/250/300; Breath of Fire 80/130/180, caps
600/900/1200, width 175, burn 10/15/25; level-3 Skeletal Orc loses Vampiric Aura and Death Coil.
**2.0.3 (23101)** — Ghoul damage 9; Drain Life can't target self.

**2.0.4** — Rifleman 1.4; Sorceress/Priest Master Training 60 s; Water Elemental level 2 30;
Shaman/Witch Doctor/Spirit Walker Master Training 60 s; **Healing Salve 40 s** (same total);
Druid of the Talon Master Training 60 s; Glaive Thrower 42 s; Ghoul 10 at 1.35; Banshee Master
Training 60 s; **Wand of Negation 120 g, 3 charges, 5 s**; Frost Wyrm 60 s, heroes 4 s; Abolish
Magic 150 to summons; Troll Shadow Priest delay 180; Breath of Fire start width 90; Beastmaster,
Tinker, Pit Lord +2 Str; Life Drain 30 mana, 600 cast, 700 tether.

### Where the sources disagree

- 1.35.0 Immolation: Liquipedia's main page mixes launch and 1.35.0a values; the official launch
  values are above.
- 1.36.2 Gloves of Haste: 18 % official, 20 % on Liquipedia's race page.
- Drain Life mana: the 2.0.3 PTR says 50 → 25, the 2.0.4 notes say 35 → 30. What 2.0.3 shipped is
  unconfirmed.
- 2.0.3's final notes post was overwritten with 2.0.4's; Liquipedia's 2.0.4 link points at the
  2.0.3 build-23101 post.
- Undocumented changes exist (1.32.0's Necromancer revert, 1.36.2's Nature's Blessing and
  Tranquility) — the prose is not a complete account.

## The pipeline

Chosen on issue #160: **a layer over the install's own files** (option A), patches written as
**JSON by hand from the notes**, the game **always on the latest release**, and a tool that reads
a real build's tables to check the transcription.

```
 src/patches/data/<version>.json      one release, in the game's own terms (file, row, column, value)
          │  src/patches/index.ts     the chain: order, level, denylist, `patchAtLeast`
          ▼
 PatchDataSource (src/vfs/patch.ts)   rewrites the touched tables once, serves our own icons
          ▼
 EditionDataSource (src/vfs/edition.ts)   picks the data set; only the live melee corner is patched
          ▼
 every reader, unchanged — the registries, the viewer's SLKs, tooltips, hotkeys, Blizzard.j
```

**Why a layer and not an object-editor overlay.** A map's object edits (`applyMap*Data`) reach
the five registries and nothing else; the patched tables are also read by the viewer's own copy
of `UnitData.slk`/`ItemData.slk`, by the tooltip composer and by the hotkey catalog. Rewriting the
file under all of them is the one door everybody already walks through — the same one the
edition overlay uses — so no reader has to know a patch exists.

**The rules that fall out of the data:**

- **The live melee corner only.** `PatchDataSource` sits UNDER the edition overlay: a campaign
  chapter's `Custom_V1\…` path and Reign of Chaos's `Melee_V0\…` path never match a patch's
  `Units\…` path, and `dataSetFolder()` is asked as well for a file with no twin. `MISC_GAME` is
  compiled in, so `miscGame()` asks the chain for the same rows (`patchedMiscGame`) on the same
  corner — which is how 1.35.0's `ReviveTimeFactor` and 2.0.3's Piercing-vs-Heavy reach the sim.
- **A 1.30.4 store only** (vfs/loader.ts). The values are stated against 1.30.4; an MPQ-era
  install is older.
- **Always the latest.** `setPatchLevel()` rolls the chain back to any release, for developers
  only — tests, `?dev&patch=1.32.10` — and nothing a player can reach.
- **No Blizzard text.** A value is a number, an id, a path or our own words. A number a tooltip
  spells out is corrected with a replacement (`{"replace": [["300", "150"]]}`) made at runtime in
  the player's own file, and a NEW object's name and tooltips are ours.
- **Our own art.** Objects the patches added with art a 1.30.4 install lacks carry OpenWar3's own
  icons (`src/patches/art/*.png`, the Ritual Dagger and Sundering Blades), converted to BLP by
  `node tools/patch-art.mjs` and served at the path the later game uses —
  `BTNSacrificialDagger.blp`, `BTNSunderingBlades.blp`, `PASBTNSunderingBlades.blp` — so a map
  saved by a later editor that names them finds them.
- **The Forsaken Paladin is denied by name** (`DENIED_IDS`, `DENIED_WORDS`); `pnpm patches:check`
  fails on any mention, and the chain drops a row keyed on his id even if one slipped in.

## Checking a transcription against the game

`pnpm patches:check` proves every release APPLIES: each file, row, column, `$base` and
replacement resolves against 1.30.4 plus the releases before it, and the rewrite itself is
lossless on all 64 `Units\` tables.

`tools/patch-extract.mjs` proves the values are RIGHT. It reads a real build's data tables —
off Blizzard's CDN (`--cdn`) or off any 1.30+ CASC install on disk (`--install <folder>`, either
the 1.30 `War3.mpq:` layout or 1.32+'s `War3.w3mod:` tree) — into `.cdn-cache/extract/<version>/`
in 1.30.4's layout, then `--diff` compares them with the install and `--verify` with OUR CHAIN
applied to the install.

**The CDN keeps only current builds.** Every build config from 1.30.0 to 2.0.4 answers 404 (the
1.30.4 install's own `7c45731c…` among them), so the CDN can serve the LIVE build and the PTR and
nothing else. That is still the check that matters: the live build is 3.0.0, and 3.0.0 changed no
melee balance beyond the hero we ignore, so its melee tables are exactly where our chain has to
END. `--verify` against it leaves only three kinds of line — a note we have not transcribed, a
value we got wrong, or a change the notes never mention. An intermediate release can be checked
the same way only from somebody's install of it (`--install`).

The diff compares TABLES, not files, and leaves out what 1.32's restructuring moved rather than
changed: a column only one side's SLK has (`stockInitial`, `DataK`–`DataT`), a column the newer
build emptied in every row (art and sound went to `*Skin.txt`), and a new row nothing changed
points at (Reforged's campaign objects). Tooltip wording is left out unless `--strings`.

## The chain as it stands

Twenty files, one per release that changed a table: `1.31.0`, `1.32.0` (the undocumented
Necromancer revert and the Ritual Dagger's move to regeneration), `1.32.6`, `1.32.7`, `1.32.8`,
`1.32.9`, `1.32.10`, `1.35.0`, `1.35.0.20063`, `1.36.0`, `1.36.0.20214`, `1.36.1`, `1.36.2`,
`1.36.2.21214`, `1.36.2.21228`, `2.0.2`, `2.0.2.22796`, `2.0.3`, `2.0.3.23101`, `2.0.4`. 1.31.1,
1.32.1–1.32.5, 1.33.0, 1.34.0, 2.0.0, 2.0.1 and the 2.0.4 hotfix builds change no melee table
and have no file.

**Where the notes and the game disagree, the game wins** (CLAUDE.md's rule), and each such
change says so in its `note`: the Ritual Dagger's 1.31 cooldown is 20 s whatever the notes say,
Sundering Blades still asks for a Lumber Mill after 1.36.2, the Gloves of Haste are 18 %. A
change the notes never mention but the live tables show is recorded with `"source":
"undocumented"`, in the release it belongs with — or, where nothing says which, in 2.0.4 with a
note saying so. That only matters for a ROLLBACK; at the latest level the chain is the game.

**What `--verify` against 3.0.0 still reports, and why none of it is applied:**

- **Layout and presentation** — attachment points, missile arcs, HD art paths, the destructable
  and meta tables, editor-only columns, `*Skin.txt` moves, tooltip rewording.
- **3.0.0's own content** — the Forsaken Paladin (Tavern, `[HERO] DependencyOr`), the Definitive
  Edition talents and equipment (`ATal`, `AHsw`, `AHap`, `AHmc`, `AUwc`, the `AIs2` items), and the
  engine settings 3.0.0 added to `MiscGame.txt` (`AICallForHelp`, `BaseMeleeCritDamage`, …).
- **Unused ability levels** — a fourth level on a three-level hero ability (`AHtc DataE4`,
  `ANso DataA4`, …): data nothing can reach.
- **The upgrade display icons** — fifteen passive `APai` rows (`Ahri` Long Rifles, `Augf` Ghoul
  Frenzy, …) that Reforged hangs on a unit to show a research it has. Presentation only; no
  release names them and a 1.30.4 install has no art for most of them.
- **Two code swaps with no behaviour behind them here** — Moon Glaive's rows moved to code
  `Aaab` (the engine does not model the glaive's bounce at all yet) and `[utod] Researches`,
  which 1.30.4 states on two lines that the tech tree already unions.

## New base codes, and what the engine does with them

A code a later patch introduced is inert until the engine knows it — a unit SPAWNS only with
abilities whose code is in `KNOWN_ABILITIES` (`RtsController.buildInitialAbilities`), which is how
the Knight first came out of the Barracks without Sundering Blades while every data check
passed. `tools/patch-effects-test.cjs` asserts it for each code that matters.

| code | row | status |
|---|---|---|
| `Aaab` | Sundering Blades `Ahsb` | done — `SimWorld.armorClassBonus`, DataB × the armour class DataC names, gated on `Rhsb` |
| `AIdg` | Ritual Dagger `AIdg`/`AIg2` | done — sacrifice, then instant or poured heal by its own Dur1 (`applyItemAbility`) |
| `Aosl` | Orb of Slow's `AIno` | done — Slow's handler (the Sorceress's row shape) |
| `Aprg` | Wand of Negation `AIpw` | already implemented (Purge) |
| `AUa2` | Animate Dead (New) | folded onto `AUan` at the SLK boundary (`LATER_CODE_TWINS`); keeping abilities is an engine entry |
| `Afrb` | Frost Attack (New) `Afrc` | already implemented (it keeps `Afrb`'s code) |
| `Aatp`, `Amgi`, `AIhu`, `Auuf` | Prioritize, the glaive filter, Orb of Fire v2, Incite Unholy Frenzy | not implemented — the last two are unused at 2.0.4 |

Every other behaviour change is an `engine` entry in its release with `implemented: false` — the
to-do list for `patchAtLeast()`.
