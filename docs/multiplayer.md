# Multiplayer — authority, transport, and the road to it

How OpenWar3 gets two browsers playing the same match, why the authority runs on the **host** rather
than on a cloud box, and what has to change in the engine first. This supersedes the sketch in
[`OpenWar3_PLAN.md`](../OpenWar3_PLAN.md) §7–8 on two points (hosting and server-side data); the rest
of §7 — delta snapshots, area-of-interest culling, no client prediction in v1 — stands.

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

## What has to change in the engine

Sequenced. Phase B is the tentpole; everything downstream depends on it.

### Phase A — timestep and identity hygiene

Needed regardless of topology, and it also buys replays.

1. **Fixed timestep.** [`src/render/mapViewer.ts`](../src/render/mapViewer.ts):5906 feeds the sim raw
   `requestAnimationFrame` delta, clamped at 50 ms. Replace with an accumulator driving
   `sim.tick(FIXED_DT)` plus a render interpolation factor. Note
   [`src/sim/world.ts`](../src/sim/world.ts):28 already *claims* "fixed-timestep" — today that half of
   the comment is aspirational. The authority's tick rate is meaningless until this lands.
2. **Move entity ID allocation into the sim.** [`src/game/rts.ts`](../src/game/rts.ts):1782 (and
   :1881, :1996, :2020) allocate `simId` in the order `trySeed` walks streamed units — i.e. **asset
   load order**. Entity identity currently depends on disk and network timing. Everything downstream
   (Map iteration, tiebreaks, `unitDrops` keys) inherits that.
3. **Seed plumbing.** [`src/game/rts.ts`](../src/game/rts.ts):725 hardcodes the RNG seed to `1` — every
   match rolls identically, and there is no way to set it. It must come from the lobby.
4. **The hero-name draw** at [`src/game/rts.ts`](../src/game/rts.ts):2034 uses `Math.random()` and
   writes into sim state (`SimUnit.properName`). Route it through `sim.rng()`. The other two
   `Math.random()` calls (:2422, :2460, animation variants) are pure render and can stay.

Not needed under this topology: the ~146 `Math.hypot`/`atan2`/`sin`/`cos` calls in
[`src/sim/`](../src/sim/) are not bit-exact across JS engines, which would matter for lockstep. Only
one machine simulates, so it does not. **Filed, not fixed** — it would resurface if cross-machine
replay verification is ever wanted.

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

[`src/game/rts.ts`](../src/game/rts.ts):4052 `order()` is the ownership choke point — its own comment
calls it "the single choke point that keeps enemy/neutral/creep units uncommandable." But it is **not
exhaustive**. These bypass it and call the sim directly:

`issueCast` (:3237), `issueSellItem` (:3089), `issueGiveItem` (:3091), `issueHold` (:3403),
`issueGetItem` (:4205), `issueGarrison` (:4381), `setShopBuyer` (:3034), plus `issueUnitOrder`
(:4093) which deliberately skips the ownership gate because triggers need it.

Casts are absent from `QueuedOrder` entirely. Every one of these must be expressible as a command
before the wire exists, or those actions silently become host-only.

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
