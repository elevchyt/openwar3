# Computer+ on WarChasers

`src/ai/plus/warchasers/` — a party member for Blizzard's co-operative dungeon crawl,
`Maps\Scenario\(4)WarChasers.w3m`. Read this before touching any of it.

## Why it exists, and why it FOLLOWS

A scenario runs none of the melee library, so no script seats a computer; in the real game a computer
in one of this map's four hero seats is a wisp standing on the picker floor for the whole match.
`MapViewerScene.startCustom` recognises the map by its script (`isWarChasersScript` — `RoboX`,
`Skeletorus`, `Snap_Camera_to_Player`, `Monster_Spawn_Sweep`, never the file name) and hands the lobby's
computers in seats 0, 1, 5 and 6 to `RtsController.startWarChasersAI`. Seat 11 is the dungeon's.

The map is a single winding route of keys, levers, puzzle circles, waygates and a tank ride. A computer
cannot be taught the route without hard-coding the whole map, and a person who has to wait for a bot
to finish a puzzle is not playing with a party member. So Computer+ here does not play the dungeon —
it plays the PARTY: it follows a person (the **leader**), fights beside them, and does what it is told.

The standing Computer+ rules hold (docs/computer-plus.md): authority-side only, every decision goes
through `PlusHost.execute`, **no cheats at any difficulty**. Every number in the AI's files is OURS;
every map fact is cited in `map.ts` against the trigger, rect or object it came from.

## The map in one screen

- **The picker.** Each of eight pedestals is a rect whose trigger removes the entering unit and creates
  a hero with an **Ankh** at `gg_rct_Start2`. Seven of them check for a wisp, `RoboX` checks nothing,
  and the trigger names do not match what they create (`Skeletorus` watches `gg_rct_DreadKnight`,
  `Demonus` makes Mumm-Rah) — so `PICKS` is keyed on the hero the trigger creates. The pedestals stand
  in two columns: a wisp walked straight at a back-row pedestal picks whichever one is in the way,
  which is why the wisp goes up the aisle first (`PICK_AISLE_X`).
- **Death is final without an Ankh.** `Game_Over` fires for a hero that dies carrying neither `ankh`
  nor `IC17` (Ankh of Reincarnation Deluxe): "Your soul is lost forever". There is no altar. Big Al's
  Shop (`nC04`) sells the Ankh.
- **Items drop on death** (`Make_All_Items_Drop_on_Death`, except the Ankhs), and five trinkets turn
  into +200 gold when picked up (`Convert_*`: `amrc stwp crys tels wswd`).
- **Keys** (`kymn`, `kysn`) open a door when a hero CARRYING one walks into its rect. They are the
  leader's to carry; a computer never picks one up.
- **The tank ride.** Entering `gg_rct_Tank_Enter_01` gives each player a `hC25` steam tank (and hides
  the hero); entering `gg_rct_Tank_Leave_02` hands the hero back. While a player drives one, the tank
  is their body (`bodyOf`).
- **Waygates** (`nwgt`) are placed and pointed by `CreateNeutralPassiveBuildings`; the sim teleports
  whatever walks in.
- **Fountains of Health** (`nfoh`) are the places to heal.

## How it plays (`index.ts`)

1. **Pick** (`pickPass`): a few seconds after the start (so people pick first), for the party — a
   healer if none, a tank if none, a caster if none, then damage; never a hero a party member plays
   while another is free. It says what it took.
2. **The leader** (`leaderBody`): the seat that last said "follow me" / "i lead" while it has a body,
   else the first person with one; with no person left, another party member. Announced once ("right
   behind you", or "following Optimus Primo" when there is more than one person).
3. **Follow** (`followPass`): a `follow` order a step behind, each computer on its own step. Into the
   tank rect when the leader is driving, out of it when the leader is walking again, and into the
   waygate that lands nearest a leader it cannot walk to.
4. **Fight** (`fightPass`): following, what is near the leader and what comes at itself; attacking,
   anything in sight; waiting, what comes to it. The leader's own target first, then whatever is
   hitting a party member (a hero above a summon), then the wounded. A spawner hut only once the
   leader goes for it. Leashed to the leader.
5. **Spells and potions** are the melee Computer+'s: `PlusCaster` and `PlusItems.beltPass` (the belt
   alone, no melee shopping) — with the party's HEALS taken out of the caster's hands (`heal.ts`,
   `healPass`), because a dungeon party is not an army:
   - An allied **hero below 65 %** (`HERO_HEAL_HP`) is healed, the most hurt first — before the
     healer's own Water Elemental or anybody's unit. The melee caster never heals a party hero
     (`CasterView.refuses`); its 75 % ladder is for units.
   - **Mana to spare** is `SURPLUS_CASTS` = 3 heals in the bank. With it, a hero is topped up between
     fights too and the healer walks further for one (`HEAL_WALK_SURPLUS`). Short of it, a hero is
     healed only in a fight, and the heal is never spent on a unit or on a Holy Light nuke
     (`CastCtx.holds`).
   - **Sleep waits for a full bar.** A hero that has Frost Nova (Mumm-Rah) presses Sleep only above
     85 % mana (`SLEEP_MANA`, `CastCtx.holds`) — the caster ranks a hold above a nuke, so without it
     every pull was spent on Sleep and the Nova had nothing left.
   - **A person who asks** ("heal", "heal me", "hael", "need heal", "im low", "heal optimus" —
     `readHealRequest`) is answered by the healer that can land a heal soonest, if one can within
     `HEAL_CALL_WINDOW` = 10 s: "healing you" / "heal in 3 sec", and from then until it lands the heal
     and the mana for it are theirs, above any other spell and any order (`healCall`). Otherwise it
     says why: "my heal is on cooldown", "no mana for a heal", "my heal cant target you" (Holy Light on
     an undead hero). Offers, thanks and news are not requests ("i heal", "thanks for the heals",
     "im healing").
6. **Kite** (`kitePass`): a hero with SUMMONS out and a melee monster on it steps `KITE_STEP` back when
   a summon is beside that monster, so the monster turns on the summon — the sim's own rule for an
   auto-acquired chaser whose target has left its strike range. Sometimes, not always: one kite per
   `KITE_GAP`, at most `KITE_TIME` long, at the difficulty's `kite` chance. At the start of a fight a
   summoner also lets its summons reach the monster first (`KITE_OPEN`).
7. **Rest** (`restDecision` / `restPass`): below `restHp` it stops (never for MANA — a caster short of it walks on with the party), out
   of reach of whatever is swinging, at a Fountain of Health if one is at hand, and SAYS so — "wait i
   need a bit more health" — again while the leader keeps walking away. A party that does not wait is
   not waited for: once every person is past `REST_TRAIL` it gives the rest up and goes after them
   (`rejoining`, no new rest until it is back within `REJOIN_NEAR` of the leader); it says "right behind you"
   when it is fit again.
8. **Loot** (`lootPass`): the most valuable item within reach for ITS hero (`items.ts`), dropping the
   least valuable thing it carries when the belt is full. Never in a fight, never a key, never one a
   person is walking to, never one it just dropped.
9. **Shop** (`shopPass`): at a shop it can walk to, with the leader close: an **Ankh first** if it has
   none — and while it cannot afford one it buys nothing else — then the most valuable ware worth a
   slot, selling (or at a shop that does not buy, dropping) the least valuable thing to make room.

## Orders in chat (`chat.ts`)

Only a PERSON on the party is obeyed; a computer's own lines ("wait i need a bit more health") are
news about itself and never reach the parser. A line naming a computer's hero ("optimus wait") is for
that computer alone.

| Order | Said as | Does |
|---|---|---|
| wait | wait, lets wait, hold on, stop, stay, one sec | holds where it stands, fights what comes to it |
| back | back, b, go back, fall back, retreat, run, get out | leaves the fight to the leader's side, then waits |
| go | lets go, go, come on, move, push, dont wait, stop waiting | follows again |
| follow | follow me, follow, come, come back, on me, i lead | follows (and "me"/"i lead" takes the lead) |
| attack | attack, hit, hit them, kill them, get them, charge | fights anything in sight for 40 s |

**Typos** are read the way people make them (`typoDistance`): a neighbouring key or a vowel for a vowel
is one slip, any other letter two, and a word of three letters or fewer must be exact or two letters
swapped. "wiat", "folow", "fallow", "atack", "bakc", "lets goo" are orders; "what", "shop", "yellow",
"hot" are not. "im back", "be right back", "nice hit" and "-ing" forms on their own ("im waiting") are
news. The last order in a line wins, and a negation turns one round ("dont go" is a wait).

**An order overrides its own decision.** "lets go" to a resting computer ends the rest — "ok, but im
still low" — and holds off the next one for `OBEY_HOLD`. The one thing it will not be ordered into is
its own death with no Ankh left (`NO_ANKH_FLOOR`), because on this map that is the end of the hero.
A wait the leader then walks far away from is not held for ever (`WAIT_ABANDON`).

## The difficulties (`profile.ts`)

| | Easy | Normal | Insane |
|---|---|---|---|
| looks every | 1.0 s | 0.5 s | 0.25 s |
| rests at / ready at | 22% / 60% | 33% / 80% | 40% / 90% |
| focuses (leader's target, what hits the party) | no | yes | yes |
| first swing into a fight | 1.2 s | 0.5 s | 0.1 s |
| kites with summons out | never | half the time | 90% of the time |
| spells | `PLUS_EASY` | `PLUS_NORMAL` | `PLUS_INSANE` |

## Engine facts it leans on

- `ShowUnit` is a WORLD flag (`SimUnit.hidden`): a hero whose owner drives a steam tank is off the field
  — not drawn, not selectable, untargetable, colliding with nothing — until `Player_N_Leaves_Tank` shows
  it again. `sense` skips hidden units; the tank is the body either way.
- The map's item prices (`ankh` 3000, the Deluxe `IC17` 5000) live in its `war3map.w3u`, and are read
  from there (`applyMapItemData`). The AI prices from the registry, so it agrees with the shop.

`tools/ai-plus-warchasers-test.cjs` pins the parser (orders, typos, non-orders, names, heal requests),
the item values, the picker geometry, and — on a stub world through `WarChasersAi.tick` — who a heal
goes to, the mana rule, a promised heal, and kiting.
