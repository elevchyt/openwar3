# Multiplayer — authority, transport, and the road to it

How OpenWar3 gets two browsers playing the same match, why the authority runs on the **host** rather
than on a cloud box, and what has to change in the engine first. This supersedes the sketch in
[`OpenWar3_PLAN.md`](../OpenWar3_PLAN.md) §7–8 on two points (hosting and server-side data); the rest
of §7 — delta snapshots, area-of-interest culling, no client prediction in v1 — stands.

**This file is also the progress tracker** — see [Where we are](#where-we-are) for what has landed,
what is next, and what was deferred on purpose. Update that table when a phase moves.

## TL;DR

| Decision | Choice | Why |
|---|---|---|
| Authority | **One machine owns truth; that machine is the host** | Server-authoritative semantics without a server bill |
| LAN | Host is the authority, clients connect directly | No cloud round-trip, no dependency on being online |
| Internet | Host is *still* the authority; cloud box **relays** | Relay is IO-bound → fits a free tier; sim CPU stays on hardware we don't rent |
| Dedicated cloud sim | **Deferred**, not designed out | Same authority module redeploys to a paid instance later, transport swapped |
| Determinism | **Not required for sync** | Only one machine simulates. Keep the sim clean for replays/tests |
| Downstream | Delta snapshots ~10–20 Hz, AoI-filtered | Per §7. AoI doubles as fog and as anti-maphack |
| Client prediction | **None in v1** | RTS tolerates command latency; show an "order received" tick |

## Why the host, and not a server

The plan originally put the authoritative sim on a paid Render instance. Two constraints kill that
for v1, and one design resolves both.

**Constraint 1 — free hosting.** [`OpenWar3_PLAN.md`](../OpenWar3_PLAN.md):1000 already says it:
Render's free tier "spins down after 15 min + shared CPU — unsuitable for live authoritative matches."
That is correct. A free instance is roughly a tenth of a shared vCPU; [`src/sim/world.ts`](../src/sim/world.ts)
runs several per-unit passes per tick over a 9,600-line `SimWorld`. It will not carry a 20 Hz match.
Railway's free offering is a one-time credit, not an ongoing plan. **"Server-authoritative + free
hosting" is not reachable as literally stated.**

**Constraint 2 — the legal boundary, which the plan contradicts itself on.**
[`OpenWar3_PLAN.md`](../OpenWar3_PLAN.md):1000 forbids "copyrighted assets on any server you control"
and rates the risk **Critical**. But an authoritative sim needs unit stats to run, and
[`src/data/`](../src/data/) holds **SLK loaders, not tables** — `loadUnitRegistry(vfs)` reads
`Units\UnitBalance.slk` and friends out of the user's MPQs at runtime. A cloud authority therefore
cannot function without Blizzard data it is barred from hosting. The workaround (host uploads derived
registries at match start, RAM-only, never persisted) is real but materially harder.

**Host-as-authority resolves both at once.** The sim runs on a machine we don't rent, and the Blizzard
data never leaves the machine that already legally holds it. The cloud box degrades to a relay and
lobby directory: sockets, rooms, and NAT introduction. That is IO-bound work a free tier is genuinely
good at.

Everything the developer asked for from "server-authoritative" survives intact:

- exactly **one** machine owns game state; clients send commands and render what they are told;
- **reconnect** works — the authority holds the state and answers a rejoin with a full snapshot;
- **AoI filtering** still means a client is never sent what it cannot see.

### What we are accepting

Say these out loud rather than discovering them later:

- **Host latency advantage.** The host's own orders apply at zero RTT. Real in an RTS. Mitigable by
  making the host buffer its own input by the median peer RTT — deliberately handicapping the host to
  match the room. Worth doing before anything competitive.
- **Host disconnect ends the match.** No migration in v1. Host migration is a large feature (state
  handoff mid-match) and is explicitly out of scope.
- **The host can cheat.** They hold full state. Acceptable among friends; unacceptable for ranked.

All three are answered by the *same* module redeploying to a dedicated paid instance when there is a
reason to pay. That is the migration path, and it is why the authority must be written
transport-agnostic (see Phase E).

## Shape of the thing

```
  LAN                      Internet                     Later (paid)
  ───                      ────────                     ────────────
  host ── authority        host ── authority            cloud ── authority
   │                        │                            │
   └── client(s)            └── relay(cloud) ── client   └── client(s)
                                 lobby/rooms/NAT
```

One `Authority` implementation in all three columns. It must not import a transport, a DOM, or a
renderer — only `SimWorld`, the registries, and a command stream in / snapshot stream out.

## Where we are

Progress tracker — update this when a phase moves. Everything below it is the plan; this is the
state.

| Phase | State | Notes |
|---|---|---|
| A — timestep & identity | **done** | fixed 60 Hz step, `.doo`-order ids, seed from the lobby |
| Relay + transport + LAN lobby | **done** | rooms, discovery, join, roster |
| Map selection + Start | **done** | create screen, map summary, `start` handshake, both clients enter |
| B — bisect `rts.ts` | **done** | authority split into `authority`/`formations`/`placement`/`simView`, all compiling standalone; `rts.ts` 5 382 → 4 227 |
| C — command funnel | **done** | 15 player actions through `execute(player, cmd)`; `Command` is the wire type |
| D — N vision maps | in progress | item 1 done (committed `?dev` boot, two clients); items 2–7 open |
| E — snapshots & reconnect | not started | also inherits the 151-entry [JASS hook table](#the-jass-hook-table) split, which needs the headless boot first |

**Shipped so far** (newest first — `git log` for detail):

- Phase B: `rts.ts` bisected — `authority.ts` (the gate + economy + ownership), `formations.ts`,
  `placement.ts` and `simView.ts` on the authority side; `worldOverlays.ts` and `unitAnims.ts`
  moved out to the renderer. All four authority modules compile standalone. `rts.ts` 5 382 →
  4 227; `document`/`window`/`../ui/*` gone from it entirely
- Phase C: `Command` (`src/game/commands.ts`) + `RtsController.execute` — all eleven player
  actions now go through one gate, and `stop`/`hold` joined `QueuedOrder`
- map selection + Start: `LocalMultiplayerCreate.fdf` as its own screen, the map summary pane
  on the LAN screen, and the `start` handshake that puts both clients in the same match
- `5a0ec84` sim ids come from war3mapUnits.doo order, not model-load order
- `97d58be` match seed plumbed from the lobby; hero-name draw onto the seeded stream
- `d4a658c` fixed 60 Hz timestep with a tick counter
- `be9285c` relay, transport seam, LAN screen (create / discover / join / roster)
- FDF fixes that fell out of the LAN screen: `5187945`, `b80df35`

**Tests:** `pnpm relay:test` (relay flow + the `start` handshake, headless) and `pnpm sim:test`
(181 checks, including `sim-determinism-test.cjs` — same seed reproduces, different seed diverges —
and `sim-order-funnel-test.cjs` for Phase C). Both green. `pnpm jass:test` needs `pnpm data:extract`
first; it reads the unpacked `Scripts/common.j` and fails without it.

**Pick up here.** Phase B is **done** — see [what it proves](#phase-b-is-done-what-it-proves).
Next is **Phase D** (one `VisionMap` per vision group), which also inherits the fog modifiers,
`cripplePlayer` and `seesFor`/`exposed` that Phase B declined to split early. Its
[remaining-work list](#remaining-work-in-order-1) is written and is the handoff; its **item 1** is the
committed headless boot path, pulled forward from Phase E because Phase D is the first phase no
headless test can verify. The [JASS hook table](#the-jass-hook-table) split depends on that boot path
too, and stays in Phase E.

### The `simWorld` escape hatch

`RtsController.simWorld` is a public getter handing out the whole authoritative `SimWorld`.
136 uses, **all of them in [`src/render/mapViewer.ts`](../src/render/mapViewer.ts)** — one consumer,
not a scattering, which is the good news. They are not all the same thing:

| Kind | Count | Verdict |
|---|---|---|
| JASS `EngineHooks` (`textHooks`, lines ~1396–1760) | ~66 | Authority-side by nature; JASS runs on the authority. Misplaced (it lives in the renderer) but not a bypass. Genuinely mixed — `SetUnitOwner` sits next to `PanCameraTo` — so it cannot be moved wholesale. |
| Read-only lookups (`units`, `mines`, `items`) | ~25 | Fine in principle. Becomes a read-only snapshot view under AoI (Phase E). |
| **Player commands bypassing `execute()`** | ~13 | **All closed.** Build placement, battlestations, standdown, cancel building / train / research all go through the gate. |
| **Direct stash mutation via `stashFor()`** | 14 | **Was the worst of it. All 14 are gone**, and `stashFor()` now returns a frozen copy, so they cannot come back. |
| Setup (`initStash`, `setPathStamp`) | few | Fine. |

**Phase C audited the wrong file.** It swept `rts.ts` and found 15 actions. But player commands
also originate in `mapViewer.ts` — the command card and build placement are there — and those never
went through the funnel at all.

**The economy runs client-side.** `stashFor()` returns the *live, mutable* stash object out of the
sim, and the renderer writes to it in 14 places: it checks affordability, deducts gold and lumber,
and issues refunds on cancel, all before telling the sim anything. Over the wire every purchase and
every refund would be the client's decision. Build placement additionally posted the price it had
charged *into* the `buildnew` order, which the sim trusts for the abandon-refund — the same shape as
the repair-rate bug, so the client set both what it paid and what it got back.

**Done:** `build` — placement now carries intent only; `execute` looks the cost up, checks
affordability, charges, and issues the order.

**Done:** `train` — the command carries only *which building, which unit*. The cost, the build
time and the **free first hero** are all derived authority-side; `freeHeroUsed` moved onto
`RtsController` (a client that kept that set could hire a hero a game for free). `execute` also
now asks the question the old call site never did — *does this building even train that?* — since
the command card was the only thing enforcing it and the card does not cross the wire. What stays
in the renderer is a feedback-only pre-check, so a refusal still says *why* in the game's voice.
One transitional hole: `RtsController.restoreFreeHero`, which cancel-train still needs until (2).

**Done:** `research` and `upgradebuilding`. Neither call site checked ownership *at all* — the
command card was doing it by construction, since you are only shown your own building's card.
`research` also derives the **level**, which is the subtle half: an upgrade's price climbs per
level, so a client naming its own level would buy Steel Forged Swords at Iron's price.
`upgradebuilding` computes the tier DIFFERENCE (Stronghold over Great Hall = 315/190) from both
registry entries rather than trusting the renderer's subtraction. Both keep a feedback-only
pre-check in the renderer so a refusal still names the resource.

**Done:** the refunds — `cancelbuild` and `canceltrain`. **`stash.gold`/`stash.lumber` are now
never written in `mapViewer.ts`**; every remaining mention is a read (button greying, the
"Not enough gold" refusal). `MISC_GAME` is no longer imported there at all — the economy's
constants live only where the economy is decided. `restoreFreeHero` is gone, absorbed into
`canceltrain`. `cancelbuild` no longer takes a typeId from the client's selection: it used to,
so cancelling a Farm while naming a Castle refunded a Castle.

**Done:** `battlestations` and `standdown` — the last two ungated card actions. A full
callee-enumeration sweep now shows **no player action left outside `execute()`**: of the
`simWorld.*` uses remaining in `mapViewer.ts`, everything outside the JASS hook block is a read,
except `initStash` and `setPathStamp`, which are setup. `src/ui/` touches neither `simWorld` nor
`stashFor`.

**Done:** `stashFor()` returns a **frozen copy**. The ratchet is on — a renderer can no longer
spend, and an attempt fails loudly rather than mutating a throwaway in silence. That `pnpm
typecheck` stayed clean through the change is itself the proof that every remaining use is a
read.

**Remaining, in order:**

1. Narrow the `simWorld` getter itself — hooks to an authority module, reads to a view interface.
   This is the last piece, and unlike everything above it is a **refactor, not a bug**: no player
   action goes around the gate any more. It is now tracked as **item 7 of
   [Phase B's list](#remaining-work-in-order)**, because it is the same question as "where do
   these ~66 JASS hooks actually live" and cannot be answered before `rts.ts` is bisected.

**Two things that looked like blockers and are not.**

*Serializing the acting group* was raised as a decision (does a command carry its unit set, or does
the client emit N per-unit commands?). It is already answered, by construction: the formation
solvers run client-side off `this.selected` and emit **self-contained per-unit commands**, each with
its own resolved destination. `groupTargets` reads only `sim.units` and `sim.grid` — no client state
beyond the ids handed to it — so it could move authority-side later if wanted, but nothing needs it
to. The invariant that matters is that `execute` reads no client state, which it does not.

*Unit-type metadata living on the render `Entry`* was raised as a headless-authority hazard. Mostly
a non-issue: `SimUnit` already carries `typeId` and `race`, so the authority never needed `Entry`.
The remaining `byId.get(id).typeId` lookups are all in `playImpacts`, which is client-side sound and
is *better* off `Entry` — a unit that just died still has its render record when its death sound
plays, but is already gone from `sim.units`.

Phase C is done: all eleven player actions go through `RtsController.execute`, and `Command`
([`src/game/commands.ts`](../src/game/commands.ts)) is the type that will go on the wire. Nothing
is *sent* yet — that is Phase E — but there is now exactly one place to send from, and exactly one
place that decides whether a command is allowed.

**What "Start" does and does not do today.** Both clients load the same map, seat themselves in
different slots off one shared config, and run off one seed — so the two windows open on the same
world, each looking at its own base. Nothing is sent after that: each machine then simulates
independently and they drift apart within seconds. Phase C has since given every player action one
door to leave by (`execute()`), but nothing yet carries it to the other machine — that is Phase E.
The point of landing Start first is that the identity of a match (map, slots, seed, who is who) was
settled and testable before any command crossed the wire.

**Map files never cross the wire.** A room advertises its map's PATH and every client opens that
path in its own install ([`src/net/protocol.ts`](../src/net/protocol.ts) `RoomInfo.mapPath`). This
is the legal boundary (CLAUDE.md — we ship and host zero Blizzard content) and it is also the only
affordable option: a map is megabytes and the relay is meant to fit a free tier. A player whose
install lacks the map is told so on the LAN screen and cannot join.

**Deliberately deferred**, with reasons, so nobody re-derives them:

- **Render interpolation.** `rts.ts` pushes sim positions straight onto model instances, so the sim
  rate IS the animation rate — hence 60 Hz rather than a lower net rate. Interpolating the sync loop
  would allow 20–30 Hz and cut CPU per hosted match, but it is a real refactor of a 4 900-line file
  and nothing is blocked on it.
- **Transcendental determinism.** The ~146 `Math.hypot`/`atan2`/`sin`/`cos` calls in
  [`src/sim/`](../src/sim/) are not bit-exact across JS engines. Irrelevant here — only one machine
  simulates. It would resurface only if cross-machine replay verification is ever wanted.
- **Host input delay and NAT strategy.** See Open questions.

## What has to change in the engine

Sequenced. Phase B is the tentpole; everything downstream depends on it.

### Phase A — timestep and identity hygiene — **done**

Needed regardless of topology, and it also buys replays. What landed, and the traps found:

1. **Fixed timestep.** [`src/render/mapViewer.ts`](../src/render/mapViewer.ts) now accumulates and
   retires whole `SIM_DT` (1/60) steps, counting them in `simTick` — the number a command attaches
   to. This subsumed the old `Math.min(dt, 50)` clamp (issue #24). `MAX_STEPS_PER_FRAME` caps
   catch-up so a stall cannot spiral. [`src/sim/world.ts`](../src/sim/world.ts):28 had *claimed*
   fixed-timestep since it was written; it was aspirational until this.
2. **Entity ids from the map, not the loader.** Ids were allocated as the viewer finished loading
   each model — disk/network/cache order, i.e. one machine's I/O timing. They now come from the
   unit's index in `war3mapUnits.doo` (`setPlacedOrder` / `reserveIdAt` in
   [`src/game/rts.ts`](../src/game/rts.ts)), reserved before any model loads; dynamic units continue
   above that block. **Trap:** `addUnit`'s `reservedId` means "the sim unit already exists, just give
   it a body" and returns -1 otherwise — pre-placed units need their id at creation and go through
   `addSimUnit`. Routing them through `addUnit` looks right and silently seeds nothing.
3. **Seed plumbing.** `MeleeConfig.seed` → `RtsController.setSeed` → `SimWorld.reseed`, applied at
   `beginMatch`: after the world exists, before any unit is seeded, which is the last safe moment.
   Every match had previously run off a hardcoded `1`.
4. **The hero-name draw** now uses `sim.random()`; it is written into sim state and shown to every
   player. The other two `Math.random()` calls (animation variants) are pure render and stay.

### Phase B — bisect `rts.ts`

[`src/game/rts.ts`](../src/game/rts.ts) is 5 382 lines and mixes concerns that must end up on
opposite sides of the wire:

| Authority-side | Client-side |
|---|---|
| vision rebuild, alliances | model instance sync, animation |
| unit seeding / spawning | portraits, HP bars, hover tips |
| order validation (`ownedBy()`), `execute()` | selection, command card |

This is the largest single refactor in the path. The sim underneath is already clean —
[`src/sim/`](../src/sim/) imports no DOM, no renderer, no VFS, and `pnpm sim:test` already compiles
`world.ts` standalone and drives it in Node. The bridge is the problem, not the core.

**Two seam tests**, applied to every move:

- **Import test.** The authority half may not import `mdx-m3-viewer`, `../ui/*`, or touch
  `document`/`window`. `grep -c "WidgetState\|worldLayer" src/game/rts.ts` is **20** at the start of
  Phase B. It must fall and never rise.
- **Client-state test.** The authority may not read `this.selected`, `this.primary`, `this.armed*`,
  `this.hovered`, `this.orderMode` or `this.localPlayer`/`this.localTeam`. `execute()` and
  `applyOrder()` already satisfy this.

#### The inventory

Every method in the class was classified by which fields its body actually touches (client:
`byId`/instances, selection, DOM, armed/hover, `localPlayer`/`localTeam`, camera — authority:
`this.sim`, `this.vision`, `this.alliances`). Three piles came back.

**Clean client** — instances, animation, camera, picking, selection, DOM overlays, the info card.
Roughly 2 000 lines. Nothing on this side is contentious; it is where the file's bulk lives.

**Clean authority** — touches `this.sim` and *no* client field at all: `execute`, `applyOrder`,
`notePlayerOrder`, `heroTypesInProduction`, `hasFreeHero`/`freeHeroUsed`, `ownedBy`, `castOrder`,
`issueUnitOrder`, `currentOrderId`, `resolveRally`, `rallyFeedback`, `stashFor`, `countOwned`,
`foodFor`, `groupTargets`, `ringTargets`, `followOffsets`, `buildCreepCamps`, `markerFor`,
`itemInfo`/`mineInfo`, `adoptPlacedFootprint`, `teamOfPlayer`, the alliance delegators and the
whole `FogModifier` block. Roughly 900 lines, already free of client state.

**Genuinely mixed** — the real content of this phase. For each, *why* it is mixed and where the cut
goes:

| Method | Why mixed | Where the cut goes |
|---|---|---|
| `tick` (191 L) | steps the sim AND syncs every model instance in the same loop | sim-advance + death/removal bookkeeping is authority; the per-`Entry` instance/animation body is client. The cut is the loop body, not the loop. |
| `trySeed` / `seedNeutral` / `seedPlayerUnit` (278 L) | seeding CREATES sim units (authority) but is driven by model-load order and attaches instances | already half-cut: `addSimUnit` is the authority half, `addUnit`/`attachInstance` the client half. The scan itself is client-driven and must invert — the authority seeds from the `.doo`, the client attaches bodies later. |
| `moveAt` (167 L) / `orderClickAt` (132 L) | resolve a target from a **screen click** (client) then emit commands | already funnelled through `execute`; everything before the `execute` call is client and stays. Documented, not moved. |
| `controls` vs `ownedBy` | same question asked of two different subjects | **already cut and documented in the code.** No work. |
| `updateVision` / `fogHides` / `applyFogTint` / `revealsForLocal` / `seesFor` / `invisHides` | one `VisionMap`, and it is the local team's | not a Phase B move — this is **Phase D**. Leave alone. |
| `getVision` | authority state handed to the renderer wholesale | narrows with Phase D, same as `simWorld`. |
| `simWorld` getter | 136 uses in `mapViewer.ts`; ~66 are JASS `EngineHooks` (authority, misplaced) and ~25 are reads | pairs with move 7 below. |

#### Remaining work, in order

Smallest and least-entangled first; each is independently shippable. **Behaviour-preserving only** —
if a real bug turns up mid-move, note it here as its own item rather than fixing it in the same
commit.

1. ~~**Formation solvers → `src/game/formations.ts`.**~~ **Done.** `groupTargets`, `ringTargets`,
   `followOffsets` (210 L) now take a `FormationWorld` — a two-member interface
   (`units`, `grid`) narrowed deliberately, so the file compiles with no dependency on the
   bridge and structurally accepts `SimWorld` unchanged. `rts.ts` 5 382 → 5 170 lines.
2. ~~**HP-bar + hover-tooltip DOM → `src/render/worldOverlays.ts`.**~~ **Done.** `WorldOverlays`
   owns the pooled bar elements, the hover slab and the projection; `rts.ts` keeps the two
   *queries* (which units get a bar, what the slab says) and hands the answers over as
   `BarSpec[]` / `HoverTip`. **`rts.ts` now contains no `document`, no `window`, and no
   `../ui/*` import at all** — the import test's whole point. Seam count 20 → 17.
   The cut landed one notch further back than this entry predicted: `computeHoverTip` stayed
   in the controller rather than moving, because it reads `hovered`, `localPlayer`,
   `alliances`, the registries and the fog tests — passing all of that across a boundary
   would have been worse coupling than the DOM it was mixed with. Data crosses; state does not.
3. ~~**Animation resolution → `src/render/unitAnims.ts`.**~~ **Done.** `AnimSet`,
   `applyAnimProps`, `animPropsFor`, `buildAnimSet`, `findBirthFields`, `pickSequence`,
   `attackAnimRate`, `walkAnim`, `seqDuration`, `setAnimRate` (302 L). All nine bodies moved
   **byte-identical** (verified by diffing against `git show HEAD:src/game/rts.ts`); only the
   receivers changed — `Entry` → a seven-member `AnimEntry`, `Instance` → a one-member
   `SeqSource`. The anim CONSTANTS stayed put: `DEATH_CLIP_FALLBACK` and friends are passed in
   as arguments at their call sites, so they belong to the caller. rts.ts 5 024 → 4 722.
4. ~~**Map-placement metadata → `src/game/placement.ts`.**~~ **Done.** `PlacedIndex` owns the
   six `.doo` registries (neutral-passive sites, placed order + reserved ids, creep data,
   player seeds, footprints) and their 48u lookups, plus `PlacedRef`. Ten of the eleven bodies
   moved byte-identical; `adoptPlacedFootprint` split into `claimFootprintAt` (search + claim,
   authority data) and the `sim.setPathStamp` call, which stayed with the controller. The
   renderer's public setters are unchanged — `rts.ts` keeps them as one-line delegators — so
   `mapViewer.ts` did not move at all. rts.ts 4 722 → 4 624.
   **`buildCreepCamps` did NOT move, and the earlier entry was wrong to list it.** It reads
   `this.entries` — RENDER records, for `e.level` and `e.simId` — and groups already-seeded
   creeps for the minimap. That is a post-seeding view over render state, not `.doo` metadata,
   so it is client-side and belongs where it is. Its `e.level` dependency is worth revisiting
   under item 6 (`SimUnit` carries a level too), but not as a move.
5. ~~**Fog modifiers + alliances → a `PlayerRelations` module.**~~ **Dissolved — this was not a
   real move, and inventing the module would have made things worse.** Three findings, each
   checked against the code rather than assumed:

   - **Alliances are already across the seam.** `AllianceTable`
     ([`src/sim/alliances.ts`](../src/sim/alliances.ts)) has **zero imports** and holds the whole
     per-pair matrix. `seedAlliances` / `setPlayerAlliance` / `getPlayerAlliance` /
     `playersAreCoAllied` on `RtsController` are one-line pass-throughs that exist only as the
     JASS `EngineHooks` surface. A `PlayerRelations` wrapper would make the chain
     `mapViewer hook → rts delegator → PlayerRelations delegator → AllianceTable` — a third
     layer of indirection over a module that is already clean. Nothing to move.
   - **The fog-modifier block's cut is the Phase D line, not a Phase B line.** The storage
     (`fogModifiers` map, id counter, start/stop/destroy) looks authority-shaped, but its only
     consumer is `updateVision`, which gates every modifier on `seesFor(m.player)` — i.e. on
     `localPlayer`/`localTeam` — and stamps it into `this.vision`, the single local-team
     `VisionMap`. Storage cannot be separated from application until there is more than one
     vision map to apply it to, and deciding that shape **is Phase D**. Splitting it now would
     mean designing Phase D inside a Phase B commit.
   - **`cripplePlayer` is client by construction**, as its own comment already says: it writes
     `this.exposed`, read only by `fogHides`, `fogBlocksClick` and `applyFogTint` — all
     one-viewpoint. It becomes per-recipient in Phase D/E alongside `GetLocalPlayer`.

   **Handed to Phase D**, which is where these actually belong: the `FogModifier` map and
   `setFogState` need one owner per vision group, and `seesFor`/`cripplePlayer`/`exposed` need
   to resolve per snapshot recipient rather than against "local".

6. **The authority core → `src/game/authority.ts`.** The tentpole, split into two commits on the
   developer's call, because ~450 lines including `execute()` is not a reviewable diff.

   **6a — the leaves. Done.** `Authority` now holds `ownedBy`, `stashFor`, `countOwned`,
   `foodFor`, `hasFreeHero`/`takeFreeHero`/`restoreFreeHero` (+ the `freeHeroUsed` set),
   `heroTypesInProduction`, `notePlayerOrder`, `castOrder`, `currentOrderId`, and the
   `cheatFoodBonus` map. It imports `SimWorld`, two registries and `ORDER_IDS` — **no renderer,
   no DOM, no transport** — and reads **no client state**. Seven of the nine moved bodies are
   byte-identical; `foodFor` changed deliberately (below) and the free-hero set gained named
   accessors instead of being poked directly. rts.ts 4 624 → 4 484.

   **6b — the gate. Done.** `execute()` (252 L) and `applyOrder()` are in `Authority`, both
   byte-identical modulo the receiver rewrite, along with `TAVERN_HIRE_TIME`. `Authority` took
   `TechRegistry` and `UpgradeRegistry` to go with them. **`applyOrder` is now `private` to
   `Authority`**, so "nothing reaches `applyOrder` except `execute`" is a rule the compiler
   keeps rather than one a grep polices — `rts.ts` has zero mentions of it. `RtsController`
   keeps one-line delegators for the surface the renderer and JASS call (`execute`, `stashFor`,
   `countOwned`, `foodFor`, `hasFreeHero`, `currentOrderId`), so all 37 emit sites and
   `mapViewer.ts` are untouched. rts.ts 4 484 → 4 209; authority.ts 518.

   **`resolveRally` and `rallyFeedback` are NOT part of this** — the list was wrong to include
   them, for the third time in the same way. `resolveRally` takes `(cssX, cssY)` and calls
   `pickAt`/`groundPoint`/`treePickPoint`: it turns a MOUSE CLICK into a rally target.
   `rallyFeedback` calls `flashTarget`/`queueArrow`. Both are client and stay.

   **`foodFor` was computing the authority's supply cap from render records** — it iterated
   `this.entries` for `e.foodUsed`/`e.foodMade`, and `SimUnit` carries no food fields at all,
   so on a headless host every player would have had infinite supply. It now reads
   `sim.units` + `registry.get(u.typeId)`. The two agree for anything a player can own, since
   an `Entry`'s food is copied from that same registry row at seed time. The one divergence is
   `seedNeutral`, which writes 0/0 over the def: harmless (neutrals are filtered by owner), but
   a unit handed to a player by JASS `SetUnitOwner` now contributes its real food instead of
   zero — which is the correct reading.
7. **Narrow the `simWorld` getter.** Split in two, as this entry predicted.

   **7a — the read-only view. Done.** [`src/game/simView.ts`](../src/game/simView.ts) `SimView`
   is 21 members, all reads, with `ReadonlyMap` for `units`/`mines`/`items`; `SimWorld`
   satisfies it structurally. `RtsController.simView` exposes it and **55 renderer uses moved
   across** — `simWorld` in `mapViewer.ts` went **127 → 70**. `stashOf` is deliberately NOT on
   the view, so the two live-stash *reads* in the JASS hooks now go through the frozen
   `stashFor()` instead.

   The `readonly` types earned their keep immediately: they caught two sites the
   by-name scan had filed as reads. `SetTimeOfDay` and `SuspendTimeOfDay` **write**
   `timeOfDay`/`dawnDusk`, so they stayed on `simWorld`. That is the fourth misclassification
   this phase, and the first one a type caught rather than a person.

   **7b — the hook table. MOVED TO PHASE E** (developer's call, after the inventory below).
   See [The JASS hook table](#the-jass-hook-table).

8. ~~**Flip the phase table.**~~ **Done.**

#### Phase B is done. What it proves

The four authority-side modules pass both seam tests, and — the check that actually matters —
`tsc` compiles all four **standalone**, so no renderer, DOM or transport is anywhere in their
import closure:

| Module | What it owns |
|---|---|
| [`authority.ts`](../src/game/authority.ts) (519 L) | `execute()`, `applyOrder()` (private), ownership, economy, supply, hero rules, order plumbing |
| [`formations.ts`](../src/game/formations.ts) (234 L) | group/ring/follow destination solvers |
| [`placement.ts`](../src/game/placement.ts) (154 L) | the `.doo` registries and the sim ids they reserve |
| [`simView.ts`](../src/game/simView.ts) (51 L) | the read-only window the renderer draws from |

`rts.ts` went **5 382 → 4 227** lines; `WidgetState|worldLayer` **20 → 17**; `document`,
`window` and `../ui/*` are **gone from it entirely**; `simWorld` in the renderer **127 → 70**.
`applyOrder` being `private` to `Authority` turned Phase C's central invariant from a grep
into a compiler rule.

**A lesson worth keeping**, since it cost four corrections: methods were repeatedly misfiled
by what their NAME suggests rather than by what their consumers actually read —
`buildCreepCamps` (reads render records), all of item 5, `resolveRally`/`rallyFeedback` (take
`cssX, cssY`), and `SetTimeOfDay`/`SuspendTimeOfDay` (write, not read). Only the last was
caught by a type rather than by a person. Run the dependency scan *before* the move, and
prefer `readonly` types over greps.

### The JASS hook table

`MapViewerScene.textHooks()` builds a **151-entry** `EngineHooks` table inside the renderer.
It is thoroughly mixed: `setUnitOwner`, `getUnitX` and `createItem` sit among `pingMinimap`,
`showInterface`, `selectUnit` and `clearSelection`. The interpreter is authority-side and runs
on the host once, so a headless host needs a hook table — and today one can only be built by a
renderer.

**This is Phase E work, not Phase B.** Two reasons, both established by inventory rather than
assumed:

- Routing the ~54 world-mutating natives through `Authority` methods would add ~54
  pass-throughs over an already-clean `SimWorld` — the same shape rejected in item 5 — and
  would NOT help, because the table would still be constructed inside the renderer.
- The move that helps is extracting the table into its own module, built from
  `(SimWorld, Authority)` with the presentation entries injected by whoever is drawing. Its
  interface is determined by what the headless boot path looks like, and **there is no
  committed headless boot path** (see [Boot](#boot) — `?dev=` is a temp local patch and the
  load gate needs a human gesture). Designing the interface before the boot exists is guessing.

Also noted while inventorying: `SetPlayerState` writes the live stash
(`sw.stashOf(p).gold = value`). Legitimate as a JASS native — it is the authority acting — but
it is the last live-stash write anywhere in the renderer, and it wants to become an `Authority`
method when the table splits.

**Noted, not fixed** (found during the inventory; each is its own item, none is a Phase B blocker):

- *(none yet)*

### Phase C — close the command funnel

[`src/sim/world.ts`](../src/sim/world.ts):495 defines `QueuedOrder`, a discriminated union of plain
JSON with numeric IDs and no object references. **It is already a wire format**, by accident.

[`src/game/rts.ts`](../src/game/rts.ts) `order()` is the ownership choke point — its own comment
calls it "the single choke point that keeps enemy/neutral/creep units uncommandable." But it is **not
exhaustive**.

**The real audit** (`grep -n 'this\.sim\.\(issue[A-Z]\|useItem\|dropItem\|setShopBuyer\|toggleAutocast\|stop\)' src/game/rts.ts`,
excluding the JASS path and `order()`'s own internals) is **eleven** player actions, not the six an
earlier draft of this file listed — it missed `useItem` in both its modes, `dropItem`,
`toggleAutocast` and `stop`. They fall into three groups, and the third is the one that shapes the
wire format:

| Group | Actions | Shape |
|---|---|---|
| **Queueable unit orders** | `stop`, `issueCast`, `issueGarrison`, `issueGetItem` | new `QueuedOrder` members |
| **Inventory actions** | `useItem` (point + instant), `dropItem`, `issueSellItem`, `issueGiveItem` | new `QueuedOrder` members, all keyed by inventory **slot** |
| **Not unit orders at all** | `setShopBuyer`, `toggleAutocast` | **do not fit `QueuedOrder`** |

**All eleven are now closed**, but note what "closed" had to mean. The first pass routed the direct
*sim* calls into `execute()` and left `order()` reachable on its own — and fourteen call sites took
that door, including move, attack, attack-move, harvest, patrol, follow and repair. Closing the sim
calls was only half the job: `order()` was itself a bypass, and the commonest orders in the game were
going through it. It is now `applyOrder`, private, and reached only from `execute`'s `order` member.

**Do not audit this with an enumerated grep.** A pattern listing the methods you already know
about can only ever confirm what you already knew, and it missed something all three times it was
used here: first `issueUnitOrder` (miscategorised), then `order()` itself (not a `this.sim.` call at
all, and fourteen sites went through it), then `setRally` / `swapItems` / `learnAbility` (simply not
in the pattern). The count went 6 → 11 → 14. Enumerate the callee instead and classify what comes
back:

```
# every sim method rts.ts calls, by frequency — then ask of each: is it a PLAYER action?
grep -o 'this\.sim\.[a-zA-Z]*(' src/game/rts.ts | sed 's/this\.sim\.//;s/(//' | sort | uniq -c | sort -rn

# and: nothing may reach applyOrder except execute()
grep -n 'this\.applyOrder(' src/game/rts.ts   # expect exactly one hit, inside execute()
```

**`QueuedOrder` is not the whole wire format.** This file used to say it "is already a wire format,
by accident", which is true but incomplete: it is the wire format for *orders a unit performs and
can queue*. `setShopBuyer` is a player's choice about a **shop** it does not own (that is the whole
point of a neutral Goblin Merchant) and `toggleAutocast` is a **toggle on an ability**, not an
order — neither is queueable and neither is addressed to a unit as an order. So the command stream
has to be a union one level up. That is [`src/game/commands.ts`](../src/game/commands.ts) `Command`,
and [`src/game/rts.ts`](../src/game/rts.ts) `execute()` is the one place it is applied — and so the
one place ownership is judged. A command says what was *asked for*, never who may ask; when these go
over the wire, a peer that fakes a `unitId` it does not own is refused there rather than trusted.

Every one of these must be expressible as a command before the wire exists, or those actions
silently become host-only.

**`issueUnitOrder` is NOT one of them** — an earlier draft of this file listed it as an eighth
bypass and that was wrong. It is reached only from the JASS natives through `EngineHooks`, and the
interpreter runs on the authority, once (see [JASS](#jass) below). A trigger order is therefore an
*effect of* the authoritative sim rather than an input to it: host-only is correct there, gating it
on ownership would break every map script, and replays re-derive it from the seed rather than
recording it. Only cross-machine replay *verification* would overturn that, and it is deferred
(see the transcendental-determinism note above).

### Phase D — one `VisionMap` per vision group

Today there is exactly **one** `VisionMap` and it is the local team's — `private vision!: VisionMap`
in [`src/game/rts.ts`](../src/game/rts.ts), built once in the constructor, with every read
short-circuiting on `this.localTeam`. AoI filtering (Phase E) needs one per player.
`VisionMap` ([`src/sim/vision.ts`](../src/sim/vision.ts)) takes `(originX, originY, width, height)`
and is cleanly instantiable N times, so **this is instantiation and wiring, not redesign**. Rebuilds
are already throttled to 10 Hz.

*(Line numbers are deliberately absent from this section. The ones that used to be here were written
before Phase B moved ~1 150 lines out of `rts.ts` and were all wrong by the time anyone read them.
Grep for the names instead — they are all distinctive.)*

#### The inventory — what actually reads the local viewpoint

`grep -n "localTeam\|localPlayer" src/game/rts.ts` returns ~60 hits. They are **not** one thing.
Classified by what each site's consumers actually read:

**Stays client-side — "which viewpoint is this machine rendering?"** (~45 sites, no change needed)

- The `localPlayer`/`localTeam` fields themselves, `setLocalPlayer`, `setLocalTeam`.
- Every `this.execute(this.localPlayer, …)` call (~35 of them). Phase C already made `execute` take
  the acting player; the argument being the local one is exactly right — this is "the human at this
  keyboard issued a command".
- Ownership tests behind local UI: drag-box selection, subgroup/hero hotkeys, order voice lines
  (buildings don't voice), idle-worker cycling, the command-card owner check, cursor category,
  `ownedBy(this.localPlayer, …)`, the cheat codes (`addFoodBonus`, `stashOf`).

**Needs a viewpoint parameter — "may THIS player see that?"** (the actual work)

`seesFor`, `revealsForLocal`, `fogHides`, `fogBlocksClick`, `fogBlocksMine`, `fogBlocksItem`,
`itemVisible`, `pruneFogged`, `invisHides`, `applyFogTint`, the summon/illusion tells in the
selection payload, the attack-reveal team filter inside `updateVision`, `setFogState`,
the fog-modifier stamping loop, the `exposed` set, `dots()`, `creepCamps()`, `minimapIcons()`.

**A category of its own — `sim.visibleToTeam`.** Installed in the constructor as
`team !== this.localTeam || this.vision.stateAt(x, y) === FogState.Visible`. This is **not** a
viewpoint: it is the sim's authoritative auto-acquisition gate (issue #17), and today every
non-local team passes through as "sees everything" because no grid exists for them. Once N maps
exist it must consult the real one — at which point it stops being viewpoint code and becomes
authority state. It is the one item in this phase that **deliberately changes behaviour** (enemy
creeps currently aggro through fog and will stop), so it is last and gets its own verification.

#### Remaining work, in order

1. ~~**The headless boot path.**~~ **Done.** [`tools/vite-plugin-dev-install.ts`](../tools/vite-plugin-dev-install.ts)
   serves the developer's own install at `/wc3/manifest.json` and `/wc3/file?path=…`;
   [`src/dev/devBoot.ts`](../src/dev/devBoot.ts) fetches it and boots straight into a match.
   `?dev&map=EchoIsles&player=1&seed=4242&fog=unexplored`. Two browser contexts on the same map and
   seed with different `player` values are two clients in one world, which is how the rest of this
   phase gets verified.

   **Gating — two independent structural gates, neither a runtime flag.** The plugin carries
   `apply: "serve"`, so Vite never loads it for `pnpm build`; `main.ts` branches on
   `import.meta.env.DEV`, a compile-time constant Vite folds to `false`, taking the dynamic
   `import("./dev/devBoot")` with it. The route is not disabled in production, it is *absent* from
   it. Proof, and it is worth re-running if anyone touches this: `pnpm build` then grep `dist/` for
   `wc3/manifest`, `devBoot`, `OPENWAR3_INSTALL` — zero hits, while the *other* dynamic import in
   `main.ts` (`menuDebug`) still emits its own chunk, so dynamic imports plainly do survive the
   build and this one's absence is the fold working rather than luck.
2. **Extract a `Viewpoint`** (new file, `src/game/viewpoint.ts`). One object owning one `VisionMap`
   plus the `exposed` set and the fog modifiers that bear on it, exposing `seesFor(player)`,
   `revealsFor(u)`, `fogHides(u)`, `fogBlocksClick(u)`, `fogBlocksAt(x, y)`, `isExplored(x, y)`.
   `rts.ts` keeps a single `private local: Viewpoint` and every current call becomes
   `this.local.…`. **Zero behaviour change, zero new maps.** This is the move that makes items 3–7
   one-liners instead of seventeen scattered edits.
3. **A `VisionSet` registry** — `viewpointFor(player)`, creating on demand, each rebuilding at its
   own 10 Hz. The local player's viewpoint becomes `viewpointFor(this.localPlayer)`. Still exactly
   one instance at runtime, because nothing else asks for one yet; the cost lands in item 7.
4. **Fog modifiers and `exposed` move onto the viewpoint they belong to.** Today `setFogState`
   early-outs on `seesFor(player)` and stamps into the single local grid, and `cripplePlayer`
   early-outs on `toPlayers.includes(this.localPlayer)`. Both are client-by-construction. They
   become: stamp into `viewpointFor(player)`; record exposure on each recipient's viewpoint.
   **Do not collapse `explored` (sticky) into `visible` (rebuilt every tick)** — a one-shot
   `SetFogState` VISIBLE lights the area for an instant but leaves it explored forever, while a
   standing modifier is re-stamped on every rebuild.
5. **Minimap and per-player HUD take a viewpoint** — `dots()`, `creepCamps()`, `minimapIcons()`,
   and the `leaderboardFor` / `displayText` / dialog gating in `mapViewer.ts`.
6. **`GetLocalPlayer` resolves per recipient.** [`src/jass/natives/config.ts`](../src/jass/natives/config.ts)
   reads `c.rt.localPlayer` — the authority's own notion of "local", which is meaningless once the
   interpreter runs once and its output is sent to N clients. The classic WC3 desync native; it must
   resolve against the recipient of the snapshot.
7. **`sim.visibleToTeam` consults the real grid for every team.** See the note above — this is the
   behaviour-changing one. Verify with creeps: a creep camp must stop aggroing a hero it has no
   sight on. Also the moment N rebuilds become real, so measure and record the frame cost.

#### Found while verifying item 1 — not item 1's to fix

Two clients on Echo Isles, same seed, slots 0 and 1, `explored` vs `unexplored`:

- **The good news, and it is worth stating.** The existing per-team `VisionMap` is *correct* for the
  one viewpoint it serves. Under `fog=unexplored` the enemy's minimap dot is genuinely absent and
  the world outside sight is genuinely black. Phase D is adding viewpoints to something that works,
  not repairing something that doesn't — which is why "behaviour must not change for the local
  player" is a testable claim and not a hope.
- **BUG — `fog: "explored"` reveals enemy BUILDINGS, not just terrain.** `exploreAll()` marks every
  cell explored; `fogHides` shows any building standing on an explored cell, on the theory that an
  explored cell is one you have *looked* at. With start-explored those are different claims for the
  first time, and the enemy's town hall is on the minimap from turn 0 (visible as the blue dot in
  the left-hand shot on the commit). Real WC3's start-explored reveals terrain memory only — you
  still have to scout the buildings. Fix belongs with item 4, which is already the item about not
  collapsing sticky `explored` into per-tick `visible`; this is the same confusion one layer up.
  It is pre-existing and unrelated to the boot path.
- **Unverified — gold-mine and creep-camp glyphs draw on unexplored black.** `minimapIcons()` and
  `creepCamps()` both paint through pitch-black fog. This may well be correct: WC3's melee minimap
  does show some neutral furniture from the start. **Check against the real client before touching
  it** (CLAUDE.md: the MPQ and the running game win over any reference). Belongs to item 5.

**Illusion tells are already viewpoint-gated** — the blue wash, the summon timer and the portrait all
key off `seesFor(u.owner)` today, which is the correct rule (see [`illusions.md`](./illusions.md):
the enemy must not be able to tell). Item 2 carries them along unchanged; do not re-derive them.

#### Settled — the unit of vision is the PLAYER

`VisionMap` is per-**TEAM** today, and teams are not players (`teamOfPlayer` falls back to the slot
number). The candidates differ the moment a script calls `SetPlayerAlliance` with shared vision,
which is exactly the feature this is for:

- **per player** — N maps, sharing folded in at reveal time (`revealsFor` already ORs team membership
  with `alliances.sharesVisionWith`). Survives a runtime alliance change with no re-partitioning.
- **per team** — what exists; cheapest; wrong as soon as vision is shared across teams.
- **per sharing group** — fewest rebuilds, but the groups have to be recomputed whenever an alliance
  changes, and a half-shared alliance (A sees B but not vice versa) has no group.

**Decided: per player.** `seesFor` and `revealsFor` already OR the three notions together — team
membership *and* `alliances.sharesVisionWith` — so folding sharing in at reveal time costs nothing
new, and per-player is the only one of the three that is closed under a runtime `SetPlayerAlliance`.
The price is N rebuilds at 10 Hz each instead of one; measure it at item 7 and record the number.

### Phase E — transport, lobby, reconnect

- **`Authority`**, transport-agnostic: commands in, AoI-filtered snapshots out. No socket types in
  its signature — that is what makes LAN, relay, and dedicated the same code.
- **Transport adapters**: direct (LAN), relay (cloud), in-process (tests/replays).
- **Relay service**: rooms, lobby directory, reconnection tokens. Socket.IO per §7. This is the only
  piece that gets deployed, and it must stay free-tier-shaped — no sim, no Blizzard data, no
  persistent match state beyond a room table.
- **Reconnect**: rejoin token → authority replies with a full snapshot → deltas resume. The reason
  this topology was chosen; keep it exercised by a test from day one.
- **Lobby**: [`src/ui/lobby.ts`](../src/ui/lobby.ts) `MeleeConfig`/`SlotConfig` is already a pure data
  contract, and `applyLobby(slots, localPlayer)` ([`src/jass/index.ts`](../src/jass/index.ts):91) is
  already the seam between "what the map allows" (`config()`) and "who is actually playing".

### JASS

The interpreter is a good citizen: engine-agnostic by construction (it imports neither renderer nor
VFS), all world mutation behind `EngineHooks`, a seeded mulberry32 PRNG
([`src/jass/runtime.ts`](../src/jass/runtime.ts):891), and timers on **game time**, not wall clock
(`advanceTime`, [`src/jass/interpreter.ts`](../src/jass/interpreter.ts):704). It runs on the authority,
once.

`GetLocalPlayer` ([`src/jass/natives/config.ts`](../src/jass/natives/config.ts):75) is the classic WC3
desync native and the one place that needs explicit per-client thought: it must resolve per *recipient*
of a snapshot, never on the authority's own notion of "local".

### Boot

There is no committed headless boot path. `?dev=` is described in
[`CLAUDE.md`](../CLAUDE.md) and [`triggers.md`](./triggers.md) as a **temp, uncommitted** local patch;
the only URL param in `src/` is `?menudebug`. The load gate always requires a human folder-picker
gesture (`mountLoadGate`, [`src/ui/gate.ts`](../src/ui/gate.ts)). Automated two-client testing needs
a real scripted-boot path — worth landing early, since it is how every later phase gets verified.
This is now **[Phase D item 1](#remaining-work-in-order-1)**, since Phase D is the first phase whose
correctness cannot be shown by any headless test: fog is invisible to `sim:test`, and a vision
refactor can pass every suite while showing an enemy base through the fog.

## Open questions

- **Host input delay.** Handicap the host to the room's median RTT, or accept the advantage in v1?
- **NAT traversal.** Pure relay (simple, all traffic through the free box, bandwidth-bound) vs. WebRTC
  data channels with the cloud box as signaling only (cheaper to host, much more moving parts).
  Bandwidth on a free tier likely decides this.
- **Snapshot encoding.** JSON is fine to start and trivially debuggable; binary when it hurts.
- **Cold start.** A free instance sleeping after 15 min means the first player waits ~30–60 s for the
  *relay* to wake. Survivable with an honest "waking server" screen — and note this only ever delays
  lobby join, never an in-progress match, since the match itself does not run there.
