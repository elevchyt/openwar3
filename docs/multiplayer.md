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
| B — bisect `rts.ts` | not started | the tentpole |
| C — command funnel | **done** | 15 player actions through `execute(player, cmd)`; `Command` is the wire type |
| D — N vision maps | not started | |
| E — snapshots & reconnect | not started | |

**Shipped so far** (newest first — `git log` for detail):

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

**Pick up here.** In order:

1. **The `simWorld` escape hatch — finish it.** See below; this is the live piece of work.
2. **Phase B — bisect `rts.ts`.**
3. **Phase D / E** — N vision maps, then snapshots and reconnect.

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
   action goes around the gate any more. It wants doing alongside Phase B (bisecting `rts.ts`),
   since both are about where these ~66 JASS hooks should actually live.

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

[`src/game/rts.ts`](../src/game/rts.ts) is 258 KB and mixes concerns that must end up on opposite
sides of the wire:

| Authority-side | Client-side |
|---|---|
| vision rebuild, alliances | model instance sync, animation |
| unit seeding / spawning | portraits, HP bars, hover tips |
| order validation (`controls()`) | selection, command card |

This is the largest single refactor in the path. The sim underneath is already clean —
[`src/sim/`](../src/sim/) imports no DOM, no renderer, no VFS, and `pnpm sim:test` already compiles
`world.ts` standalone and drives it in Node. The bridge is the problem, not the core.

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

Today there is exactly **one**, and it is the local team's:
[`src/game/rts.ts`](../src/game/rts.ts):633, constructed once at :729, with visibility
short-circuiting on `team !== this.localTeam` at :734. AoI filtering needs one per player or
vision-sharing group. `VisionMap` ([`src/sim/vision.ts`](../src/sim/vision.ts):62) is cleanly
parameterised and instantiable N times, so this is instantiation and wiring, not redesign. Rebuilds
are already throttled to 10 Hz (:2311).

The other per-viewpoint systems that follow the same rule: unit hiding in fog (:2325), detection and
invisibility (:1164), illusion tells (see [`illusions.md`](./illusions.md)), minimap dots
([`vision.ts`](../src/sim/vision.ts):357), and per-player text/leaderboard/multiboard.

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
gesture ([`src/ui/gate.ts`](../src/ui/gate.ts):55). Automated two-client testing needs a real
scripted-boot path — worth landing early, since it is how every later phase gets verified.

## Open questions

- **Host input delay.** Handicap the host to the room's median RTT, or accept the advantage in v1?
- **NAT traversal.** Pure relay (simple, all traffic through the free box, bandwidth-bound) vs. WebRTC
  data channels with the cloud box as signaling only (cheaper to host, much more moving parts).
  Bandwidth on a free tier likely decides this.
- **Snapshot encoding.** JSON is fine to start and trivially debuggable; binary when it hurts.
- **Cold start.** A free instance sleeping after 15 min means the first player waits ~30–60 s for the
  *relay* to wake. Survivable with an honest "waking server" screen — and note this only ever delays
  lobby join, never an in-progress match, since the match itself does not run there.
