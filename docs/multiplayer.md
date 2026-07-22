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
| D — N vision maps | **done** | `Viewpoint` + `VisionSet`; every viewpoint-dependent system takes one; `GetLocalPlayer` resolves against an audience; ~0.75 ms per viewpoint per rebuild |
| E — snapshots & reconnect | **done** | **The host is the authority and a client renders what it is sent.** The 149-entry [JASS hook table](#the-jass-hook-table) is split so a headless host can build one (1–1h); viewpoints are seated at match start (2) and the minimap answers for a viewpoint that rendered nothing (3–4, 3c). A snapshot type and producer exist (5), AoI-filtered per recipient (6) with a per-recipient ghost memory for razed buildings (6b/6c); script broadcasts reach every seat (7) and a map's own `GetLocalPlayer` gate is evaluated once per recipient, the host's pass writing and the extra passes muzzled (7b). The relay core runs in-process for tests (8); commands have a wire format and a forgery-proof host door (9) and cross from a client to the host (9b). Snapshots cross a real relay and are diffed against the client's own sim (10a/10b), wired into every LAN match (10b-note) and driven by a committed two-client boot (10b-harness). **A client draws from the payload** — minimap dots (10c-1), model visibility (10c-2c-1), the whole frame of poses, bars, rings and hover (10c-2c-2), the selection panel (10c-2c-3), every screen-position question including picking (10c-2c-4), and deaths, so a building razed while it was not watching keeps its image (10c-2c-5/6d) — through one `RenderUnit` surface both structs satisfy (10c-2a/10c-2b). A dropped client's slot is held under a token (11a), reclaimed from localStorage (11a-client), and answered with a full snapshot off the cadence (11b). Closed by an audit against HEAD (12): two clients played through the relay and a dropped one rejoined to `drift 0`. Outstanding: `9b-cmd-shot`, a browser capture only — the path itself is covered by `loopback-test`. |
| F — the LAN punch list | **done** | Product-shaped, not architecture-shaped. **Two windows now play a real LAN match through the menus**: relay liveness (1), the whole flow driven end to end (2), the opening camera fixed (3), and the match's wire no longer closed by the menu that made it (4) — host `sent 1731` / client `received 1731`, `stale 0`, and an order issued on the client walks its peons in the client's snapshot-drawn view. The drift log after a move order was the detector comparing two worlds running different inputs, and now says so instead (5), a host ending the game ends it on the client too (6), and **a match now plays to a natural end**: the host razes the loser's hall and both players get the real Victory/Defeat screen (7). and a client leaving no longer crashes the relay (8). **All eight items are closed and the stop condition is met**: menu → Local Area Network → Create Game → join → Start → play → a natural end, with no dead room, no stuck lobby and no desync — driven clean end to end on the fixed build (see [the closing run](#the-closing-run)). Next phase: the client's local sim stops stepping and becomes a record store the snapshot writes (Open questions — decided, option 2). |
| G — the wire after the whistle | **in progress** | The relay is dropped when the MATCH is decided — on `RemovePlayer`, blizzard.j's own end-of-game signal, for any result but a defeat (1); verified on Lost Temple with four seats, where one player's defeat leaves the room up and the wire feeding. `?maps=` takes map NAMES so the harness can be pointed at a specific map (2). The six playtest bugs are reproduced and their mechanisms pinned in code (3): trained units spawn as `localPlayer` in the drain (bug 4, NOT fixed by option 2 alone), snapshot-id vs local-entry-id divergence (bugs 1/5/6, option 2's target), the rAF-pumped host sim (bug 2, unreproducible headless — needs real windows), and a healthy 10 Hz wire rendering verbatim (bug 3). Bug 2 is FIXED (4): a dedicated-Worker pump keeps a networked match's sim + spawn drains running while rAF is stopped; A/B-verified against a rAF-kill emulation (pre-fix wire froze at `received 90`; fixed build held 10 Hz and completed a training with the host's render loop dead). Bug 4 is FIXED (5): the train-completion event carries the trainer's owner and the drain spawns with it (`sim:test` 499, named red/green check); browser-verified — the client's peon is green with a full card, the host's food untouched. Option 2's sizing pass is DONE (6): `UnitSnapshot` already carries what every reader reads; the wire gaps are the recipient's stash (2d), its tech state, and shop stock — all per-recipient world lanes, all `PROTOCOL_VERSION` bumps. The applier is IN (7, 2b): a `frozenClient`'s sim never steps, payloads create/update/REMOVE its records (`snapshotApply.ts`), and the maphack invariant has a red-proven headless check (`sim:test` 512) — **browser verification still owed**, plus the two known interim regressions 2c exists to close. The 2c body drains are IN (8): applier-created records get models through `drainSnapshotSpawns`/item drains, and the host's foundation starter takes the WORKER's owner rather than `localPlayer` (both halves of bug 6). The STASH lane is CLOSED (9, was gap 2d): `WorldSnapshot.stash` carries the recipient's own gold/lumber and the applier writes it wholesale (`PROTOCOL_VERSION` 4) — this was the July playtest's "training instantly canceled": the client's local ledger drifted (income accrues only where the sim steps), its authority accepted and charged a train the host refused, and the next payload wiped the queue while the local charge leaked; reproduced live by draining the host-side stash, then verified fixed (client refuses honestly on the synced figure, an accepted train reconciles to the host's balance). A refused remote command is now named in the host's dev console (`[sync] host REFUSED …`) so the next playtest report carries its reason. Snapshot POSE INTERPOLATION is IN (10): a frozen client re-writes record x/y/facing/flyHeight every frame, gliding from the pose the last frame drew to the payload's over the host-time gap between payloads (`poseLerp` in rts.ts) — records are the one surface every consumer reads (models, bars, minimap, picking, the walk-clip gate), so the whole frame inherits 60 fps motion one interval behind the authority; teleports past `POSE_SNAP_DIST` snap, and a late payload holds units where the host last put them. The TECH and STOCK lanes are CLOSED too (11, `PROTOCOL_VERSION` 5): `WorldSnapshot.research` carries the recipient's own researched-upgrade levels (the census half of `TechState` derives from unit records and needed no lane) and `BuildingSnapshot.stock` carries a shop's shelf — counts plus the restock sweep, `Infinity` crossing as -1 because the payload is JSON — for shops the recipient may shop at only (neutral, own, ally; an enemy Vault's wares are withheld like the rest of its intel). Browser-verified end to end: a client researched at its own War Mill and read the completed level back (its card tier and requirement gates now answer from the host's truth), and its shelf tracked the host's counts and timers through another ware's stocking cycle. Item purchases joined the command funnel while closing this (12): `mapViewer.buyItem` called `world.purchaseItem` straight into the sim — single-player never noticed, and a frozen client's shopping was local theater the next payload reverted — so `buyitem` is now a `Command`, the authority nominates the patron with the same `shopBuyer` rule the overhead arrow uses, and the card keeps feedback-only pre-checks. That surfaced one more sim-tick dependency of the frozen client: patron ADOPTION lives in `tickShopBuyers`, so a client never had a buyer and refused its own purchases locally — `adoptShopBuyers()` now runs after each payload application, deriving the local nomination from the freshly-written records (also what makes the client draw the overhead arrow at all). Verified live: a client's Far Seer bought a Potion of Invulnerability through the wire — host delivered and charged, the shelf entry's deletion propagated, and the client reconciled to the host's exact gold and inventory. The second playtest's render bugs are FIXED (13): the client was still choppy because `frameUnit` drew the RAW payload — the pose interpolation was gliding records nobody's frame read — and under option 2 the record store ≡ the payload, so the frame now reads the (glided) records everywhere and only `drawnFromMemory`/`modelHidden` still consult the index for the per-recipient bits a record must not carry; UBERSPLATS are now part of a building's IMAGE — shown exactly when the model is (live or remembered), withheld with it (`UberSplatOverlay.setVisible`, a per-frame sync in the splat pass) — which closes both the host reading a client's unscouted base off the ground through explored fog and the orphaned foundations a frozen client kept wherever the applier removed a neutral building's record (the pre-placed `p<i>` splats now bind to their statically-known reserved sim ids, replacing the 250 ms position-matching prune); and a drain-spawned NEUTRAL building finally renders where it stands — the entry sync deliberately skips neutral-passive entries (map furniture is placed by the map loader), so a client re-scouting a merchant got a tent seated at the world origin until `spawnUnit` learned to seat the body itself. All four verified in a single-tab client harness: a fake `MatchLink` + synthetic payloads built from the page's own records drive the whole frozen-client pipeline without a host, a relay, or the second window Chrome keeps freezing (drawn per-frame motion measured at ~3.4 u/frame against 19.9 u payload hops; the merchant cycle omit → splat withheld → re-sent → tent seated on its pavement, no double decal). The third playtest's minimap and latency items are IN (14, `PROTOCOL_VERSION` 6): NEUTRAL PASSIVE structures are map furniture every player knows from the loading screen, so fog demotes them to REMEMBERED rather than absent (`visibilityFor`) — a frozen client keeps their records, models, glyphs and splats, and learns their destruction only by discovery (the ghost path already produced exactly that rule); CREEP-CAMP markers are computed per recipient on the authority (`HostSources.creepCampsFor` → `CreepCamps.markers(viewpoint)`) and carried in the snapshot, because a client's record store holds only the creeps it was sent and clustering it reported every unscouted camp as cleared; the cadence is 20 Hz (`SNAPSHOT_INTERVAL` 0.05) — the fog still rebuilds at 10, but order-to-motion latency is cadence + one payload-gap of glide, and both halved; and a host-side REFUSAL now crosses the wire (item 9c, `RefusalMessage`) with the coarse cause the host re-derives (gold/lumber/food), surfacing through the client's own refuse pathway — a refused command is no longer silent theater the next payload erases. The reported post-hero train cancel did NOT reproduce on this build over a live wire (host verdict log green, peons delivered at real timing, twice); with the echo in place a recurrence names itself on both the client's HUD and the host's console. PROJECTILES cross the wire (15, `PROTOCOL_VERSION` 7): a frozen client's sim launches no `SimProjectile`, so no attack missile ever rendered on a client — `WorldSnapshot.projectiles` now carries in-flight missiles under the recipient's eyes (the ground items' rule: in the dark means absent), redacted to pose + flight (damage, spill and the impact spell stay behind; `tx`/`ty` is the target's position as aim fallback for a target the payload withholds); the applier upserts them into `world.projectiles` and reports create/remove, the renderer plays the launch sound + streams the model for a spawn and the impact burst where a vanished one last was, and `tickClientProjectiles` advances flights between payloads with the sim's own homing step so an arrow flies at the frame rate rather than hopping at the cadence — verified in the single-tab harness (a fed Far Seer bolt advanced 585 of its 600-unit flight across 142 frames, height lerping launch→impact, model streamed; removal cleaned record, instance and loading state). The sixth playtest's three items are IN (16, `PROTOCOL_VERSION` 8): the HOST now shows neutral-passive structures unscouted too — the client had the rule (14) via the snapshot send and the host's own `Viewpoint.fogHides` did not, so the two disagreed about the same map furniture; SPELL/ABILITY PRESENTATION crosses the wire (`FxSnapshot` — one-shot effect models like Holy Light's burst, spell ground decals, cast wind-ups with their "beware" art, and cast-fire sounds): these are sim EVENTS drained once by whoever renders, so `rts.tick` is now the single consumer of the sim's four fx queues and fans each event to its own renderer AND (hosting) to `MatchLink`, which buffers per tick and flushes into each DUE broadcast filtered by eyes-on-the-spot — expedited and catch-up sends deliberately carry none, so a burst never replays; and a client's ORDERS answer faster — the host expedites an off-cadence snapshot to the commanding peer the tick its command applies (`MatchLink.expedite`, the rejoin catch-up mechanism reused), cutting the cadence half of order-to-motion latency to one sim tick. Fixed along the way: `applySnapshot` iterating a missing payload field threw before `lastApplied` was set, which re-threw on the same payload every tick — a frozen client wedged forever with a live wire; the reads are guarded now. Verified: loopback pins the fx buffering/filtering/no-replay and the expedited send (off-cadence, clock undisturbed); in the browser harness a payload-fed Holy-Light-style effect spawned its model instance attached to the target on a frozen client, and the host drew an unscouted Goblin Merchant's image under unexplored fog. The seventh playtest's three items are IN (17, `PROTOCOL_VERSION` 9): DEATHS cross as events — a record's absence reads exactly like fog, and only one of those plays a collapse, so `WorldSnapshot.deaths` names the units that actually died (with where they fell) and the client's removal drain routes those ids through `onDeath` (collapse, death cry, corpse) instead of the silent retire; unlike fx they flush on EVERY send, because the absence they pair with rides every payload too and a silent retire cannot be un-retired (the client's routing is idempotent, so the due broadcast's repeat costs nothing). CORPSES cross as state (`CorpseSnapshot` — the struct was already the client-safe subset), reconciled present/absent like items, so a client's bodies rot on the host's 88-second clock and hide the frame a raise spell consumes one. MORPHS are detected by the applier — a record whose `typeId` changed in place (Scout Tower → Arcane Tower, Hall → Stronghold) is reported and the renderer runs the same `remodelUnit` the host's own morph drain uses; remembered images are deliberately excluded (WC3 keeps showing what you SAW). And the cadence is 30 Hz — the sim was never the limiter (it runs 60), the wire was; what caps it now is the INTERNET deployment's upstream (JSON payloads × recipients), which is the deferred delta/binary encoding's problem, not a constant's. Verified in the single-tab harness: a payload-killed peon's entry went through the death path and left a render corpse linked to the payload's corpse record; the corpse vanished when the payload dropped it; the hall's payload morph called `remodelUnit(104, "ostr")`. The wire went BINARY and the cadence went to the sim's own 60 Hz (18, `PROTOCOL_VERSION` 10): one live `UnitSnapshot` was ~1.2 KB of JSON of which ~50 bytes was information — field names, re-stringified per unit per recipient per send — so the HOT LANE only (`WorldSnapshot.units` + `projectiles`, the per-payload bulk) now crosses as a fixed-layout binary record (`src/game/snapshotWire.ts`, beside the types it encodes, importing no renderer and no transport): positions quantized to i16 world units, facing to u16 of a turn, hp/mana to the integers the HUD shows, twenty booleans in one flags word, presence-gated hero/summon/illusion/guard blocks so a footman pays bits not bytes, and every string interned in a per-payload table — through which the polymorphic composites (build queue, order queue, shop shelf) and the all-static `WeaponSnapshot` ride as deduped JSON. The blob crosses BASE64 inside the existing JSON envelope (`snapw`), deliberately: the relay is JSON-framed end to end and must stay dumb, so the +33 % tax was chosen over teaching it a second framing — measured 7–9x smaller anyway (teamfight synthetic 371 KB → 42 KB; the live Echo Isles world 129 KB → 19 KB, encode 0.35 ms), so 60 Hz binary costs LESS wire than 30 Hz JSON did. The codec owning its representation also FIXED a standing corruption: an aura buff's `timeLeft` is `Infinity`, which the JSON wire silently shipped as `null` and an f32 carries whole. The cold lanes stay JSON verbatim, a plain `snap` payload is still accepted (the harnesses feed them), reconnect catch-up is still a WHOLE snapshot and fx/deaths semantics are untouched — only the envelope changed. Round-trip pinned FIRST (`tools/sim-wire-test.cjs`, in `sim:test`): decode(encode(snap)) deep-equals a payload with every field populated, exact on the codec's grid, epsilon-checked off it, with real-`Infinity` and inventory-hole and remembered-stub checks; loopback covers the path over the real relay core, and the single-tab harness verified in-browser that three binary payloads crossed the real demux (received 3, stale 0), the applier consumed them whole (103 records intact) and `poseLerp` glided a moved peon in even steps between them. DELTA encoding stays deferred on purpose — it needs per-client ack tracking and keyframe recovery; full-state binary at 60 Hz is this item. **Harness lesson (10b-harness):** Chrome freezes a hidden tab (within minutes under memory pressure) — a frozen HOST tab stops `tickHost`, queues inbound commands, and eventually loses its relay socket, all of which cosplays as wire bugs; the dev-LAN joiner picks the first JOINABLE room (a dropped match's room is held for reconnect and reads as full) with boot-length lobby timeouts, and for anything render-side prefer the SINGLE-TAB client harness above — two live windows are only needed when the wire itself is the thing under test. |

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
(407 checks, including `sim-determinism-test.cjs` — same seed reproduces, different seed diverges —
and `sim-order-funnel-test.cjs` for Phase C). Both green. `pnpm jass:test` needs `pnpm data:extract`
first; it reads the unpacked `Scripts/common.j` and fails without it.

**Pick up here.** Phase D is **done**. Next is **Phase E** (snapshots, transport, reconnect),
which inherits four things Phase D deliberately did not do — all recorded in the item they came
from: `dots`/`creepCamps` still iterate the local client's render records rather than `sim.units`;
`minimapIcons` has no fog gate and nobody has checked the real client; a one-shot `SetFogState` is
not replayed onto viewpoints created after it fires; and `forAudience` has no caller until
snapshots exist. Phase E's [remaining-work list](#remaining-work-in-order-2) is now written and is
the handoff; its **item 1** is the [JASS hook table](#the-jass-hook-table) split, which was blocked
on a committed headless boot path and no longer is (Phase D item 1 landed it). The two decisions
that gated items 2 and 5 have been asked and answered — viewpoints at match START, snapshots as
JSON first — so **no item in this phase is blocked on the developer**; see
[Open questions](#open-questions) for the reasoning.

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

`MapViewerScene.textHooks()` builds a **149-entry** `EngineHooks` table inside the renderer
(`mapViewer.ts` 1394–1758; the interface declares 152, the rest being optional members no renderer
supplies — recounted at `771c642`, the old "151" was a count of a moving target).
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

   **`?maps=N` — added later, and the reason is a lesson about harnesses.** The boot could mount
   a map only if you had already NAMED it, so `?dev` alone mounted none. That was right for speed
   (the install holds hundreds; fetching them is minutes) and it left one screen permanently
   invisible: **the screen where you choose a map.** Create Game came up with an empty list and a
   greyed button, and there was no way to tell that apart from the feature being broken — which
   is exactly how it was found, while checking whether a LAN game could be created at all. It
   could: `?dev&maps=8` fills the list (Bandit Ridge, Echo Isles, Emerald Gardens, …) with player
   counts, and Create Game is fine. Capped at 20, defaulting to 0, so every committed harness URL
   boots exactly as fast as before. **A harness that cannot reach a screen reports that screen as
   broken, and the report is indistinguishable from the truth.**

   **Gating — two independent structural gates, neither a runtime flag.** The plugin carries
   `apply: "serve"`, so Vite never loads it for `pnpm build`; `main.ts` branches on
   `import.meta.env.DEV`, a compile-time constant Vite folds to `false`, taking the dynamic
   `import("./dev/devBoot")` with it. The route is not disabled in production, it is *absent* from
   it. Proof, and it is worth re-running if anyone touches this: `pnpm build` then grep `dist/` for
   `wc3/manifest`, `devBoot`, `OPENWAR3_INSTALL` — zero hits, while the *other* dynamic import in
   `main.ts` (`menuDebug`) still emits its own chunk, so dynamic imports plainly do survive the
   build and this one's absence is the fold working rather than luck.
2. ~~**Extract a `Viewpoint`.**~~ **Done.** [`src/game/viewpoint.ts`](../src/game/viewpoint.ts) owns
   one `VisionMap`, the `exposed` set, and every question that can only be answered "…for whom?":
   `seesFor`, `teamOfPlayer`, `revealsFor`, `fogHides`, `fogBlocksClick`, `fogBlocksAt`,
   `showsFromMemory`, `invisHides`, and the 10 Hz `rebuild`. `rts.ts` holds a single
   `private local: Viewpoint` and delegates; `localPlayer`/`localTeam` stay as the client's own
   identity and are pushed into the viewpoint by `setLocalPlayer`/`setLocalTeam`. Zero behaviour
   change, still exactly one grid. `viewpoint.ts` compiles standalone (no renderer, DOM or
   transport) — worth keeping true, it is what lets the authority hold N of these.

   Two things did **not** move, and the reasons are the interesting part:

   - **The fog-modifier registry stays on the controller.** Modifier ids are one global handle
     space shared with JASS, so N viewpoints minting ids from their own counters would collide.
     `rebuild(modifiers)` is handed the running ones and picks out its own. Routing each modifier
     to the viewpoint it was created *for* is still item 4.
   - **`pruneFogged` stays on the controller.** It drops units from the SELECTION, which is client
     state, not vision. The controller calls it after `rebuild`.

   `FogArea`/`FogModifier` moved to [`src/game/fog.ts`](../src/game/fog.ts) — `rts.ts` imports
   `viewpoint.ts`, so leaving them in `rts.ts` would have been a cycle. `rts.ts` re-exports both,
   so no importer changed.


3. ~~**A `VisionSet` registry.**~~ **Done.** `VisionSet` (in
   [`viewpoint.ts`](../src/game/viewpoint.ts)) mints a `Viewpoint` per player on demand via
   `viewpointFor(player)`; `rts.ts` holds the set plus a cached `local` that `setLocalPlayer`
   re-points. Each viewpoint carries its own 10 Hz clock (`Viewpoint.tick`), so N of them
   stagger naturally instead of all rebuilding on one frame, and `VisionSet.tick` returns those
   that rebuilt — the controller re-prunes its selection only when the LOCAL one did, because
   the selection is this machine's and not the match's.

   **Why a registry and not a `Map`.** A viewpoint is not a blank grid: it has to be caught up
   on what the world already told the others. The boot order makes that concrete —
   `initVisionBlockers` runs while the terrain loads, a good half-second *before*
   `setLocalPlayer` says who is playing. A viewpoint minted after that and handed out bare has
   no height field and no tree blockers, and sees straight through every cliff and treeline on
   the map. So the set records world setup (height field, start fog) and replays it onto
   whatever it creates. Tree blockers seed from the LIVE tree collection rather than a replayed
   log, because `SimWorld` deletes a felled tree from `trees` — so "the trees standing now" is
   already right for a viewpoint created now, and stays right for free.

   Also settled here: the lobby's fog mode is a MATCH setting and goes through the set
   (`setStartFog`, applied to all and remembered for later arrivals), while `iseedeadpeople`
   stays on the one viewpoint whose player typed it. `setStartFog` sets reveal-all in BOTH
   directions so that clearing the mode clears it, rather than merely declining to apply it.

   **Cost: unchanged.** Exactly one viewpoint exists at runtime — nothing calls `viewpointFor`
   with another slot yet — so this is still one rebuild at 10 Hz. Echo Isles held 118–134 fps
   before and after. The real N-rebuild budget lands at item 7.


4. ~~**Fog modifiers and `exposed` move onto the viewpoint they belong to.**~~ **Done**, though
   the shape turned out different from what item 2 predicted, which is worth recording.

   **Standing modifiers needed no routing at all.** They were already per-viewpoint the moment
   `rebuild` became a `Viewpoint` method: every viewpoint is offered the whole registry and
   keeps the ones its own `seesFor` accepts. That is also the correct WC3 rule — an ally's
   modifier shows up in your fog, an opponent's does not — and it falls out of asking each
   viewpoint rather than asking "local". The registry itself stays on the controller because
   modifier ids are one global handle space shared with JASS.

   What actually needed the work was the two **client-by-construction** sites:

   - `setFogState` (the one-shot) early-returned unless the LOCAL viewpoint rendered that
     player's fog. Now `VisionSet.stampFor` offers it to every viewpoint that does.
   - `cripplePlayer` early-returned unless the local player was in the force. Now every
     recipient gets it, via `VisionSet.setExposed`.

   **Exposure is recorded on the SET, not pushed at a viewpoint**, so that recording a flag
   does not conjure a grid. It is standing state — it lasts until the cripple timer clears — so
   a viewpoint created later inherits it, the same way it inherits the height field and the
   lobby's fog mode. Pushing straight at `viewpointFor(recipient)` would have made every melee
   match build twelve `VisionMap`s the first time `MeleeExposePlayer` fired, paying item 7's
   cost early and by accident.

   **Known limitation, deliberate:** a one-shot `SetFogState` applies to the viewpoints that
   exist when it fires and is not replayed onto later ones. Replaying would mean remembering
   every one-shot the match ever fired, forever. It only bites if Phase E creates player
   viewpoints lazily mid-match; creating them at match start removes the note entirely, and is
   probably what Phase E should do anyway.


5. ~~**Minimap and per-player HUD take a viewpoint.**~~ **Done.** `dots(vp)` and `creepCamps(vp)`
   now take one, defaulting to the local viewpoint so no caller changed.

   **The thing that had to be untangled** is that both read `Entry.hidden` — the RENDER
   record's flag. That flag is a sum of two different kinds of reason: a unit inside a gold
   mine, in a burrow, swallowed by a Kodo or removed is off screen for *everyone*, while fog
   and invisibility depend on who is looking. Computed once for the local viewpoint, the sum is
   exactly right for the client drawing it and useless for asking about anybody else. So
   `RtsController.hiddenFor(vp, u)` splits it: the viewpoint-independent reasons first, then
   `vp.fogHides(u) || vp.invisHides(u)`. The old `fogHides`/`invisHides` delegating wrappers
   died with it.

   **The HUD half needed no work, and that is the finding.** `leaderboardFor(player)`,
   `DialogObj.visibleFor: Set<number>` and the `displayText(player, …)` hook are already
   per-player in the data model; `mapViewer` picks `this.localPlayer` out of them because the
   renderer renders for the local player. That is the client question, correctly answered —
   the same category as the ~35 `execute(this.localPlayer, …)` calls. Nothing there was
   client-by-construction.

   **Still coupled, and Phase E owns it:** `dots` and `creepCamps` iterate `this.entries`, the
   local client's render records. A viewpoint parameter makes them answer *the fog question*
   for anyone; it does not make them enumerate units the local client never loaded a model
   for. An authority answering for a remote player must iterate `sim.units` instead. Changing
   the iteration source now would alter what the local player sees (units without render
   records would start showing dots), so it is deliberately not part of this item.

   **Open, and needs the real client:** `minimapIcons()` has no fog gate at all — gold-mine and
   neutral-building glyphs draw on pitch-black unexplored ground. It therefore takes no
   viewpoint, because it does not currently depend on one. Whether that is *correct* is
   unresolved; WC3's melee minimap may well show some neutral furniture from the start. Per
   CLAUDE.md the running game decides, and nobody has looked yet. Do not "fix" it from memory.


6. ~~**`GetLocalPlayer` resolves per recipient.**~~ **Done — the seam, not the consumer.**
   `Runtime.audience` is the player the interpreter is currently evaluating FOR; `null` means
   this machine's own seat. `GetLocalPlayer` reads `localViewer` (`audience ?? localPlayer`),
   and `forAudience(player, fn)` scopes it with a `finally`, so a trigger that throws
   mid-evaluation cannot leave the runtime answering as somebody else for the rest of the
   match. Pinned by [`tools/jass-audience-test.cjs`](../tools/jass-audience-test.cjs) (9 checks,
   running real JASS through the interpreter), wired into `pnpm jass:test` **before** the
   corpus test so it executes despite that suite's pre-existing failure.

   **Today this changes nothing, and it is worth being precise about why.** Every client boots
   the map and runs `config()`/`main()` itself, so each machine's runtime genuinely has its own
   local player and `GetLocalPlayer` is *already* correct per client. The native only becomes
   wrong when Phase E makes one host run the script for everybody. So this item lands the
   resolution point; Phase E supplies the recipient.

   **The finding that makes per-viewer evaluation safe at all**, from the real
   `Scripts\Blizzard.j` in the MPQs: all 72 `GetLocalPlayer` sites guard a block carrying
   Blizzard's own comment *"Use only local code (no net traffic) within this block to avoid
   desyncs"* — camera, text, sound, timer dialogs, cinematic. **A `GetLocalPlayer` gate is
   presentation-only by contract.** That is the justification for what our natives already do
   with the `…ForPlayer` family: intercept at the wrapper, take the player argument, route to a
   per-player hook, and never evaluate the gate. The residual exposure is a map script calling
   `GetLocalPlayer` directly, which is what `forAudience` is for.

   **Bug fixed in passing:** `ClearTextMessages` was hardcoded to slot 0 with the note
   "single-player: slot 0". Wrong the moment the human is not in slot 0 — it cleared a
   bystander's message log and left the real one standing. Now `localViewer`.
   `DisplayTimedTextFromPlayer` moved to `localViewer` too; it is a broadcast, so under Phase E
   it will be delivered once per recipient rather than once to the host.


7. ~~**`sim.visibleToTeam` consults the real grid for every team.**~~ **Done.**
   `VisionSet.viewpointForTeam(team)` answers it. It prefers an existing PLAYER viewpoint on
   that team, which is thrift but mostly safety: the local team keeps being answered by the
   very grid it always was, so this cannot change what the local player's units acquire. A team
   with no player slot — creeps — gets its own, constructed with `player: -1`.

   **The behaviour change is smaller than this list predicted, and that is worth recording.**
   The note used to say enemy creeps aggro through fog and would stop. They already didn't:
   issue #45 gated acquisition on the unit's own sight radius and line of sight, and for a
   creep the team grid is essentially the union of exactly those eyes — so the new gate is very
   nearly a no-op for creeps. What it actually buys is the case that does not exist yet: when a
   host simulates PLAYER 2's army, that army is now gated on player 2's fog instead of on
   nothing at all. That is an anti-maphack property, not a creep-AI fix.

   **Cost, measured rather than guessed.** At Echo Isles scale (192×192 vision cells, ~104
   units, cliffs installed so the line-of-sight raycasts do real work) one rebuild round costs
   **0.79 ms for one viewpoint, 1.49 for two, 2.28 for three, 3.01 for four** — linear in N, as
   expected, since each grid iterates every unit but only raycasts its own team's. At the 10 Hz
   cadence three viewpoints cost ~2.3 ms once every sixth frame. In the running game Echo Isles
   held 124–132 fps / 7.6–8.1 ms, against 116–144 / 7.7–8.6 before the change: no measurable
   difference at this scale. A 12-player map with four teams would cost ~3 ms per round, still
   comfortably inside a frame.


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

#### The inventory — what the code actually contains

Enumerated at `771c642`, by callee rather than by name, because that is the discipline that made
three of Phase D's seven items shrink. Four findings, and three of them are smaller than the prose
above predicted.

**The `simWorld` escape hatch is now almost exactly the hook table.** 70 uses remain in
`mapViewer.ts` (down from 136). Broken out by member:

| What | Count | Where it goes |
|---|---|---|
| JASS world-mutating natives (`setUnitOwner`, `createItem`, `addHeroXp`, `setPathing`, …) | 66 | item 1 — out of the renderer with the table |
| `timeOfDay` / `dawnDusk` **writes** (`SetTimeOfDay`, `SuspendTimeOfDay`) | 2 | also hooks; they are the two `simView` refused in Phase B 7a |
| `initStash` ×2, `setPathStamp` | 3 | setup, called once at match start; fine where they are |

**Item 1 has since taken this 70 → 35** (and `simView` 55 → 34) by moving the 57 natives that need
`SimWorld` alone into `jassHooks.ts`. What remains is listed under item 1b.

So "narrow the getter" is no longer a refactor with a long tail — **it is one move, item 1**, and
everything else on the hatch is already closed. The 55 read uses went to `simView` in Phase B.

**The hook table is 149 built, 152 declared** — not 151. `MapViewerScene.textHooks()` spans
`mapViewer.ts` 1394–1758 and populates 149 members; `EngineHooks` ([`runtime.ts`](../src/jass/runtime.ts):443)
declares 152. The gap is optional members no renderer supplies. Use the real numbers; the old 151
was a single count of a moving target.

**The game-traffic pipe already exists and has exactly one user.** `LobbyClient.send(to, data)`
([`lobby.ts`](../src/net/lobby.ts):93) wraps `{ t: "relay" }`, and the relay forwards `relay`/`deliver`
without inspecting the payload ([`protocol.ts`](../src/net/protocol.ts)). `StartMatch` is the only
`GameMessage` member. So commands and snapshots are **new members on an existing envelope**, not new
plumbing — and `server/relay.mjs` (169 lines) needs no change to carry them.

**Nothing is sent after `start`.** Both clients build the same world from one config and one seed,
then each simulates independently and drifts within seconds. There is no snapshot code anywhere yet;
this phase writes it from nothing rather than adapting something.

**The renderer's read surface on `RtsController` is already narrow**, which is the good news for
item 5: `simView` (13 uses), `selectedInfo` (9), `orderMode` (11, pure client), `foodFor` (3),
`stashFor` (2), `itemVisible` (2), `getVision` (2). Making a client render someone else's world is
mostly making `simView` per-recipient — which [`simView.ts`](../src/game/simView.ts)'s own header
already nominates itself for.

#### Remaining work, in order

Each is independently shippable. **Behaviour-preserving unless the item says otherwise** — items 3
and 4 say otherwise and are flagged. Two items are gated on a developer decision and say so.

1. ~~**The JASS hook table → its own module.**~~ **Half done, and the half is the clean one.**
   [`src/game/jassHooks.ts`](../src/game/jassHooks.ts) `simHooks(sim)` holds the **57** natives that
   need `SimWorld` and nothing else; `textHooks()` keeps the other **92** and composes by spread.
   57 + 92 = 149, and the merged key set was diffed against `HEAD` — no overlap, nothing lost,
   nothing gained. `simWorld` in `mapViewer.ts` **70 → 35**, `simView` **55 → 34**. `jassHooks.ts`
   compiles standalone, so the headless host now has most of a hook table with no WebGL context in
   its import closure.

   **The selection rule was "what does the body actually read", and it cut smaller than
   `(SimWorld, Authority)` predicted.** `Authority` never entered it: the natives that would have
   needed it (`getPlayerState`, `issueUnitOrder`, `getUnitCurrentOrder`) also read something else,
   so the honest boundary was `SimWorld` alone. `setPlayerState` DID move — it writes the live
   stash, which is the authority acting rather than a client spending, and it was the last
   live-stash write in the renderer. Promoting it to a named `Authority` method is still worth
   doing and is **now item 1b**, not part of this.

   **What is left — items 1b–1f.** The 92 that stayed are not all presentation. Four groups, and
   each needs a different answer rather than one sweep (item 1b has since taken the
   player-resource pair out, leaving 91):
   - **Dual-writers** (`setUnitFlyHeight`, `setUnitOwner`): write the sim AND the model. They need
     the presentation half to have a seam before they can split.
   - **Gold-mine table** (`getUnitX`/`getUnitY`/`getResourceAmount`/`createBlightedGoldMine`):
     to a script a mine IS a unit, but mines are map-placement state the renderer owns.
   - **`RtsController` routes** (`createUnit`/`removeUnit`/`killUnit`/`issueUnitOrder`/
     `getPlayerState`/alliances/fog modifiers): spawning, the order funnel and the viewpoint
     registry.
   - **Genuine presentation** (camera, sound, weather, effects, text, selection, registries): stays
     with whoever is drawing, and is what gets *injected* into the headless table.

   **A test was required here and is not ceremony.** All 152 `EngineHooks` members are optional, so
   dropping a native during a split compiles clean and passes every suite. Confirmed by doing it:
   deleting `addHeroXp` left `pnpm typecheck` green and was caught only by the new
   [`tools/sim-jass-hooks-test.cjs`](../tools/sim-jass-hooks-test.cjs) (11 checks — the exact
   roster, plus that the hooks read/write the world they were built from, plus that
   `setPlayerState` reaches the live stash). Restored after.

   One behavioural difference, deliberate and stated in the code: the moved entries used to
   re-check `this.rts?` on every call and are now bound once when the table is built. `runMapScript`
   runs long after `RtsController` exists, so the null branch is unreachable in practice.

1b. ~~**`setPlayerState` → a named `Authority` method.**~~ **Done**, and it dragged its twin along,
   which was the right answer rather than scope creep. `Authority.setPlayerResource(player,
   "gold"|"lumber", value)` is the ONLY live-stash write outside `execute()`, and it is named so
   that exception is visible instead of implied. `authorityHooks(authority)` in
   [`jassHooks.ts`](../src/game/jassHooks.ts) holds `setPlayerState` **and** `getPlayerState`: they
   are one concern (the player-resource pair), and leaving the reader in the renderer would have
   split a pair across the seam for no reason. `simHooks` 57 → 56, `authorityHooks` 2, renderer
   92 → 91. Still 149.

   **The method takes a resource NAME, not JASS's `PLAYER_STATE` number.** The 1=gold/2=lumber
   encoding is the interpreter's, and having the authority learn it would drag the JASS numbering
   into the one module that has to survive the interpreter. The mapping stops at the seam.

   **The bigger finding is the seam itself.** The renderer no longer reaches for `simWorld` OR for
   `authority` to build a table: `RtsController.worldHooks()` composes both factories, because the
   controller is the only object already holding both. `authority` stays **private** — handing it
   out would have opened the `simWorld` hatch again one layer up, and `execute()` would have
   stopped being the only door. `simWorld` in `mapViewer.ts` **35 → 34**. A headless host calls the
   two factories directly and injects its own presentation entries, or none.

   **`authorityHooks` takes a structural type, not `Authority`.** Three members —
   `stashFor`/`foodFor`/`setPlayerResource`. `Authority` satisfies it, the compiler still checks
   it, `jassHooks.ts` keeps a narrower import closure, and the test can stub it. Same trick as
   `FormationWorld` in Phase B item 1.

   **The regression test earned its keep again.** The plausible lazy refactor here is making
   `setPlayerResource` write through `stashFor` — and it *throws*, because the copy is frozen, so
   `stashFor`'s promise to "fail loudly rather than mutate a throwaway in silence" turns out to be
   load-bearing rather than decorative. Confirmed by doing it: `pnpm typecheck` stayed green, the
   suite exited 1 on a `Cannot assign to read only property 'gold'`. Restored after.

1c. ~~**The dual-writers.**~~ **Done, and the entry above was wrong about the blocker.** It said
   these needed "the presentation half to have a seam of its own" first. They did not. A dual
   native does not have to move whole: its WORLD half goes into `simHooks`, and the renderer
   **re-declares the same key after spreading the table and calls back into it**, so the model
   half decorates rather than replaces. `setUnitOwner` and `setUnitFlyHeight` are therefore the
   only two keys that legitimately appear on both sides, and the union is still 149.
   `simHooks` 56 → 58; `simWorld` in `mapViewer.ts` **34 → 32**.

   **The real blocker was `teamOf`, and finding it is worth more than the move.** `SetUnitOwner`
   must write a TEAM alongside the new owner — the sim decides allegiance and vision by team, not
   by slot — and the slot→team seating is the LOBBY's. It is now injected
   (`worldHooks(teamOf)`): the renderer passes its `meleeTeams` lookup, a headless host passes
   `MeleeConfig.slots`. Injecting beat looking it up because **there is no authority-side owner of
   that mapping to look it up from** — see 1c-note.

   **1c-note — ~~a real finding, not part of this move~~. FIXED in item 2**, where seating made
   it load-bearing exactly as predicted. The lobby's player→team map exists in
   exactly one place: `mapViewer.meleeTeams`, built from `config.slots`. Everything else
   *re-derives* it. `Viewpoint.teamOfPlayer` scans `world.units` for a unit that player owns and
   falls back to the slot number — i.e. the authority's own vision code is reverse-engineering the
   seating from unit ownership because it cannot reach the seating. That is wrong before the first
   unit is seeded and for any player who owns nothing, and it is the kind of thing that will bite
   once a host answers for players it is not rendering. **It is its own item** (see item 2's
   neighbourhood — viewpoints at match start is when this becomes load-bearing). Do not fold it
   into a hook move.

   **Verification honesty:** the world half of both natives is unit-tested, including that the
   injected `teamOf` is actually applied (the check fails on `teamOf(id)` vs `teamOf(player)` with
   `typecheck` clean — confirmed by injecting it). The *decorator* is not covered by any test: the
   risk is spread order, since declaring the overrides BEFORE `...world` would silently drop the
   model half. That is checked by reading the source (`...world` at literal position 22, the two
   overrides at 108 and 117) and by `typecheck`, not by a runtime assertion. Echo Isles melee never
   calls either native, so neither was exercised in the browser.

1d. ~~**The gold-mine table.**~~ **Done, and the guess in this entry was wrong — which is why it
   said "check before assuming".** It predicted a move onto `PlacedIndex` because "that table is
   map-placement state". It is not. `mineForScript` reads `simView.mines` — the **sim's** mine
   table, live world state — and `MINE_ID_BASE` is nothing but an id-space offset. So all five
   natives needed `SimWorld` alone and went straight into `simHooks` with no new owner and no
   `placement.ts` involvement at all. Renderer 91 → 86, `simHooks` 58 → 63, union still 149.

   **`MINE_ID_BASE` and `mineForScript` now live in [`jassHooks.ts`](../src/game/jassHooks.ts)**,
   exported. The base used to be a `private static` on `MapViewerScene`, which meant the fiction
   "to a script a gold mine IS a unit" was owned by the one participant that can never be the
   authority — and five natives plus the renderer's own enumeration all have to agree on it.
   `mineForScript` takes `{ readonly mines: ReadonlyMap<…> }` rather than `SimWorld`, so the
   renderer hands it `simView` and does not widen its grip on the world to resolve a handle.
   That mattered: the first cut passed `simWorld` and pushed the escape-hatch count **up** from 32
   to 33. The narrow type put it back to 32.

   `nearestMineNode` died with the move — `createBlightedGoldMine` was its only caller.

   **Verified in the browser, and this one genuinely was.** Echo Isles' melee start calls
   `MeleeGetProjectedLoc(GetUnitLoc(nearestMine))`, which runs through the moved
   `getUnitX`/`getUnitY` on a mine handle to clump the starting workers 320 units off the mine.
   Workers at the mine rather than at the map origin is that path working end to end. The
   regression test also fails correctly on the natural bug (returning a raw mine id instead of
   `MINE_ID_BASE + id`): two named checks red, `typecheck` clean.

1e. ~~**The vision + alliance group — 13 entries.**~~ **Done, and the blocker dissolved on
   inspection.** All 13 are in `visionHooks(vision, alliances)`
   ([`jassHooks.ts`](../src/game/jassHooks.ts)), built from `VisionSet` and `AllianceTable` —
   both of which already compiled standalone. Renderer 82 → **69**, `jassHooks` 69 → **82**: the
   two halves have crossed over, and more of the table now lives outside the renderer than in it.
   Union still 149, overlap still exactly the two dual-writers.

   **The stated blocker conflated two claims.** "Modifier ids are one global handle space shared
   with JASS, so N viewpoints minting their own would collide" is true — and it is an argument
   against putting the registry on a `Viewpoint`. It says nothing against putting it on the
   `VisionSet`, which is a *single object that owns every viewpoint*, i.e. exactly the one global
   counter the constraint asks for. Moving it there needed no decision revisited at all; it needed
   the sentence read twice.

   **A real bug came out with it, and item 2 is what created it.** `FogEnable`/`FogMaskEnable` are
   GLOBAL natives, but `RtsController` applied them to `this.local` only. That was invisible while
   one viewpoint existed and became wrong the moment every seat got one: a script disabling fog
   for a cinematic would have left every other seat's grid untouched, so a host answering for
   those seats would still be filtering their world by a fog the script had switched off. Now
   every viewpoint gets the switch. Applying to all is a **superset** of applying to local, so the
   local player sees exactly what it saw — but it is a deliberate behaviour change and is recorded
   as one. `isFogEnabled` reads any viewpoint, since the setters keep them in step.

   **Verified with two clients.** BOTH minimaps are byte-identical to the previous commit (0 of
   18 088 pixels each, max delta 0) — the registry move and the global fog switch did not move
   either player's fog by a cell — while the two frames still differ by 56.6%. Whole-frame drift
   0.487%, animation only.

   **NOT verified at runtime, and checked rather than assumed:** `MeleeStartingVisibility` in the
   real `Scripts\Blizzard.j` has its `FogMaskEnable(true)` and `FogEnable(true)` calls
   **commented out**, so a melee map never calls them. The 13 natives are covered by the headless
   checks only. A map with script-placed fog modifiers would be the way to exercise them.

1e-note. ~~**`isUnitAlly` was left behind deliberately.**~~ **Done in item 1g**, where it joined
   the other six roster natives rather than `simHooks` — it is a TEAM question, and it belongs
   with the natives that classify units rather than with the ones that mutate the world.

1f. ~~**The order-funnel natives.**~~ **Four of the five done; this entry was wrong about
   `removeUnit`.** It called `createUnit`/`removeUnit` both "entangled with model seeding".
   `removeUnit` never was — `RtsController.removeUnit` was a bare one-line pass-through to
   `sim.removeUnit`, and so was `killUnit`. Only `createUnit` is genuinely entangled, because
   spawning has to load a model. Renderer 86 → 82, `simHooks` 63 → 65, `authorityHooks` 2 → 4,
   union still 149.

   **`issueUnitOrder` moved onto `Authority`** (byte-identical modulo `this.authority.castOrder`
   → `this.castOrder`), which is where it belonged: it is not a plain sim write. It first asks
   `castOrder` whether the order string names one of the unit's own abilities and only falls
   through to move/attack/patrol/hold if not — an authority question, now sitting next to
   `execute`. It stays ungated on ownership, which Phase C already established is correct: a
   trigger order is an *effect of* the authoritative sim, not an input to it.

   **All four delegators were dead after the move** — each had exactly one caller, the hook table
   — so `issueUnitOrder`, `killUnit`, `removeUnit` and `currentOrderId` are gone from `rts.ts`
   entirely. **`rts.ts` 4 158 → 4 122**; `authority.ts` 539 → 585.

   The mine guard came with `removeUnit` and is the thing the new test pins: a mine handle must
   not reach `sim.removeUnit`. Dropping the guard leaves `typecheck` clean and turns two named
   checks red — confirmed by injecting it, restored after.

   **Left: `createUnit`.** It routes to `spawnScriptUnit`, which loads a model. It is the last
   member of this group and belongs with 1g below.

1g. ~~**`createUnit`, and the rest of the presentation half.**~~ **Partly done — and the "rest is
   presentation by nature" claim was wrong, which is the finding.** Seven more natives came out:
   `enumUnits`, `isUnitType`, `isUnitAlly`, `findPlacedUnit`, `playerStructureCount`,
   `playerUnitCount`, `playerTypedUnitCount`, now `rosterHooks(sim, registry, teamOf)`. Every one
   reads `sim.units`, `sim.mines` and the unit registry, with no renderer field anywhere. They had
   been filed under "camera, sound, weather, effects, text, selection, **registries**" — and a
   registry is a DATA TABLE, not presentation. Classifying by the company a word keeps is the same
   mistake Phase B paid for four times. Renderer 69 → **62**, `jassHooks` 82 → **89**.

   `unitSnapshots(sim)` is exported rather than private, because the renderer still drives
   `pumpRegions` each tick and must enumerate the world exactly as the natives do — two copies of
   that loop would be two answers to "what units exist". It takes the narrow
   `{ units, mines }` readonly type so the renderer passes `simView`; the first cut passed
   `simWorld` and pushed the escape-hatch count 32 → 33, exactly as in item 1d. Back to 32. Six
   dead private helpers deleted from the renderer with the move.

   **Still open: `createUnit`.** It is genuinely entangled, and the dual-writer trick from 1c does
   NOT fit: the renderer needs the RESOLVED position back (the authority snaps a building to the
   build grid and displaces a ground unit off a blocked cell), and `createUnit?(): number` can
   only carry an id. The right shape is the drain-queue this codebase already uses everywhere else
   — `drainSummonRequests`, `drainDeaths`, `drainTreePulses` — where the authority creates the
   unit and queues a spawn the renderer drains to attach a body. That is its own item, **1h**,
   because it changes the spawn path rather than moving a hook.

1h. ~~**`createUnit` via a spawn drain-queue.**~~ **Done. The 149-entry table is fully split.**
   `RtsController.createScriptUnit` resolves placement — a building snaps to the build grid, a
   ground unit created on a blocked cell is displaced to the nearest fit — creates the sim unit,
   and pushes a `ScriptSpawn` the renderer drains to attach a model. Renderer 62 → **61**,
   `jassHooks`/authority 89 → **90**. Union still 149; the only overlap is still the two
   dual-writers.

   **Why the drain queue and not item 1c's dual-writer trick**, which the list predicted:
   `createUnit(): number` can carry an id back and nothing else, and the renderer needs the
   RESOLVED position to put a model at. A decorator would have had to redo the snapping and hope
   it landed on the same cell. The queue carries both, and the codebase already does exactly this
   for summons (`drainSummonRequests`), deaths and tree pulses.

   **The synchronous contract is the thing to protect.** JASS `CreateUnit` is synchronous — the
   next statement may order or configure the unit — so the id comes back from the call itself and
   only the BODY is deferred. A queue-only version that returned 0 and let the drain assign an id
   typechecks fine and breaks every trigger that keeps the handle; that is what the new check
   pins, confirmed by injecting it.

   `setFootprintReader` injects the `pathTex` decode, because reading one is a VFS read and this
   half must not import an archive. Same injection shape as `teamOf`.

   **NOT verified at runtime.** Echo Isles seeds its melee roster through our own starting-units
   code rather than through the script, so the trigger `CreateUnit` path was almost certainly not
   called on the verification boot. Unit population, resources and fog were all unchanged, which
   says nothing regressed — not that this path works. A map whose triggers spawn units is what
   would exercise it.

**The hook table is now split, and here is what the 61 in the renderer are.** Camera and
cinematics, sound and music, weather, special effects, text and the leaderboard/dialog surface,
selection, the terrain-haze natives, `objectName`/`localizedString`/`itemTypeInfo`/
`chooseRandomItem` (data tables the renderer already holds), and the model-only unit mutators
(`setUnitScale`, `setUnitVertexColor`, `setUnitTimeScale`, `setUnitAnimation`, `setUnitColor`).
Every one is presentation, and a headless host **injects** these rather than moving them — most
as no-ops. That claim has been wrong twice in this phase (items 1g and 1e both found world natives
hiding in it), so it is worth re-checking rather than trusting, but the remaining list has been
enumerated by body rather than by name.

2. ~~**Create player viewpoints at match start, not lazily.**~~ **Done — and it was not small,
   because seating exposed a real bug the moment it was tested.** `VisionSet.seat(seats)` +
   `RtsController.seatPlayers`, called from `beginMatch` once the lobby's slots are known.
   Computer slots are seated too: a host simulates them, so they need their own fog for the
   acquisition gate exactly as a human does. Phase D item 4's `SetFogState` replay hole is closed
   by construction — there is no longer a "later" for a viewpoint to be created in.

   **The bug, which is 1c-note and is now fixed rather than merely recorded.** Seating states each
   viewpoint's OWN team from the lobby. But `seesFor(other)` asks `teamOfPlayer(other)`, and that
   still scanned `world.units` for a unit that player owns, falling back to the **slot number**.
   With no units seeded yet, two ALLIED players seated on one team did not render each other's
   fog — which is the entire point of a team. A plain 1v1 hides it completely, because there slot
   and team happen to be equal; the test uses players 0 and 3 on team 0 for exactly that reason.
   `VisionSet` now holds the seating and passes it into every `Viewpoint` it mints, so
   `teamOfPlayer` consults the lobby FIRST and keeps the unit-scan and slot-number as fallbacks
   for a world nobody seated. The whole seating is recorded before any viewpoint is built, or
   seating ORDER would decide whether two allies recognise each other.

   Shipping the seat without this would have meant a `team` field that nothing consulted. The
   check was written expecting to pass and went red on the first run — which is a better proof
   than injecting the bug afterwards, and is why it is kept.

   **Verified with two clients, which is the only way this could be shown.** Echo Isles, seed
   4242, `fog=unexplored`, players 0 and 1 in separate browser contexts: the frames differ by
   56.7%, each looking at its own base through its own fog. And the invariant that matters —
   player 1's **minimap is byte-identical** to the previous commit (0 of 18 088 pixels, max delta
   0), so seating every slot did not move the local player's fog by a single cell, while player
   0's minimap shows a different explored region entirely. Whole-frame drift 0.574% is animation
   only; the fog itself did not move. 118 and 144 fps with every seat holding its own 10 Hz grid
   (two browser instances sharing one GPU), against 116–144 measured before N viewpoints existed.

3. ~~**`dots()` and `creepCamps()` iterate `sim.units`, not `this.entries`.**~~ **Done, and the
   predicted local behaviour change did not materialise.** Both now walk `sim.units`;
   `buildCreepCamps` reads `u.level` instead of `Entry.level`, which Phase B item 4 flagged as
   worth revisiting. The two levels agree by construction — `addSimUnit` and the `Entry` literal
   both copy `def.level` — so camp difficulty colours are untouched.

   **The item predicted "units with no render record start showing dots". On Echo Isles there are
   none.** By the time the client reports in-game every model has loaded, so "units this machine
   drew" and "units that exist" are the same set. Four frames were captured to try to catch the
   transient — old and new, immediately at in-game and 8 s later — and all four minimaps are
   byte-identical (0 of 18 088 pixels). The move is invisible here, and that is the honest result
   rather than a weaker claim dressed up.

   **What it actually buys is unobservable from one client**: an authority answering for a player
   whose models this machine never loaded now gets dots at all, instead of an empty minimap. That
   cannot be shown until snapshots exist.

3b. ~~**`dots`/`creepCamps`/`hiddenFor` off the controller, so they can be tested.**~~ **Done.**
   [`src/game/minimapView.ts`](../src/game/minimapView.ts) holds `hiddenFor`, `minimapDots`,
   `minimapIcons` and `CreepCamps`; `rts.ts` keeps four one-line delegators, so no caller changed.
   It compiles standalone (seventh module to do so) and `rts.ts` 4 143 lines.

   **The move was for testability, and it immediately paid.** The new
   [`tools/sim-minimap-test.cjs`](../tools/sim-minimap-test.cjs) (23 checks) can finally assert the
   thing item 3 existed for and could not state: **dots computed for a viewpoint whose client
   rendered nothing.** In the test there is no renderer at all, so "units I drew" is empty by
   construction — under the old `this.entries` walk every one of those lists would have been.

3c. ~~**A garrisoned friendly still gets a minimap dot.**~~ **Fixed, and the fix waited on a
   measurement rather than on an argument.** The developer drove the real 1.27a client — a
   peasant sent to a remote gold mine, with no other unit or building of theirs nearby so the
   dot could not be confused with anything else — and reported: **no dot while it is inside.**
   That is the whole of what was missing; the reasoning below had been right since 3b and was
   not, on its own, grounds to change what the game draws.

   `isOffField(u)` is now tested first in `minimapDots`, on its own, and the `u.team === vp.team`
   clause is left doing only the fog job it reads like. Behaviour change, deliberate and
   measured: a unit in a mine, in a burrow, inside the structure it is building, swallowed by a
   Kodo, or `vanished` mid-Mirror-Image draws nothing — **not even for its owner**.

   **The predicate moved to [`world.ts`](../src/sim/world.ts) because there were about to be
   three copies of it.** `hiddenFor` had it, `visibilityFor` (item 6) had written it out again,
   and `minimapDots` was about to need it. A five-term disjunction in three places is three
   chances to add a sixth term to two of them. It sits next to `SimUnit` and is deliberately
   neither a fog nor an ownership test — whether the OWNER should still be told is a question
   each caller answers differently, and they disagree: the snapshot says yes (a Burrow must be
   able to list its garrison), the minimap says no.

   **Verified headlessly, and honestly not visually.** The check fails on the exact bug —
   deleting the `isOffField` guard leaves `pnpm typecheck` green and turns two named checks red,
   confirmed by doing it. In the browser the change is only observable during the few seconds a
   worker is actually inside the mine, and an A/B across two builds caught the peasant OUTSIDE
   in both frames (identical gold, identical idle-worker count, 2 pixels of difference from
   1px of position drift). Rather than keep hunting that window, the developer's measurement of
   the real client stands as the authority and the headless check as the regression guard.
   `sim:test` 373 → **374**.

3c-old. **The original entry, kept because its reasoning is what found the bug.** Found while
   writing 3b's test, pinned
   rather than fixed. `minimapDots`'s `|| u.team === vp.team` looks like "your own army shows
   through the fog", but `Viewpoint.fogHides` **already** returns false for your own team — so the
   clause cannot be about fog. The only thing it overrides is the viewpoint-INDEPENDENT half of
   `hiddenFor`: `inMine`, `insideBuild`, `inBurrow`, `devouredBy`, `vanished`. So a peasant inside
   a gold mine and a worker in a burrow each draw a dot at the spot they entered from. The real
   1.27a client gives garrisoned and mining units no dot of their own. Pre-existing — the clause
   was carried across byte-for-byte by items 3 and 3b — so it is asserted as current behaviour in
   the test, flagged there in capitals, and left for a deliberate fix. **Check the running client
   before fixing**, per CLAUDE.md; the suspicion above is from memory of WC3, not from measurement.

   **Still open, and deliberately skipped once (item 5's iteration) rather than fixed on a
   hunch.** The measurement needs the real 1.27a client driven with global mouse/keyboard —
   launch, melee game, send a peasant into a mine, read the minimap — and the developer's
   desktop was in active use at the time, which makes input injection somebody else's problem
   rather than a test. The fix itself is one line (`hiddenFor`'s viewpoint-INDEPENDENT half must
   win over the own-team clause); what is missing is the ground truth that says it is a fix.
   Take it when the machine is free.

4. ~~**Decide whether `minimapIcons()` should have a fog gate.**~~ **Closed: no gate, and it was
   already answered in the code.** The comment above `minimapIcons` records the measurement —
   both glyph types "were plainly visible over unexplored ground in a fresh 1.27a melee game" —
   so somebody drove the running client, which is what Phase D asked for and what CLAUDE.md
   requires. No behaviour change. The absence of a gate is now **asserted** in the test rather
   than merely described, so adding one later goes red and has to be justified against the game.

   It was not a pure doc close, though: `minimapIcons` still walked `this.entries` and read
   `Entry.typeId`, the same defect item 3 fixed in its neighbours. It moved to `minimapView.ts`
   with them and now reads `sim.units` + `sim.mines`.
5. ~~**The snapshot: a type, and `snapshotFor(player)` on the authority side.**~~ **Done.**
   [`src/game/snapshot.ts`](../src/game/snapshot.ts) holds `WorldSnapshot` / `UnitSnapshot` /
   `MineSnapshot` / `GroundItemSnapshot` and the producer
   `snapshotFor(world, viewer, recipient, time)`. It compiles standalone (the **eighth** module
   to), imports no transport and no renderer, and **nothing imports it yet** — so this commit
   cannot move a pixel, which is stated here rather than dressed up with a screenshot.

   **The field set was read off the consumers, not off `SimUnit`.** ~150 fields on the struct,
   about 60 read by the client half. Everything else — the pathing scratch values, the
   stuck/stall timers, every `base*` baseline `recomputeStats` derives from, `SimMine.busy`,
   `BuildingState.builderIds`/`goldCost`/`stock` — is how the sim REACHES its answers rather
   than the answers, and shipping it would hand a client the means to second-guess the
   authority. The enumeration walked `rts.ts`'s entry sync + `infoFor` + the health bars,
   `mapViewer.ts`'s command card and effects, `minimapView.ts` and `viewpoint.ts`. Same
   discipline as 1c–1h, and it held again.

   **`snapshotFor` takes a recipient already, and the reason is not fog.** Two classes of
   field are per-recipient without any reference to the grid, so they are answered here:
   - **The illusion mask.** `docs/illusions.md`: to an enemy an illusion reports as an ordinary
     unit. The client gets that right TODAY by reading `isIllusion` and discarding it
     (`applyFogTint`, `infoFor`) — correct behaviour, wrong architecture, because a filter
     applied after the bit crossed the wire is a filter a modified client deletes. Now the bit
     never leaves. The summon TRIPLE is masked with it, not just the flag: a bar counting down
     over one of two identical Blademasters is as loud a tell as the flag. A real Water
     Elemental is untouched — masking every summon is the lazy over-correction, and there is a
     check for it.
   - **Private intent** (`buildPending`, `orderQueue`, `pendingCast`). Gated on OWNERSHIP, not
     `seesFor` — an ally does not get to see where you are about to drop a tower either. That
     is the one gate deliberately narrower than the illusion one, and the pair of them is why
     the signature takes a viewer AND a recipient instead of deriving one from the other.

   **No `Authority.snapshotFor` delegator was added.** The free function already sits on the
   authority side of the seam and `Authority` does not hold the `VisionSet` the viewer comes
   from, so a forwarding method would have been a one-caller delegator with, right now, zero
   callers — exactly what item 1f found was dead weight four times over. Item 9/10 wires it
   from wherever the tick loop ends up.

   **The AoI question is NOT here, on purpose.** Until item 6 lands a snapshot describes the
   whole world and is not safe to send to an opponent. Nothing sends it.

   **The test is [`tools/sim-snapshot-test.cjs`](../tools/sim-snapshot-test.cjs) (22 checks),
   and both bugs it exists for were injected.** Spreading the sim unit into the payload — the
   plausible "simplification", since it renders identically — leaves `pnpm typecheck` green and
   turns *no sim-internal field survives the trip* and *enemy sight radii are not derivable
   client-side* red. Reading `u.isIllusion` straight through likewise typechecks and turns *the
   enemy is not* red while the owner and ally checks stay green. Restored after both. There is
   also a JSON round-trip check, because "JSON first" makes a stray `Map` in the payload
   (`BuildingState.stock` is the live one) a thing that survives the compiler and dies on the
   wire. `sim:test` 323 → **345**.

6. ~~**AoI filtering, as a predicate distinct from `fogHides`.**~~ **Done — and it is not a
   predicate, which is the finding.** `visibilityFor(viewer, u)` in
   [`snapshot.ts`](../src/game/snapshot.ts) returns **`"live" | "remembered" | "omit"`**, and the
   third value is not an embellishment: it is the one case `fogHides` deliberately answers
   "draw" to. WC3 leaves the last-seen image of an enemy STRUCTURE standing in the fog, so
   `fogHides` is false for a building you saw an hour ago — while its live hp, construction
   timer and production queue are things you demonstrably do not know. Sending the record whole
   leaks exactly what the fog exists to withhold; omitting it deletes a building off the
   player's screen that the real game keeps there. Two-valued is wrong in both directions.

   **The rule needed no new fog logic, only the observation that the existing pair already spans
   three states.** `fogHides` false + `fogBlocksClick` true IS "drawn from memory" — the
   distinction issue #62 was opened for (you can see the Goblin Merchant across the map; you
   cannot shop at it). `SnapshotViewer` grew from one method to five and `Viewpoint` already
   satisfied all of them.

   **The redaction needs no per-viewpoint history, and the reason is worth stating** because it
   looks like it should. A remembered record would in general have to carry where the thing was
   WHEN SEEN — per-recipient memory the authority would have to keep and age. It does not,
   because **the only things WC3 remembers are buildings, and a building's last-seen position is
   its current position**. The memory case collapses into a field mask. That is the whole of why
   this fitted one move instead of three.

   **What each of the four rules turned out to be:**
   - **Off-the-field** (`inMine`/`insideBuild`/`inBurrow`/`devouredBy`/`vanished`) is a `seesFor`
     gate, **not a drop**. It looks like "gone for everyone" — `hiddenFor` treats it that way —
     but the owner still needs them or a Burrow could not list its garrison and a mining peasant
     would blink out of its owner's own world. An enemy gets nothing.
   - **Undetected invisibility is the sharp one and `fogHides` says nothing about it.** The
     client ORs the two, which is right for drawing and far too weak for sending: a Wind Walking
     hero standing in plain sight is `fogHides === false`. A send rule written as "if fogHides,
     drop" passes every other check in the suite and puts that hero's coordinates in the enemy's
     payload. There is a check for exactly that, and it goes red on exactly that edit.
   - **A mine is always sent and its gold is not** (`-1`, not `0` — an empty mine and an
     unscouted one are different facts, and conflating them would route workers away from a full
     expansion). Omitting the mine was the tempting symmetry and it is wrong: `minimapIcons`
     paints the glyph over unexplored ground *deliberately*, measured against the real client in
     item 4, so dropping it would put a hole in the minimap the real game does not have.
   - **A ground item gets no memory at all.** `fogBlocksAt`'s own comment says why: an item is a
     live widget that vanishes with the eyes on it, not a building whose image persists.

   **A structural interface has a hole this move had to close.** `SnapshotViewer` is structural
   so `snapshot.ts` need not import the fog implementation — but that means the test's own stub
   satisfies it *by construction*, so the interface could drift away from `Viewpoint` with every
   suite green until they were finally wired at item 9/10, which is the worst moment to find
   out. [`tools/snapshot-viewer-conformance.ts`](../tools/snapshot-viewer-conformance.ts) is a
   compile-time-only assertion that a real `Viewpoint` is a `SnapshotViewer`; `tsc -p
   tools/tsconfig.sim.json` runs it on every `pnpm sim:test`. Confirmed it bites by adding a
   method to the interface — `TS2741: Property … is missing in type 'Viewpoint'`.

   **Both bugs the rule exists to prevent were injected.** Collapsing `remembered` into `live` —
   the "AoI filtering is just fog" mistake — leaves `pnpm typecheck` green and turns **9** checks
   red. Dropping the invisibility gate turns 2 red. Restored after both. `sim:test` 345 → **373**.

   Illusions were already handled at the source in item 5 and did not need touching here.

6b. ~~**A remembered building that has been DESTROYED stops appearing.**~~ **Done.**
   [`src/game/ghosts.ts`](../src/game/ghosts.ts) `GhostMemory` — `noteDestroyed(u, viewers)`,
   `forgetSeen(player, viewer)`, `ghostsFor(player)` — and `snapshotFor` takes an optional
   `ghosts` list it prepends. **Ninth module to compile standalone**; nothing imports it yet, so
   this commit cannot move a pixel.

   **The developer's measurement decided both rules, and one of them is not the obvious one.**
   The client keeps the image until you re-scout: no timeout, no decay, cleared by SIGHT of the
   cell. So forgetting is one `fogBlocksAt` test per ghost per rebuild, and it is
   self-correcting — the same eyes that would refresh a live building's record clear a dead
   one's.

   **A ghost is minted only for a viewer who was NOT watching**, and the test is
   `visibilityFor(...) === "remembered"`, not `!== "omit"`. If you are looking at a Barracks
   when it burns down you SAW it burn down, and leaving an image standing would be a lie the
   real client does not tell. That distinction falls straight out of item 6's three states — the
   second time that split has paid for itself, after it turned out to be what the AoI rule
   needed too.

   **The ghost's record is `rememberedUnit`'s, byte for byte.** A dead building must not be MORE
   informative than a live one you cannot see, and a second redaction would be a second rule to
   keep in step. It also means nothing downstream can tell a ghost from a live memory, which is
   correct: to the player they are the same image.

   **Only structures leave one.** WC3 leaves no image of a dead footman — a mobile unit has no
   last-seen position worth trusting, which is the fog "concealing enemy movements" doing its
   job.

   **This is the first genuinely per-recipient HISTORY the authority carries**, and item 6 got
   to avoid it for a reason worth restating: a LIVE remembered building needs no history because
   its last-seen position is its current position, so the record is derivable on the spot. A
   dead one has no current position to derive from, so somebody has to have written it down.

   Three injections, each turning exactly one named check red with `typecheck` clean: minting a
   ghost for the watcher (`!== "omit"`), dropping the structures-only guard, and inverting the
   forget test so sight keeps rather than clears. `sim:test` 374 → **386**.

6c. ~~**Nothing calls `noteDestroyed`.**~~ **Done, and it was not the tick-loop wiring this
   entry called it — there was a real obstacle in the sim.** `GhostMemory.noteDestroyed(u, …)`
   needs the UNIT: where it stood, what it was, whose it was. `SimWorld.kill` does
   `this.units.delete(u.id)` on the line **before** `this.deaths.push(u.id)`, so by the time
   anybody drains, the id resolves to nothing and no drain-based caller could ever have
   supplied it. The trigger engine hit this exact wall two lines further down and left the note
   that gave it away: *"the victim is gone from `units` next tick"*.

   **So the sim now hands the structure over whole.** `SimWorld.drainDeadStructures(): SimUnit[]`
   alongside the existing `drainDeaths(): number[]`. Only buildings are pushed — that is the
   rule (WC3 leaves no image of a dead footman) rather than an optimisation, and it keeps the
   list naturally tiny since structures die a handful of times a match. The unit is handed over
   as-is rather than copied: it has just left the world so nothing will mutate it again, and
   `GhostMemory` immediately reduces it to a redacted `rememberedUnit`.

   **Ordering in the tick is load-bearing and stated in the code.** Dead structures are offered
   to the memory BEFORE the fog rebuilds, so each viewpoint is judged on the sight it had when
   the building fell rather than on sight it gains this tick — otherwise a player whose scout
   arrives the same tick would be handed a ghost of something they are looking at. `forgetSeen`
   runs on exactly the viewpoints `VisionSet.tick` reports as rebuilt, which is the moment their
   sight changed. `VisionSet.viewerSeats()` pairs each viewpoint with its player (named around
   the existing private `seats` field).

   **Verified in the browser, because this one runs every tick on the live path** — unlike 5, 6,
   6b and 9. Echo Isles seed 4242: boots and plays at 144 fps with 103 units, and the minimap is
   **byte-identical to the parent commit** (0 of 18 088 pixels) across a stash/restore A/B.
   `sim:test` 386 → **392**; two injections (dropping the structures-only guard, and a drain that
   does not clear) each turn their own checks red.

6d. ~~**The local player still loses a destroyed building off its own screen.**~~ **Done in
   [10c-2c-5](#remaining-work-in-order-2)**, where it was deferred to and for the reason stated
   below — `onDeath` asks the payload for permission before it collapses anything. *(Original
   entry follows.)* This is a
   RENDERER-only change — `onDeath` and the corpse path — so no headless test can reach it
   (`sim:test` and `loopback` have no renderer), and staging it in a browser needs an enemy to
   raze a building you scouted and left, a two-client scenario that is expensive even with the
   LAN harness. Doing it now would produce a renderer change with no test and no cheap proof.
   It belongs with 10c, where the client's render source becomes the snapshot: at that point
   `onDeath` is already being reworked to read the authoritative world, and a `remembered`
   building simply never receives a death to animate. Fixing it in isolation first would be
   throwaway. The memory is now
   correct and nothing RENDERS it. `rts.ts` `onDeath` plays the collapse and adopts the model as
   a corpse the moment the sim reports the death, whether or not this client can see the spot —
   so a building you scouted and walked away from vanishes when its owner razes it, where the
   real client keeps the intact image until you re-scout. Fixing it means `onDeath` consulting
   the local viewpoint and, for a building it holds as `remembered`, leaving the model standing
   frozen instead of playing Death, then hiding it when `forgetSeen` clears the ghost. That is a
   renderer change entangled with the corpse path, it is the VISIBLE half of 6b, and it is hard
   to stage (it needs an enemy to raze a building you have scouted and left).

6b-old. **The original entry.** WC3 keeps the ghost image
   until you re-see the spot; ours vanishes the moment the building leaves `world.units`, because
   that is what `visibilityFor` classifies. Found while writing 6, **pre-existing rather than
   introduced** — the client has the same hole today for the same reason (`fogHides` reads live
   units), so it is not a regression. It is now a hole in a payload rather than in a render loop,
   which is a better place to fix it from: the authority would have to keep a per-viewpoint
   last-seen set of destroyed structures and emit them as `remembered` until the cell is seen
   again. That IS the per-viewpoint history item 6 got to avoid, so it is its own item.

   **MEASURED — the developer drove the real 1.27a client: it keeps the ghost image until you
   re-scout the spot.** So there is no timeout to model and no decay: the memory persists
   indefinitely and is cleared by SIGHT of the cell, which is the same trigger that would
   refresh it. That is the cheapest possible rule and it settles the design — the authority
   keeps, per viewpoint, the last-seen record of any structure that has since left
   `world.units`, and drops it the moment `fogBlocksAt` goes false for its cell. Still its own
   item because it is the first piece of genuinely per-recipient HISTORY the authority has to
   carry, and it wants its own test (a building destroyed out of sight stays; the same building
   re-scouted disappears).

7. ~~**`forAudience` gets its caller.**~~ **Done for the broadcast half — and the caller is NOT
   snapshot construction, which is what this entry predicted.** A snapshot is per-recipient
   STATE, rebuilt every tick from the world. A text message is an EVENT that happens once, at
   the moment the script fires it, and is delivered N times. Waiting for snapshot construction
   to carry it would have meant queueing messages into world state and diffing them back out —
   the wrong shape for something with no duration. So `Runtime.broadcast(fn)` in
   [`runtime.ts`](../src/jass/runtime.ts) is the caller: it fans out over the seats and wraps
   each delivery in `forAudience`.

   **The bug it fixes is real and was invisible in single-player.**
   `DisplayTimedTextFromPlayer` — the native behind "Player 1 was victorious." — resolved
   `localViewer` **once** and delivered to exactly one seat. Right while each client simulated
   its own match; wrong the moment a host answers for N players, where every seat but the host's
   would simply never be told who won. `ClearTextMessages` had the same shape (and had been
   hardcoded to slot 0 before the lobby could say otherwise). Both are broadcasts by definition:
   `ClearTextMessages` wipes every player's log, which is why cinematics open with it.

   **`viewers()` is who has a SCREEN, and it deliberately disagrees with the viewpoint seating.**
   Playing + `MAP_CONTROL.USER`. A computer slot gets a `Viewpoint` (item 2 — it needs fog for
   its acquisition gate) and gets no messages, because a message shown to nobody is not a
   message. Merging the two lists would either hand an AI a chat log or take a human's fog away.
   Sorted, because a broadcast arriving in slot order on one host and hash order on another is a
   replay that does not reproduce. Empty `viewers()` falls back to the host's own seat, which is
   every headless corpus run and every single-player boot.

   **The `forAudience` wrapper is separately load-bearing, and the test proves it separately.**
   The invariant at a per-recipient boundary is that while delivering to `p`, the runtime's
   answer to `GetLocalPlayer` must BE `p` — otherwise the hook is called with one recipient
   while the runtime privately believes another, which is the desync class Phase D item 6 built
   `audience` for. Confirmed by injecting: dropping the wrapper but keeping the fan-out leaves
   *all three were told* green and turns only *recipient and localViewer agree throughout* red.

   **Verified in the browser, and this one could actually move a pixel** — unlike items 5 and 6,
   `runtime.ts` and `text.ts` are on the live path. Echo Isles, seed 4242: the client boots and
   plays (144 fps, 103 units, resources and food normal), and the **minimap is byte-identical to
   the parent commit** (0 of 18 088 pixels, max delta 0) across a stash/restore A/B. Local
   behaviour is unchanged by construction too: a 1-human melee has `viewers() === [localPlayer]`,
   so the fan-out makes exactly the one call it made before, to the same seat.

   **NOT exercised at runtime:** Echo Isles melee never calls either native on a normal boot —
   `MeleeVictoryDialogBJ` needs the game to actually end, and melee runs no cinematic. The
   fan-out is covered by the headless checks only. `jass:test` audience 9 → **13**.

7b. ~~**Per-recipient evaluation of a `GetLocalPlayer`-gated block.**~~ **Done.** A MAP script
   (not blizzard.j) writing `if GetLocalPlayer() == Player(5) then … endif` used to evaluate ONCE
   on the host, as the host — so the block ran for the wrong person or, more often, for nobody.
   It is now evaluated once per seat.

   **Detection is a PROBE, not a parse.** `Runtime.localViewerReads` counts how many times
   `GetLocalPlayer` has been answered; the interpreter snapshots it around an `if`'s CONDITIONS
   and compares. Any route to the native counts — direct, or through a BJ wrapper — so no shape
   has to be recognised. A counter rather than a flag because probes nest. **Its honest limit,
   stated because it is real:** only the conditions are watched, and a later branch's condition
   that was never reached is unknown rather than assumed.

   **The developer's decision on world writes, and it was a third option neither side of the
   original question had.** The entry framed it as enforce-the-contract vs accept-the-risk.
   Sizing the work turned up a better answer: **the HOST's own pass runs exactly as it always
   has, and only the EXTRA passes are muzzled.** So a world write inside a gate happens exactly
   once — never N times (which corrupts the authority's world silently, worse than the desync
   real WC3 gives such a map) and never zero times (which would change behaviour for maps that
   work today). World behaviour is therefore *identical* to before this item; only presentation
   became per-recipient, which is all 7b was ever for.

   **The muzzle cost nothing to classify, which is why the third option was available at all.**
   Every world write goes through `rt.hooks.<name>`, and that key set is already named in one
   place: `RtsController.worldHooks()` composes `simHooks` + `authorityHooks` (items 1–1d), so
   `Object.keys` of it IS the answer — computed, never transcribed, and it cannot drift from the
   table it describes. The interpreter is TOLD the set (`worldWritingHooks`) rather than deriving
   it: it stays engine-agnostic and never learns which of its natives touch a `SimWorld`.
   Refusal costs nothing at the call site either — every native already writes
   `hooks?.x?.(…) ?? fallback`, so a muzzled entry takes the same path as one the host never
   implemented, and says so once in the console.

   **Two guards that are not obvious and are each pinned by an injection.** The fan-out is
   skipped when `rt.audience !== null` — inside a `forAudience` the runtime has already resolved
   who is watching, and fanning out again is N passes of the same block for the same person. And
   the host's seat is skipped in the re-run loop, because it already ran, as itself, unmuzzled.

   **Tests: `jass:test` audience 13 → 20.** The gated call fires for the recipient it names (it
   fired for nobody before); a world write inside a gate true for all three seats lands exactly
   once, from the host's pass; **the same block unguarded lands three times** — the corruption
   the decision prevents, demonstrated rather than argued; an `if` that never asks who is
   watching runs once; and a gate inside a `forAudience` does not fan out again. Three
   injections: a probe that never fires, extra passes left unmuzzled, and the re-entrancy guard
   removed — each turns its own checks red.

   **Not visible in the browser, and that is checkable rather than an excuse.** Echo Isles is a
   melee map: blizzard.j's own `GetLocalPlayer` sites are already intercepted at the `…ForPlayer`
   wrappers (item 7), and its war3map.j has no direct gate. A real melee boot logged **zero**
   refusals and the single-player minimap is byte-identical to the parent (0 of 18 088) — which
   is what "world behaviour is identical" should look like from outside. The per-recipient
   behaviour itself is covered headlessly, where a three-seat lobby can be built in a line.

8. ~~**An in-process transport adapter, and the reconnect test that rides on it.**~~ **Done, and
   it turned into an extraction rather than a new implementation.** The entry assumed writing an
   adapter alongside `WebSocketTransport`. The obstacle was one layer down: the thing worth
   simulating in-process is not the transport, it is the RELAY, and the relay's routing lived
   inside `server/relay.mjs`'s WebSocket callbacks. Writing a second copy of a room table is
   writing two sets of rules that agree until the day they do not — and the copy that would
   drift is the one no test covers.

   **So the rule got one home and two adapters.** [`server/rooms.mjs`](../server/rooms.mjs)
   `RelayCore` holds the rooms, peer ids, the host-leaves-closes-the-room rule and the
   `relay`→`deliver` fan-out, with no socket in it; a "connection" is anything with `send(msg)`.
   [`relay.mjs`](../server/relay.mjs) is now only the WebSocket adapter — the port, the JSON
   framing and the parse error, which are the three things genuinely about a wire. It stayed
   plain `.mjs` with no build step, so it still deploys on its own.
   [`tools/loopback.mjs`](../tools/loopback.mjs) is the in-process adapter over the SAME core.
   **The extraction is proved by the test that already existed**: `pnpm relay:test` drives the
   real server over real sockets and passed unchanged.

   **Two properties of the loopback are deliberate, and both are about not being easier than a
   socket.** Delivery is asynchronous (`await tick()` is the "let the network settle" step), so
   a test cannot come to depend on an ordering no real transport gives. And messages are
   serialised **at `send()`**, not at delivery — because `ws.send(JSON.stringify(msg))` freezes
   the payload at the moment of the call, and a caller that reuses its message object must not
   be able to change what is already on the wire.

   **The copy discipline is where this move actually paid, and it exposed a flaw in my own
   adapter.** The first version copied on the way out AND on the way in, and the first test
   asserted "the sender's payload survives" — which either copy alone guarantees, so deleting
   either one left every check green. Classic "something else was doing the work". Chasing it
   down showed the outbound copy was taken *inside* the delivery microtask, so it snapshotted
   nothing a socket would: it was defence-in-depth that defended nothing. Moving it to `send()`
   made it mean something, and the two copies now protect two different things with a check
   each — freeze-at-send (a caller mutating its message before delivery) and copy-per-arrival
   (two recipients of one broadcast sharing an object). Each fails only when its own copy is
   removed; confirmed by removing each.

   **The reconnect test is written now, and it pins the gap rather than a fix.** Item 11 does
   not exist yet, so the checks say what happens TODAY — a dropped client comes back with a NEW
   peer id, is told nothing about the match in progress, and has nothing replayed to it. Same
   discipline as item 3c: labelled as current behaviour, so landing item 11 has to change them
   on purpose instead of filling a gap nobody notices. `LoopbackTransport.drop()` is deliberately
   a separate verb from `close()` even though the relay cannot yet tell them apart — a drop must
   hold the slot and a leave must free it, and that is exactly what item 11 has to add.

   `pnpm relay:test` now runs both; `pnpm loopback:test` runs the new one alone. **22 loopback
   checks**, and no file under `src/` was touched — the client bundle is byte-for-byte the same,
   which is why there is no screenshot here.

9. ~~**Commands cross the wire.**~~ **Half done — the wire format and the host's door, not the
   client's `execute`.** [`src/net/commandLink.ts`](../src/net/commandLink.ts) adds the
   `CommandMessage` member (`{ k: "cmd", cmd }`) to `GameMessage` and `CommandRouter`, which
   turns a delivered envelope into a judged `(player, cmd)` or a stated refusal. **Tenth module
   to compile standalone.** Nothing calls it yet, and both references from `protocol.ts` are
   type-only, so no runtime import was added and the client bundle behaves identically.

   **The security content is one rule, and it is a DIFFERENT hole from Phase C's.** Phase C
   gated a faked `unitId`: `Authority.execute` asks "does player P own unit U". That gate is
   useless against a client that simply claims to BE player P — it would wave through spending
   another player's gold, cancelling their buildings, walking their army off a cliff. So the
   sender's identity must never come from the payload, which the client controls entirely. It
   comes from the relay's `from` stamp, which `server/rooms.mjs` writes from the peer id it
   assigned at join time and no client can author. `CommandRouter` resolves that stamp through
   the seating the host already broadcast in `StartMatch`, so there is no second source of truth
   about who sits where, and an unseated peer is refused rather than guessed at.

   **A computer slot has no `peer` and therefore cannot be spoken for from the wire**, which is
   correct — the host simulates it. That is why the seating test is `s.peer !== undefined` and
   not `if (s.peer)`: **peer id 0 is a real peer**, and the truthy version silently unseats it.
   There is a check for exactly that, and it goes red on exactly that edit.

   Refusals are RETURNED, not thrown. A hostile or merely buggy peer must not be able to
   interrupt the host's tick by sending rubbish on the game channel.

   The module imports no `Authority`, no sim and no transport — it judges and stops. `pnpm
   relay:test` now carries **34** loopback checks; the two injections (trusting a `player` field
   in the payload, and the truthiness seating check) each turn exactly one named check red.

9b. ~~**The client's `execute` becomes *send*.**~~ **Done — as *also-send*, not *become-send*,
   which sequencing B is the whole reason for.** The entry predicted "stop executing locally and
   start sending". Under B the client keeps simulating as a prediction, so `RtsController.execute`
   still applies to the local sim AND, on a client, forwards the local player's accepted command
   to the host. The host applies it to the authoritative sim; every other client learns the
   result from its snapshot. Item 9 built the receiving door (`CommandRouter`); this is the
   sending side plus wiring that door to `Authority.execute` on the host.

   **The command is aimed at the host, not broadcast, and that is the design in one line.**
   Authoritative-host means only the host applies a command. Broadcasting instead — every client
   applying every command — is lockstep, a different model with a different desync surface. A
   `hostPeer` now rides in `MatchLinkSetup` (the room creator's relay peer, `peers.find(p =>
   p.host)`), and `MatchLink.sendCommand` addresses it. A 2-peer room cannot tell the two apart
   (the host is the only "everyone else"), so the check that pins it needs a THIRD seat: a second
   client must not receive a peer's command. It went red on the broadcast injection.

   **Identity stays the relay's stamp, never the payload** (item 9's whole point). The host's
   `onCommand` runs the arriving envelope through `CommandRouter.receive(from, msg)` — `from` is
   the relay's unforgeable stamp — and only an accepted `(player, cmd)` reaches the SAME
   `Authority.execute` a local action goes through. So a peer's order is judged by exactly the
   rule the host's own is, and a faked `unitId` (Phase C) or a faked player (item 9) is refused
   identically whether it came off the wire or off the keyboard.

   **`MatchLink` now demuxes three ways** — snapshots consumed internally, commands surfaced to
   `onCommand`, anything else passed through — so a future message type touches no seam. Dropping
   the command branch turns four checks red (commands fall through to the passthrough and never
   reach the router). `matchLink` still compiles standalone; it imports only the command
   *envelope* from `commandLink`, no `Authority`.

   **Local behaviour is unchanged by construction.** In single-player `this.matchLink` is null,
   so the forward branch is skipped and `execute` is byte-for-byte its old self. `invariant:
   applyOrder still 0 in rts.ts` — the host's receive path goes through `execute`, the public
   door, never `applyOrder`.

   **Verified:** `loopback` 51 → **56** checks driving the full path — client `sendCommand` →
   relay stamp → host demux → `CommandRouter` → the execute stand-in — plus the host-aimed and
   demux injections. Single-player A/B in the browser: minimap byte-identical to the parent
   (0 of 18 088 pixels), confirming the live `execute` path did not move. **NOT driven in the
   browser: an actual order issued on one client reaching the other's host** — that needs unit
   selection and order-issuing across two WebGL contexts, and the agent-browser daemon is
   unreliable under two at once (same wall as 10b-harness-shot). The wire path is covered end to
   end headlessly; only the click-driven capture is deferred.

10. **Snapshots cross the wire.** ~~Sequencing unsettled.~~ **DECIDED by the developer: B — the
    client renders snapshots AND keeps simulating**, so the two can be compared and the
    difference logged. A good bug-finder and a bad shipping state, taken knowingly; tearing the
    local sim out is its own follow-up once the log is quiet.

10a. ~~**The divergence detector.**~~ **Done** — [`src/game/divergence.ts`](../src/game/divergence.ts),
    the thing option B exists for. "They drift" is a bug report nobody can act on; "unit 41's hp
    is 260 here and 245 there" is a lead. **Eleventh module to compile standalone**; nothing
    imports it yet.

    **It compares two SNAPSHOTS, never a snapshot against a live world.** The local side goes
    through the same `snapshotFor`, so both are the same shape, redacted by the same rules, for
    the same recipient — which is what makes a finding mean "these two worlds disagree" rather
    than "these two representations disagree". A comparator reading the local `SimUnit` directly
    would report the AoI redaction and the illusion mask as drift on every tick and drown the
    signal on its first run.

    **Two rules earned by getting them wrong first:**
    - Floats compare with tolerance (0.5 world units). Two sims stepping the same movement over
      different numbers of frames land fractionally apart every tick.
    - A `remembered` record is compared only on what it CLAIMS to know. The first version of
      this check did not reach that branch at all — both sides went through the same viewer, so
      both were redacted to zeros and deleting the rule changed nothing. It only bites when the
      two sides **disagree about visibility**, which is what a client one fog-rebuild out of
      step looks like.

    **And that fixed test immediately found a real flaw: `remembered` must not itself be
    compared.** It is a fact about the OBSERVER's fog, not about the world. Both sides rebuild
    their grid on their own 10 Hz clock, so they disagree by one rebuild constantly — skew, not
    drift — and diffing it would put a finding on the log for every fogged structure several
    times a second, burying the one line that matters.

    `extra` (local has a unit the authority did not send) is reported but deliberately NOT
    called drift in its message: the authority withholds what the recipient cannot see, so it
    may simply be fogged. The report is capped (24 by default) because a desynced world produces
    one finding per unit per field, and the `ignore` list is **empty by default on purpose** — a
    field silenced before anybody understood why it was noisy is a desync nobody will ever find.
    `sim:test` 392 → **407**.

10b. ~~**The match channel, and the pump.**~~ **Done — and the seam already existed.**
    [`src/game/matchLink.ts`](../src/game/matchLink.ts) `MatchLink`: the host builds one
    snapshot per recipient at 10 Hz and sends it; a client keeps the newest and diffs it against
    what it simulated. **Twelfth module to compile standalone.** This is the first time in the
    whole phase that the authority's payload reaches another endpoint, tested end to end through
    the real `RelayCore`.

    **`MatchChannel` is a two-method structural type, and `LanLobby` already satisfies it.** The
    entry predicted inventing a seam; `send(data, to?)` and `onPeerData(from, data)` were both
    already on `LanLobby`, and `onPeerData` was already the "everything that is not `start`"
    hand-off. So the game layer names what it needs and never imports the lobby — which matters
    in the other direction too: importing it would have made the authority depend on the lobby
    UI and undone Phase B/C/D's separation from the far end.

    **Three refusals, each its own check.** A snapshot addressed to another player is dropped
    (`recipient` is carried in the payload for exactly this — item 5 — so it is *noticed*, not
    quietly drawn as ours). One older than what we hold is dropped and **counted**, because over
    a relay "arrived later" and "happened later" are different claims and a rising `stale` count
    is itself a diagnostic. And traffic that is not a snapshot is passed through untouched, or
    wiring this would silently swallow the command stream that shares the channel.

    The host skips its **own** seat — it is already looking at the authoritative world, and a
    round trip to learn what it knows is waste — and skips computer slots, which have no peer
    and nobody watching. `sent === 1`, not 3, in a 1v1-plus-AI room.

    `pnpm relay:test` now carries **47** loopback checks. Three injections, each turning its own
    checks red: dropping the recipient guard, the staleness guard, and the pass-through.

10b-note. ~~**Nothing constructs a `MatchLink` yet.**~~ **Done.** `fdfLan.enter` assembles a
    `MatchLinkSetup` — the lobby as the channel, the local SLOT resolved from `slots.find(s =>
    s.peer === myPeer).id`, the seating, and `isHost` — and passes it through
    `onStart(path, info, config, link)` → `startGame` → `MapViewerScene.attachMatchLink` →
    `RtsController.attachMatchLink`. It is built THERE because the LAN screen is the last place
    the lobby and the seating exist together; `startGame` disposes the glue and never sees the
    lobby. `RtsController.driveMatchLink` runs once a tick: the host emits a snapshot per
    recipient, a client diffs the newest arrival against its own sim and `console.warn`s a
    single grouped `[sync]` line per tick when they disagree. **Six modules stopped being
    unimported at once** — `snapshot`, `ghosts`, `divergence`, `matchLink`, and the AoI/command
    rules they carry.

    **Behaviour is unchanged for a single-player game, and that is checked rather than
    asserted.** `devBoot` calls `startGame(file, info, config)` with no `link`, so the dev-boot
    path builds no `MatchLink` and `driveMatchLink` returns on its first line. Echo Isles seed
    4242 on the dev path: boots and plays at 144 fps, **minimap byte-identical to the parent
    commit** (0 of 18 088 pixels) across a stash/restore A/B, and no `[sync]` line — there is no
    link to produce one. `slot` vs `peer` is kept distinct at the seam (`localPlayer` is the
    slot, `me` is the relay peer), because conflating them is how a client filters out the very
    snapshots addressed to it.

    **NOT verified: two clients actually exchanging snapshots in the browser.** That needs the
    full create/join/start UI driven across two contexts with a relay up, and there is no
    committed headless LAN boot — `?dev` bypasses the lobby entirely, which is exactly why it
    builds no link. The end-to-end path (host emits → relay → client receives → diff) is covered
    by the 47 loopback checks through the real `RelayCore`; what this commit adds on top is the
    app wiring, and only the no-regression half of that is shown in a browser. A scripted
    two-client LAN harness is its own item (**10b-harness**), and it is what turns the loopback
    proof into a live one.

    `pnpm build` is clean: zero `wc3/manifest` / `devBoot` / `OPENWAR3_INSTALL` in `dist/`,
    `menuDebug` still its own chunk — checked because this touched `main.ts`, the boot entry.

10b-old. **The original entry.** `RtsController` has no transport and cannot get one:
    `LanLobby` is constructed in [`src/ui/fdfLan.ts`](../src/ui/fdfLan.ts), a UI module, and the
    game layer has no reference to it. So before any snapshot can be sent, the match needs a
    narrow channel seam — `{ send(data, to?), onMessage }`, which `LanLobby` already satisfies
    structurally — passed into the controller. Then: the host builds `snapshotFor` per recipient
    on a cadence and sends; every client keeps the latest and runs `divergence` against its own.
    This is the wiring item, and it is where `CommandRouter` (item 9) and `GhostMemory.ghostsFor`
    (item 6c) finally get their callers.

10b-harness. ~~**A scripted two-client LAN boot.**~~ **Done.** `?dev&lan=host` and
    `?dev&lan=join` in [`src/dev/devBoot.ts`](../src/dev/devBoot.ts) drive one side each of a real
    LAN match over a real relay: the host creates a room, waits for the joiner, pins the match on
    the URL seed and starts; the joiner finds the room, joins, waits for the start. `?dev` alone
    could never do this — it bypasses the lobby, which is exactly why it builds no link — so this
    is a separate branch through the genuine `LanLobby` + `WebSocketTransport` + `MatchLink`
    stack. Needs `node server/relay.mjs` up.

    **The link assembly is now shared, so the harness proves the production wiring rather than a
    lookalike.** `matchLinkFrom(channel, isHost, slots, myPeer)` in
    [`matchLink.ts`](../src/game/matchLink.ts) is the single peer→slot resolution both `fdfLan`
    and the dev-LAN boot call; `buildStart` (seed now injectable) and `toConfig` are exported
    from `fdfLan` for the same reason. Getting that resolution wrong is how a client filters out
    the snapshots addressed to it, and a harness with its own copy would have tested the copy.

    **A dev-only heartbeat makes the pipe watchable.** `MatchLink.sent`/`received`/`stale` and a
    once-a-second `[sync] host: sent N, received M, …` line in `driveMatchLink`, gated on
    `import.meta.env.DEV` and stripped from the build. Without it a silent `[sync]` is
    indistinguishable from a dead pipe — the counters are what tell "they agree" apart from
    "nothing arrived".

    **The check for that was wrong, and item 12 found it.** "The string `[sync]` is absent from
    `dist/`" cannot be true and must not be asserted: `driveMatchLink` logs `[sync] N
    divergence(s)` too, and THAT one is not dev-only — a desync in a shipped build is exactly
    when you want a line in the console. The two share a prefix, so grepping the prefix reads as
    a violation of an invariant that is actually holding. **Grep the heartbeat's own words
    instead** (`", received "` or `"stale "`), which are absent from `dist/` — verified at the
    phase close.

    **Verified end to end in two browsers, PARTLY.** Both contexts reached in-game through the
    real relay via the LAN path, and the joiner console showed the full handshake — "LAN join:
    connecting" → "in the room, waiting for start" → "start received". That is the harness
    working: two contexts, one relay, the real `StartMatch` exchange, both entering the match.
    **NOT captured live: the heartbeat's sent/received counts from a running match** — the
    agent-browser daemon wedged under two simultaneous WebGL contexts before a clean reading, and
    chasing it further was the time-sink CLAUDE.md warns against. The counter logic is instead
    pinned headlessly: `loopback-test` (**51 checks**) asserts the host counts what it emits, the
    client counts what it accepts, and a stale arrival bumps `stale` not `received`. A single-GPU
    two-client capture of the live heartbeat is worth doing when the daemon is cooperative;
    recorded as **10b-harness-shot**. ~~Recorded as 10b-harness-shot.~~ **Captured in 10c-2c-1**:
    the joining client logged `[sync] client: sent 0, received 332, stale 0, drift 0` from a live
    two-context match. The daemon was cooperative that run; nothing about it was fixed.

10c. **The client renders from the snapshot.** The last step of option B's first half, and the
    largest: `rts.ts` reads `sim.units` throughout, and rendering an arriving snapshot instead
    means the renderer's world becomes the payload. Too broad for one diff, so it is being taken
    one render consumer at a time; each slice is behaviour-preserving for the host and
    single-player (no `matchLink` → the sim path) and switches only a client that has received a
    snapshot.

10c-1. ~~**The minimap dots.**~~ **Done — and the decomposition split on FOG-OWNERSHIP, not on
    size.** The minimap has three outputs and only ONE is a fit for the snapshot. Dots are
    per-recipient (fog-gated), so they are exactly what the AoI snapshot already answers.
    Icons and camps are the opposite — the real 1.27a client paints every gold-mine glyph and
    every creep-camp marker over unexplored black from tick 0, so they are map-GLOBAL scouting
    aids, and the AoI snapshot deliberately withholds the units they need. A client cannot draw
    them from its snapshot because it was never sent the unseen mines and creeps; they stay on
    the local sim, which under sequencing B holds the whole map. So "render the minimap from the
    snapshot" is really just the dots, and that is the whole of this slice.

    `dotsFromSnapshot(units)` in [`minimapView.ts`](../src/game/minimapView.ts) draws a received
    snapshot's units **with no fog test at all** — the point of rendering from the payload. The
    snapshot arrived AoI-filtered (item 6): it holds exactly the units this seat may see. Asking
    `hiddenFor` again would consult a fog grid the authority already consulted, and **a client
    that decides its own fog is a client that can switch it off** — the maphack the per-recipient
    design exists to prevent. The only local calls left are the two that are facts about the unit
    rather than about who may see it: neutral-passive furniture and off-field units get no dot,
    through the SAME `isOffField` (now a structural type, so a `UnitSnapshot` and a `SimUnit`
    cannot drift on what counts as off the field).

    `RtsController.dots()` switches on `this.matchLink?.latest()`: non-null only on a client that
    has received a snapshot (the host never receives, single-player has no link), so both keep
    the `minimapDots(sim, vp)` path and nothing changes for them.

    **The test is an EQUIVALENCE, which is the strongest shape available here.**
    `dotsFromSnapshot(snapshotFor(world, vp, player, t).units)` deep-equals
    `minimapDots(world, vp)` — the client draws byte-for-byte what the host's sim+fog draws, for
    the same viewer, revealed and fogged. That single equality is the correctness of the whole
    slice, and it cross-checks that `snapshotFor`'s AoI filtering matches the live minimap's fog
    filtering — two rules written months apart, now pinned to agree. Both injections (dropping
    the neutral-passive skip, dropping the off-field skip) put a phantom dot in the snapshot list
    and turn the equality red. `sim:test` 407 → **412**.

    **Verified single-player in the browser: minimap byte-identical to the parent** (the
    no-regression half, which is all a single client can show — the switch is a client-only
    branch). The client-draws-the-authority half needs two contexts and is the same
    daemon-fragile capture deferred as 10b-harness-shot.

10c-2a. ~~**The one field the entry sync read that a snapshot cannot carry.**~~ **Done, and it
    was `prevX`/`prevY`.** The rule was "classify by what the consumer actually reads" — so before
    routing the entry sync to a snapshot, audit what it reads. Of the ~19 `SimUnit` fields the
    sync touches, **eighteen are in `UnitSnapshot` already** (item 5 chose them off exactly these
    sites). The nineteenth is `prevX`/`prevY`, and it is not authoritative state at all: the
    sync reads it once, to compute *how far the drawn unit moved this frame*, which gates the
    walk-vs-stand clip. That is a RENDER fact — the previous DRAWN position — that coincides with
    the sim's `prevX` only because the sim and the render tick 1:1 (Phase A). A client drawing 10
    Hz snapshots at 60 fps has no such coincidence.

    So the render now tracks its own `prevDrawnX`/`prevDrawnY` per `Entry`, captured before any
    `continue` and advanced to the position about to be drawn. **Byte-identical by
    construction:** the sim sets `prevX = x` at spawn and at the start of every tick's movement,
    so last frame's drawn position IS this frame's `u.prevX` — the two are equal every frame a
    unit walks. The one edge is a TELEPORT (`setPosition` sets `prevX = newX`): the render sees
    the jump where the sim sees zero, but that frame is gated to invisibility by the same call's
    `moving = false`, and the `moveEma` residue self-corrects in a few frames. Echo Isles melee
    teleports nothing, so the boot is exact.

    **After this, the entry sync reads ONLY snapshot-carried fields** — which is the whole point,
    and the precondition for 10c-2b feeding it a snapshot. `grep u.prevX src/game/rts.ts` is now
    0.

    **Verified single-player, byte-identical minimap** (0 of 18 088 pixels) — this is
    renderer-only (the entry sync has no headless reach), so a byte-identical frame is the whole
    of what can be shown, and it is what "behaviour-preserving groundwork" means. No new headless
    test: the change is a field-source swap inside a loop `sim:test` cannot enter. `sim:test`
    stays 412.

10c-2b. ~~**`RenderUnit`: the shape the renderer reads, which both structs satisfy.**~~ **Done —
    and it found the entry sync's real remaining blocker, which is not a field.**
    [`src/game/renderUnit.ts`](../src/game/renderUnit.ts) is the readonly surface a render
    consumer is typed against instead of `SimUnit`, and
    [`tools/render-unit-conformance.ts`](../tools/render-unit-conformance.ts) pins that BOTH
    `SimUnit` and `UnitSnapshot` satisfy it (the same compile-time-guard trick as
    `snapshot-viewer-conformance.ts`, and it fails on either struct drifting — confirmed by
    renaming a member and watching all three sites go red). The animation resolver moved over
    whole: `pickSequence`, `walkAnim` and `attackAnimRate` in
    [`unitAnims.ts`](../src/render/unitAnims.ts) now take a `RenderUnit`, as does
    `applyFormAnims`. That file was only ever typed against `SimUnit` because the first caller
    happened to hold one — it imports nothing else, and it already answered questions about a
    unit rather than about the world.

    **The one shape mismatch was `repair`, and the DERIVED struct is the one that moved.** The
    sim has `repair: RepairState | null`; item 5 flattened it to `repairing: boolean` because
    that is all a reader reads. Flattening is the better payload and the worse shared type — it
    would have forced an adapter allocation per unit per frame on the HOST path, which is the
    one that has to stay free. So `UnitSnapshot` now carries `repair: { active } | null` and the
    two agree. Nothing read `repairing`, so this cost no reader.

    **The blocker for feeding the sync a snapshot is the FOG half, not a missing field.** The
    sync's loop body is `applyVisibility` + the animation picker, and only the picker is a
    question about the unit. `applyVisibility` → `hiddenFor` → `Viewpoint.fogHides`, and
    `applyFogTint` → `showsFromMemory`, are the local client consulting its own fog grid — which
    is exactly what a client rendering from a snapshot **must not do** (the payload arrived
    AoI-filtered; asking again is the maphack `dotsFromSnapshot` refuses to ship). So 10c-2c is
    not "widen two more signatures", it is "on a client, the visibility branch does not run at
    all". Widening the viewpoint predicates to `RenderUnit` would be work in the wrong direction.

    **The test is an EQUIVALENCE, the same shape as 10c-1's.** Ten unit states — idle, walking,
    each carry, constructing, repairing, a building mid-production, chopping, holding lumber
    without chopping, hasted mid-swing — each asserted to pick the same clip and the same rate
    from the `UnitSnapshot` as from the `SimUnit` it was built from, plus a check that the states
    really do reach distinct branches (a picker returning one constant would otherwise pass every
    line). `unitAnims.ts` joins the sim build to make that runnable headlessly — it imports only
    a type, so it compiles to CommonJS untouched. Two injections, each a real bug: a payload that
    stops carrying `repair`, and one that stops carrying `carryGold`. Both go red on exactly
    their own state and nowhere else. `sim:test` 432 → **463**.

    **Browser: booted Echo Isles single-player and drove a peon through a full harvest trip** —
    the walk, carry-gold and mine-entry branches all resolved through the retyped picker, units
    posed and animated normally. That is a no-regression check on the hot path (the picker runs
    per unit per frame), not a demonstration of anything new: nothing about what is drawn changed.

10c-2c-1. ~~**Whether a MODEL is drawn comes from the payload, not from the client's own fog
    grid.**~~ **Done**, and it is the half of 10c-2c that stands alone — because the answer is
    provably the SAME answer, so nothing on screen changes while the decision changes hands.
    Exactly the shape of 10c-1 (the minimap dots), applied to the units themselves.

    **`hiddenFromSnapshot(u)` is `!u || isOffField(u)`, and the short body is the finding.** The
    host's `hiddenFor` has three terms — off-field, fog, undetected invisibility. Two of those
    collapse into **absence**: `visibilityFor` answered `"omit"`, so the record never left the
    host, and the client's "I cannot see it" is a fact it was handed rather than a grid it
    re-derives. The one that does NOT collapse is off-field, because the snapshot deliberately
    still sends a mining worker to its own owner (a Burrow has to be able to list its garrison),
    so absence cannot carry that message and the test survives on the client side.

    **`SnapshotIndex`** ([`renderView.ts`](../src/game/renderView.ts)) is the id index a render
    loop needs over a payload that is a flat array, re-indexed only when the snapshot OBJECT
    changes — 10 Hz, not the 60 Hz the sync runs at. `active` is the switch, and it is false in
    the three cases that must keep the sim path: single-player, the host (it never receives) and
    a client that has connected but not yet been sent a frame. `applyVisibility` now TAKES the
    decision (`modelHidden`) instead of computing it, so it cannot know which of the two answers
    it got — which is the point.

    **The test is an EQUALITY and it is the correctness of the whole file**:
    `SnapshotIndex.hidden(id)` equals `hiddenFor(vp, simUnit)` for every unit in a world — own,
    own-but-in-a-mine, an enemy in the black, an enemy under our eyes, an undetected invisible
    one, neutral furniture — plus a second block for the case `fogHides` deliberately answers
    "draw" to: a building you SAW and walked away from is still drawn on both sides, on the
    client off a `remembered` record with its hp redacted to 0. The mix is pinned as well as the
    equality, or a `hidden()` that returned true for everything would pass. Two injections, each
    a bug somebody would really write: dropping the off-field term (the mining worker appears on
    screen), and treating `remembered` as hidden (every scouted enemy building blinks out the
    moment the scout leaves). Each turns its own checks red. `sim:test` 463 → **470**.

    **Verified with TWO clients through the real relay** — and this is also the capture
    **10b-harness-shot** was waiting for. The joining client reported `[sync] client: sent 0,
    received 332, stale 0, drift 0` while drawing all 103 units with correct fog: `active` was
    true, so every hide/show decision in that frame came off the wire, and the frame is right.
    Host and client each render their own seat (Human and Orc bases, each with its own fog).
    Single-player minimap is byte-identical to the parent commit's (0 of 18 088 pixels), which
    is the no-regression half.

    **Noted, not fixed:** `dots()` and the entry sync now both ask `matchLink?.latest()`
    independently. One of them should read through `SnapshotIndex` once the next slice gives it
    a units accessor — two readers of the same fact is how they drift.

10c-2c-2. ~~**The FRAME is drawn from the payload on a client.**~~ **Done**, and the cut that
    made it one diff rather than five was **position-anchored draws vs panel readouts**, not
    "one consumer at a time". Everything drawn OVER THE TERRAIN at a unit's position shares a
    frame and had to switch together — the model's pose, the health bar above it, the selection
    /preview/hover rings under it, the hover slab beside it. A bar at the sim's position over a
    model at the snapshot's is the Frankenstein the item was warning about, and it is exactly
    what shipping these separately would have produced. The command card and the selection panel
    are drawn at a FIXED place in the HUD, so a frame's disagreement there is invisible; they are
    10c-2c-3 and they lose nothing by waiting.

    **One accessor, `frameUnit(id)`, and that is what makes the switch atomic.** Sim on the host
    and in single-player, the received record on a client. Six consumers go through it and
    nothing else does, so they cannot end up reading different worlds — there is one place to
    read from. `sim.units.get` in `rts.ts` **73 → 60**.

    **`undefined` now has two causes that want one answer.** The sync used to non-null assert
    (`this.sim.units.get(e.simId)!`). Now a missing record means either the sim dropped the unit
    between ticks or **this client was never sent it**, and both mean "hide the model and touch
    nothing else". Worth stating why that is safe for the deselect side-effects `applyVisibility`
    carries: an absent record is always somebody else's unit, because the payload sends a
    player's own off-field units to them (a Burrow must list its garrison) — so a mining
    peasant's owner never loses the mine-entry deselect.

    **The conformance file earned its keep the moment `remembered` was added.** Widening
    `RenderUnit` with it as a required member broke `SimUnit` on the spot, which is the drift
    the file exists to catch — and the break was correct rather than an obstacle. "Remembered" is
    a fact about a PAYLOAD addressed to somebody, not about the world; the host holding the world
    is never remembering it. So it is the ONE optional member: the sim path leaves it `undefined`
    (falsy, and correct there) and only a `UnitSnapshot` sets it.

    **Two fog rules left the client, and both became data.** `drawnFromMemory` replaces
    `fogBlocksClick` for the health bar and the hover slab, and `applyFogTint`'s
    `showsFromMemory` for the grey wash — on a client both are `u.remembered`. And the illusion
    wash no longer asks `seesFor` on the snapshot path: item 5 already resolved the bit per
    recipient, so an enemy's payload simply says `false` and a client re-deciding it would be a
    client deciding which units are illusions.

    **Tests: `sim:test` 472 → 478.** Two more equalities in the same shape as 10c-2c-1's: for
    every unit the client actually DRAWS, the payload's `remembered` equals the host's
    `fogBlocksClick` (scoped to drawn ones deliberately — an off-field unit is sent with
    `remembered: false` while `fogBlocksClick` may say anything, and the frame never reaches the
    question because the model is hidden); and the illusion bit is already viewpoint-resolved on
    the wire, with the enemy still DRAWING the image rather than missing it. Two injections: a
    payload that never sets `remembered` (the client stops dimming and starts drawing empty bars
    over every scouted building), and an unmasked illusion tell (which also lights up two checks
    in `sim-snapshot-test` — the illusion mask has coverage from both ends now).

    **Verified with two clients through the real relay: the client's ENTIRE frame is now drawn
    from the wire** — models, health bars, minimap dots — 103 units, `stale 0, drift 0`. And the
    single-player minimap is byte-identical to the parent commit's (0 of 18 088 pixels), which is
    the no-regression half for the sim path this touches everywhere. The agent-browser daemon
    wedged once and needed a PID kill; known fragility, not a finding.

10c-2c-3. ~~**The selection panel reads the authority's numbers.**~~ **Done.** `infoFor` — the
    HUD's whole readout, ~24 fields — goes through `frameUnit` now, so on a client "how much
    health does my hero actually have" is answered by the host rather than by the client's own
    prediction of it. The panel steps at the snapshot's 10 Hz rather than the frame's 60, and
    that is not a compromise: it is the rate at which the authority knows.

    **The illusion gate came off, in two more places.** `isSummon` and `isIllusion` on the panel
    were both `&& this.seesFor(u.owner)`. Item 5 already masks the illusion bit AND the whole
    summon triple per recipient, so on the snapshot path an enemy's payload reports an ordinary
    hero with no expiry and the reader needs no viewpoint. Same correction as `applyFogTint`'s
    in the previous slice — that makes three reader-side filters retired in favour of the mask
    at the source, which is what `docs/illusions.md` asks for.

    **`RenderUnit` needed two new SHAPES, not just fields, and both are flattenings.**
    `RenderWeapon` grew `damage`/`dice`/`sides` for the damage line (the animation half never
    reads them). And `RenderBuildJob` flattens `BuildJob`'s three-way union to one shape with
    `level` optional — narrowing a discriminated union across the sim/wire boundary would make
    the panel care which side it was reading from, which is precisely what this type exists to
    prevent. `RenderBuff` is narrower still: the status row is a list of icons, so it takes
    `kind` and the non-stacking `group` and leaves the magnitudes, timers and attached-model
    list behind.

    **The tidy owed by 10c-2c-2 is paid.** `dots()` asked `matchLink?.latest()` on its own; it
    now reads the same `SnapshotIndex` the frame does (`units` accessor). `matchLink?.latest()`
    appears **once** in `rts.ts` — two independent readers of "have I been sent a world?" is how
    the minimap and the models end up drawing different ticks.

    **Tests: `sim:test` 478 → 484**, and the shape is a FIELD LIST rather than an equality.
    Twenty-four panel scalars compared name by name against the sim record the snapshot was
    built from, plus the damage line's three weapon numbers, the buff row, the carry readout,
    and a three-slot production queue checked in order and whole. That list is the point: adding
    a field to the panel means adding it here, and a producer that silently stops carrying one
    prints a zero on a client while every other check stays green. Two injections — `bonusStr`
    stops crossing (named exactly, `["bonusStr"]`), and the queue arrives empty (three checks
    red across two files, because the Birth-clip scrub reads the same pair).

    **Verified with two clients: the panel on the CLIENT is drawn from the payload** — Peon,
    250/250, Damage 7-8, Armor 0, command card populated — which are the real 1.27a numbers, off
    the wire. Single-player minimap byte-identical to the parent (0 of 18 088).

10c-2c-4. ~~**Classify the rest.**~~ **Done, and the classification came out on a different axis
    than this entry predicted.** It guessed "input vs output". The line that actually matters is
    **does this question involve WHERE the unit appears on screen?** — and by that test some of
    the most input-shaped code in the file belongs with the frame.

    Four sites moved, for one reason each expressed the same way: they project `u.x/u.y` through
    the camera and compare the result against something the player is looking at.
    - **`pickAt`** — every click, hover, order and spell target. It measures the cursor against
      the unit's projected mid-body, so reading the sim while the model came from the snapshot
      would put the clickable disc somewhere the player cannot see it. **A cursor that lies is
      worse than a model one frame stale.** Its `fogBlocksClick` became `drawnFromMemory` with
      it — same question, already answered in the payload.
    - **`unitsInBox`** — the drag box would catch units just outside it and miss ones inside.
    - **`onScreen`** (via `selectByType`) — "is it on screen" is a fact about the drawn frame.
    - **`repinConstructionFrames`** — **and this one was a real bug, introduced by 10c-2c-2 and
      missed by it.** It re-pins a building's Birth frame to construction progress each frame,
      AFTER the renderer's update — the same scrub the entry sync does. The sync had switched to
      the snapshot and this had not, so on a client the birth frame was being set twice per
      frame from two different progresses. A building visibly stuttering between two states of
      construction, on the client only. Exactly the Frankenstein the item warned about, in the
      one place it was easy to miss: a separate method, called from outside the sync loop.

    **What deliberately did NOT move, and this is the finding worth keeping.** Ownership tests,
    `controls(id)`, inventory slots, worker filters, `selectHero`, rally targets, order issuing —
    they ask about IDENTITY and PERMISSION, not about pixels. An order is aimed with the local
    sim's ids and judged by the host anyway, so routing them through the payload would add a
    failure mode (a command that cannot be issued because the snapshot has not arrived) to buy
    nothing. `sim.units.get` in `rts.ts` **59 → 55**, and the remaining 55 are that set. **The
    count is not the target** — a zero here would mean the client had stopped being able to
    reason about its own world.

    **No headless coverage, and that is honest rather than an omission**: all four sites live in
    `rts.ts`, which imports `mdx-m3-viewer` and cannot load in the sim build, and three of the
    four are questions about a camera projection. Verified in the browser instead, with two
    clients: on the CLIENT, clicking a unit and then a building both resolved through the
    payload-sourced picker — Peon 250/250, then Great Hall 1500/1500 Armor 5 with its own
    command card. Those are the real 1.27a numbers, picked and printed off the wire.
    Single-player minimap byte-identical to the parent (0 of 18 088). **The construction-stutter
    fix was NOT captured** — staging a build on a client through the harness was more than the
    fix was worth; it is a code-reading fix and is stated as one.

10c-2c-5. ~~**`6d` — a razed building's ghost, and the `onDeath` rework it rides in.**~~ **Done**,
    and it turned out to be one sentence: **a death you did not witness is not a death you may
    animate.** `GhostMemory` mints an image only for a viewer who was NOT watching (6b), so a
    `remembered` record still in our payload IS the authority saying "you have no way to know
    this happened". `onDeath` asks it for permission; if the image is there it sets `ghosted`
    and returns, and the model stands frozen (already dimmed by `drawnFromMemory`) instead of
    collapsing.

    **The local sim's death is still the TRIGGER, and that is deliberate rather than a
    leftover.** Sequencing B means the client simulates the same match, so it learns of the
    death at exactly the right moment. What it must not do is ACT on it. The payload is
    consulted only for permission — which is the same shape as every other switch in 10c: the
    client keeps its own knowledge and stops using it to answer questions that are the
    authority's.

    **Absence is what retires the model, and that fell out of 10c-2c-2 for free.** When the
    player re-scouts the spot the host drops the image (`forgetSeen`), the id stops arriving,
    and the entry sync's existing `undefined` branch sees it. WC3 shows rubble rather than a
    replayed collapse, so the ghost entry is dropped without a death clip. `onRemove` and this
    now share `dropEntry`.

    **One bug avoided by construction, worth recording because it is easy to write:**
    `dropEntry` splices `this.entries`, and splicing an array a `for…of` is walking silently
    skips the next element. The forgotten entries are collected during the sync and retired
    after it (`forgotten`).

    **Tests: `sim:test` 484 → 489**, pinning the three signals the renderer now reads, in the
    order it reads them — razed out of sight is still SENT and flagged as a memory (so the
    model keeps standing), re-scouting drops it from the payload entirely (so absence retires
    it), and the contrast case that must still collapse: razed in front of you mints no image,
    so the client's own death event plays out. Two injections, both in `ghosts.ts`: minting a
    ghost for a watcher (the collapse you saw stops playing), and inverting the forget rule
    (the image is forgotten while you are blind and kept while you look).

    **The VISIBLE half was NOT captured, exactly as item 6d predicted, and the reason is
    unchanged**: it needs an enemy to raze a building you scouted and walked away from, and the
    LAN harness has no way to destroy a building — there is no kill in the dev panel and no
    console reaching `KillUnit`. What was checked in the browser is that nothing regressed: two
    clients play through the relay (`stale 0, drift 0`) and the single-player minimap is
    byte-identical to the parent (0 of 18 088). On the sim path `snapshot.active` is false, so
    `onDeath` is untouched there by construction.

    **10c is now closed.** A client draws its models, their poses, their bars, their rings, its
    minimap dots, its selection panel, its picking and its deaths from the payload.

11a. ~~**Reconnect, the relay side: a rejoin token holds the slot.**~~ **Done.** A dropped
    connection is no longer a departure. `RelayCore.disconnect` (the socket-closed path, distinct
    from the `leave` MESSAGE) now HOLDS a non-host peer's slot: the peer stays in the room table
    marked `disconnected`, its rejoin `token` still opens it, and a `join` carrying that token
    reclaims the SAME peer id. Protocol → **3**: `join` gains an optional `token`,
    `created`/`joined` carry the peer's own secret token, and `peer-drop`/`peer-rejoin` join
    `peer-leave` so a roster can tell "reconnecting" from "gone".

    **The drop/leave split already existed at the adapter and just needed honouring.**
    `relay.mjs` routes a socket close to `disconnect` and a `leave` message to `handle` — two
    doors that both used to call `leaveRoom`. Now `disconnect` holds and `leaveRoom` frees, which
    is the whole distinction the pinned test demanded ("a drop is not a leave").

    **Stayed free-tier-shaped, as the item required:** the held slot is one boolean and a token
    on the existing room-table peer — no sim, no match state, no Blizzard byte. The host is still
    the exception (v1 has no host migration): a host drop closes the room, as does a drop that
    leaves nobody connected, so held slots cannot leak a room nobody is in.

    **Tests: the pinned "comes back as a stranger" checks flipped to "comes back as itself"** —
    the discipline item 3c set, inverted. `loopback` 56 → **65**, over the real `RelayCore`
    (`relay:test` runs the same core over real sockets, still green). The two injections — a drop
    that frees instead of holding, and a rejoin that ignores the token — each turn their own named
    checks red. A held slot is kept even against a full room (a tokenless intruder is refused, the
    token holder gets back in); a wrong token is just a stranger; a chosen `leave` still frees.

    **No browser check, and it is checkable why:** no `src/game` render code changed, the client
    lobby does not consult the token YET (that is 11a-client), and reconnect needs a drop/rejoin
    sequence a single client cannot show. The relay logic is covered over both the in-process and
    real-socket paths.

11a-client. ~~**The client stashes its token and auto-rejoins on a drop.**~~ **Done — and the
    developer confirmed the design: the token IS a per-session hash, kept in localStorage so it
    survives a tab reload or crash, not just a socket blip.** `LanLobby` now saves
    `{roomId, token, playerName}` on `created`/`joined`, clears it on a chosen `leave`/`dispose`
    or a `room-closed`, and on a dropped connection reconnects and reclaims the slot with it.
    `reconnectPlan` ([`reconnect.ts`](../src/net/reconnect.ts)) is the one decision — rejoin only
    while the room is still LISTED (the host is up); a vanished room means the match ended, so
    the stale session is forgotten rather than retried forever.

    **The move that made it testable was inverting the transport dependency.** `LanLobby`
    imported `WebSocketTransport`, whose `import.meta`/`window` cannot compile to the CommonJS the
    headless suite runs as — so the whole lobby was out of a test's reach. Now the lobby takes a
    transport FACTORY and imports only `type Transport` (moved to
    [`transportTypes.ts`](../src/net/transportTypes.ts) so even the type carries no `import.meta`
    in its file). A fake transport drives the entire reconnect flow headlessly — the same
    dependency-inversion that made `RelayCore` testable, applied to the client half.
    `fdfLan`/`devBoot` pass `() => new WebSocketTransport()`; nothing else changed for them.

    **A real UX bug fell out of the test.** On reconnect, `connect()` used to reset the state to
    "browsing" and clear the error — which would blink the roster away for the beat between the
    socket reopening and the rejoin landing. The check for "the UI shows Reconnecting…" went red
    and forced the fix (a reconnect keeps its state until `joined`).

    **`peer-drop`/`peer-rejoin` are now handled** (protocol 3, from item 11a): a dropped peer
    stays in the roster ("reconnecting"), a rejoin heals it, and only a `peer-leave` removes it.

    **Tested headlessly, 20 checks** ([`tools/lobby-test.cjs`](../tools/lobby-test.cjs), the FIRST
    test the lobby has ever had): token stashed on join and cleared on leave; a drop reconnects
    and rejoins with the token; a drop into an ended game gives up and forgets the token; a drop
    while merely browsing is a plain disconnect; the roster handling. `sim:test` 412 → **432**.
    Two injections — a drop that never reconnects, a `reconnectPlan` that ignores whether the room
    still exists — each turn their own named checks red.

    **Still NOT wired: nothing forces a real drop for the host's catch-up (11b) to answer.** This
    is the client half; the reconnected player rejoins the ROOM, but sees correct GAME state only
    once the host sends it a full snapshot (11b) and the client renders from it (10c). Verified in
    the browser that the refactored lobby still boots a two-client LAN match; the drop/rejoin
    round trip itself is the deferred two-client capture.

11b. ~~**Reconnect, the authority side: answer a rejoin with a FULL snapshot.**~~ **Done**, and
    the entry's own prediction ("this is a small one") held — but only because 11a had already
    made the returning peer reclaim its **same id**, so the seating handed over at `StartMatch`
    still resolves and there is no re-seating to do.

    **The cadence gate belongs to the BROADCAST, not to the catch-up.** That sentence is the
    whole change. `tickHost` used to return early below `SNAPSHOT_INTERVAL`, so a reconnected
    player waited out a tick they had no stake in — up to 100 ms holding a world that stopped
    when their connection did. Now `due` gates the everyone-loop and an `owed` set cuts across
    it: a catch-up neither resets the cadence clock nor postpones the next broadcast, and it is
    **addressed** to the returning peer rather than fanned out (a broadcast wearing another name
    would be a burst to the whole room every time one player's wifi hiccups).

    **`MatchChannel` grew a third member, and it is required rather than optional.**
    `onPeerRejoin(peer)` is the one piece of ROSTER news the match needs; a channel that quietly
    lacked it would leave a reconnected player staring at a frozen world with nothing to say so.
    `MatchLink` subscribes in its constructor, exactly as it already does for `onPeerData`, so
    the catch-up cannot be forgotten by whoever assembles the link. `LanLobby` fires it from its
    `peer-rejoin` case, AFTER the roster heals.

    **"A FULL snapshot" costs nothing today and the word is a promise for later.**
    `snapshotFor` builds the whole recipient-visible world every time — there are no deltas — so
    the catch-up is the same call the broadcast makes. When a delta encoding arrives (Open
    questions: "JSON first, binary when it hurts") this is the one send site that must stay
    whole, because a delta against a world the recipient never received is noise. The check
    exists now so that day is a failing test rather than a silent regression.

    **Tests: `loopback` 65 → 71, `sim:test` 470 → 472**, and the loopback block runs over the
    REAL `RelayCore` — a held slot, a token, the same peer id back — because `channelFor` now
    routes `peer-rejoin` instead of the test faking the call. Three injections: the old
    early-return gate (four checks red — the catch-up never leaves), never clearing `owed` (the
    host re-sends to that peer every tick for the rest of the match), and a lobby that heals its
    roster without telling the match (two checks red in `lobby-test`). The "no game state is
    replayed by the relay itself" check from 11a still stands and still passes — the relay must
    never replay; the HOST sends.

    **Verified in the browser, and this is the first item where the whole round trip was
    driven.** Two clients through the real relay, then the joining client forced offline
    (`agent-browser set offline on`) and back. The heartbeat tells the story: `received` climbing
    (34…142), then **frozen at 142 for three heartbeats** while the wire was dead, then resuming
    and climbing to 428 — **`stale 0, drift 0` throughout, including after the reconnect**. Drift
    0 on the far side is the part that matters: the client's own sim kept running while
    disconnected, and once caught up the authority's view and its own agree. The daemon wedged
    once mid-run and needed a PID kill; that is the known fragility, not a finding.

12. ~~**Flip the phase table.**~~ **Done — Phase E is closed**, and the flip was an AUDIT
    rather than a doc edit. The three clauses of the stop condition were re-checked against HEAD
    rather than against the entries claiming them:

    - **The authority takes commands and emits AoI-filtered snapshots over a transport it does
      not name.** `MatchChannel` is three methods; `MatchLink` names no socket, and `snapshot.ts`
      imports no transport and no renderer. Commands arrive stamped by the relay and are judged
      by `CommandRouter` against the seating, so a client cannot act as somebody else.
    - **Two clients play a match through the relay.** Re-run at the close: host and client both
      in-game on Echo Isles, the client logging `received 42 → 51 … stale 0, drift 0` while
      drawing its whole frame from the payload.
    - **A dropped client rejoins to correct full state.** Same run, client forced offline: the
      counter **froze at 56** for the duration, then resumed and climbed to **342 — `stale 0,
      drift 0` throughout, including after the reconnect.** Drift 0 on the far side is the
      clause that matters: the client's own sim kept running while it was disconnected, and once
      caught up the authority's view and its own agree.

    **Two things the audit turned up, and neither is cosmetic.** The phase-table row still
    carried the trailing claims "nothing renders from it yet" and "nothing crosses the wire
    yet" — both false for several commits, and both the kind of stale sentence a reader trusts.
    And the `[sync]`-absent-from-`dist/` invariant does not hold as written (see item 10b);
    the heartbeat IS stripped, the divergence warning is not and should not be.

    **Still outstanding and deliberately not blocking the flip:** `9b-cmd-shot`, a browser
    capture of an order issued on one client reaching the other's host. It is a CAPTURE, not
    work — the path is covered end to end by `loopback-test` over the real `RelayCore` — and the
    phase does not depend on it. The v1 design questions in [Open questions](#open-questions)
    (host input delay, NAT traversal, cold start) are the next phase's, not this one's.

### Phase F — the LAN punch list

Phase E closed the architecture. What is left is **product-shaped**: the things that only go wrong
when a real person does something a script would not. The list grows as the real flow is driven —
each break is its own item, not a bigger commit.

1. ~~**The relay had no liveness detection, so dead rooms haunted the game list.**~~ **Done.**
   `relay.mjs` relied entirely on `ws.on("close")`, which is the *easy* case. A peer that stops
   EXISTING without closing — force-killed tab, closed laptop lid, wifi pulled at the physical
   layer — sends no FIN, so TCP sits on the socket for many minutes and for all of them the relay
   believes the peer is present: **its room stays listed, full, and unjoinable.** Observed live in
   the games list (see `f092b75`).

   **The reaping logic was never the problem and was not touched.** `rooms.mjs` already does the
   right thing with a departure — a dropped non-host holds its slot under its token, a dropped
   host closes the room. The heartbeat's whole job is to make that path *fire*: ping every socket
   on an interval, `terminate()` any that has not answered the previous ping, and let the
   resulting `close` run the existing `disconnect`. `RELAY_HEARTBEAT_MS` (default 15 s, two beats
   to notice) exists so a test can watch a reaping happen in under a second. This also turns
   [item 11a](#remaining-work-in-order-2)'s held slots from permanently-held into reclaimable.

   **It stays in `relay.mjs`, and the file's own split says why.** Liveness is a fact about a
   wire, and `rooms.mjs` is socket-free on purpose — it knows only "this connection went away".
   The browser needs no code at all: answering a ping with a pong is the WebSocket protocol's own
   job (RFC 6455 §5.5.3), handled under the client API, so it reaches even a page whose JS thread
   is wedged — which is the distinction being drawn, since what it cannot reach is a page that is
   gone.

   **Tests: `relay:test` 88 → 92, over REAL sockets** — the bug does not exist in-process. The
   dead peer is simulated by `ws._socket.pause()`: the client stops *reading bytes*, so the ping
   frame is never parsed and never answered, and from Node's side the connection is still
   perfectly open. No FIN, no close, no error — the only way to make the failure appear. Two
   injections: a sweep with an empty body (the original bug — "reaped and delisted" goes red) and
   one that terminates every socket each beat (three red, including "a live client is not
   terminated"), which is why the live-watcher half of the section is there at all.

   **Driven in a real browser, and it corrected an assumption worth writing down.** A Chrome
   socket held a room across **ten beats** and was still open and still served — a real browser
   does pong, unprompted. But **`agent-browser set offline on` is NOT a wire cut**: with it on,
   the page's `readyState` is still `1`, the socket still answers pings, and the room correctly
   stays listed. It suppresses data, not the connection. So the reconnect work in item 11b
   exercised a *quiet* pipe, not a severed one, and the no-FIN case a browser genuinely cannot
   produce on one machine (killing the process closes its sockets at the OS layer) is exactly the
   case `_socket.pause()` covers. A tab reload still reaps instantly, as it always did.

2. ~~**Drive the whole real flow, two windows.**~~ **Driven, and it works as far as the match.**
   Main menu → Local Area Network → Create Game → the map list → Echo Isles → Create → the second
   window sees `Player's Game 1/2` → select → the summary pane fills from ITS OWN install → Join →
   both rosters read `Player (host)` / `Player`, 2/2 → Start → **both windows in the same match**.
   Two breaks fell out, each its own item: the opening camera (3, fixed) and the snapshot pipe
   (4, open).

   One thing that is NOT a product bug, recorded because it cost twenty minutes: the games list
   showed a full, unjoinable `dev-lan 2/2`. It was real, and it was *mine* — leftover
   `agent-browser` daemons from an earlier session, still holding two live pages that reconnected
   to the relay and re-hosted. Their sockets answered pings, so item 1's heartbeat correctly left
   the room alone. **A live room from a browser you forgot you had open is indistinguishable, in
   the lobby, from a dead one.** Kill the stale daemons before reading the games list.

3. ~~**Both players' cameras opened on the LAST seat's base.**~~ **Fixed.** The host started every
   match looking at an empty enemy island while its own town hall stood off-camera; the client got
   the right view by luck, being the last seat. Also reproduced in single player, which is what
   proved it was not a LAN bug at all.

   **The cause is item 7b's own mechanism, used for something it does not fit.** blizzard.j calls
   `SetCameraPositionForPlayer(p, x, y)` once per player at every melee start, and that BJ is a
   `GetLocalPlayer` gate. Since 7b such a gate is re-evaluated once per recipient — correct, and
   the whole point — and the extra passes are muzzled for WORLD writes. A camera move is not a
   world write, so it went through: one pass per seat, each moving the one camera that is actually
   here, last one wins. Probed live rather than reasoned about: `SetCameraPosition -5448,3322
   viewer=0 local=0` then `SetCameraPosition 4936,3322 viewer=1 local=0`, on a single-player boot.

   **`Runtime.localViewHooks` is the fix, and it is the world-write muzzle's twin.** Hooks that
   write THE VIEW IN FRONT OF THE PERSON AT THIS MACHINE — the camera family, the cinematic filter,
   the letterbox, user control, a ping — are refused in an extra pass too, and for a sharper
   reason: that pass is being evaluated *as somebody who is not sitting here*, and there is only
   one screen. Refused **silently**, unlike a world write: a world write inside the gate is a map
   breaking Blizzard's contract and earns the console line, while a camera move inside it is the
   contract being honoured — presentation is exactly what that gate is for — and the only thing
   wrong with it is the address on the envelope.

   **Named by the renderer, computed not transcribed**, exactly as `worldWritingHookNames` is:
   `MapViewerScene.localViewHooks()` is now its own factory spread into `textHooks`, and
   `Object.keys` of it IS the refusal list, so it cannot drift from the table it describes. Only
   WRITERS moved. The camera READERS (`cameraField`, `cameraTarget`, `cameraEye`, `cameraBounds`)
   stayed behind deliberately: a muzzled reader would take a different BRANCH in a per-recipient
   pass rather than skip a picture, and where this machine's camera is pointing is the same fact
   whoever is being evaluated.

   **Tests: `jass:test` audience 20 → 23.** A gate naming another seat now moves nothing here; the
   host's own pass still moves the camera (seat the host AS the named player — without this half
   the fix could be "never move the camera" and pass); and an UNGATED move still lands, so
   "classified" cannot quietly come to mean "disabled". The injection — the muzzle passing the
   hook through instead of stubbing it — turns the first of those red and leaves the other two
   green, which is the bug exactly.

   **Verified in the browser, both paths, with the before shot in hand.** Single player on Echo
   Isles as slot 0: before, an empty island; after, the town hall and five peasants. Then the real
   two-window LAN flow end to end: the host on its own base, the client on its own base, in the
   same match. The renderer's half of this (that it declares the set at all) is browser-verified
   only — `mapViewer` cannot be loaded headlessly — and that is stated rather than papered over.

4. ~~**A client in a real lobby match received NO snapshots.**~~ **Fixed.** Host `sent 685`, client
   `received 0` across 94 heartbeats, both windows otherwise fine and both simulating happily.

   **The menu was closing the game's socket.** `startGame` ([`main.ts`](../src/main.ts)) disposes
   the glue on its way in, the LAN screen's own `dispose` closed the `LanLobby` it made — and
   `LanLobby` **is** the match's `MatchChannel`. So the wire was torn down a beat before
   `attachMatchLink` wired the link onto it. The host's counter still climbed, because
   `MatchLink.tickHost` counts what it hands to the channel and `LanLobby.send` drops a message on
   a null transport without a word. **Two silent counters agreeing on a lie**: `sent 685` and
   `received 0` are the same fact seen from both ends.

   Why the harness never caught it: `devBoot`'s LAN boot mounts no glue screen, so `glue.dispose()`
   had nothing to dispose and its lobby survived. The one thing the committed two-client boot does
   NOT share with production is the very thing that broke.

   **It is a question of OWNERSHIP, not of ordering.** No re-ordering would have been safe —
   `attachMatchLink` must come after the world it snapshots exists, which is after the menus are
   gone. So `LanLobby` now has two lives and says which one it is in: `handOff()` moves ownership
   to the match, `dispose()` (the screen's call) becomes a no-op after it, and `close()` is what
   actually ends the wire. `fdfLan` calls `handOff()` at the instant it hands the link over — and
   drops its own `onChange`/`onStart` in the same breath, since a roster change arriving after the
   unmount would render into a dead screen. `MatchChannel` gained an optional `close?()`, which
   `LanLobby` satisfies structurally, so the hand-off still costs an assignment and no new API.
   `main.ts` holds the live link and closes it in `exitToMenu` — the match owned the wire, so
   leaving the match is what ends it.

   **Tests: `sim:test` 489 → 494** ([`lobby-test.cjs`](../tools/lobby-test.cjs)). After a hand-off
   the screen's `dispose` leaves the transport connected AND still sending; `close()` ends it; and
   — the counter-check that stops the fix being "dispose never closes anything" — a screen that
   never handed off still closes its own wire. One injection, the ownership guard inverted, turns
   all three red.

   **Verified in the browser, the full two-window flow.** Host `sent 1731` / client `received 1731`,
   `stale 0` — an exact match, not merely a rising number. Then a real order: the client drag-selected
   its five peons and right-clicked a destination, and they walked there **in the client's own view,
   which is drawn from the payload** — so the command crossed to the host, the host applied it, and
   the result came back down the pipe. Finally End Game: the room vanished from the relay, which is
   the other half of the change (`close()`) doing its job.

5. ~~**After a move order the local sim drifts from the authority.**~~ **Fixed — and the fix is to
   the DETECTOR, because the drift was never a bug.** One ordinary move order took the client's log
   from silent to **13 findings a tick**, and reading them is what settles it:

   ```
   unit 107.order:  local "harvest"                vs authority "return"
   unit 107.worker: local {…,"carryLumber":0}      vs authority {…,"carryLumber":10}
   unit 109.x:      local 4992                     vs authority 5152
   ```

   Those two worlds are not disagreeing about physics. They are **running different matches**. A
   client's local sim is an uncorrected prediction fed only its OWN input: it applies this
   player's commands the instant they are issued, the authority applies them a round trip later,
   and it never hears about anybody else's at all. From the first command onward, every
   difference is explained by the missing inputs, and reporting it is a false positive per moving
   unit per tick — which drowns the one line that would matter.

   **So the comparison now states its own precondition and stops when it is broken.** Every
   snapshot carries `commands` — `Authority.applied`, the number of commands that world has
   taken — and `MatchLink.compare` only diffs while that is 0 **on both sides**. The authority's
   half is not optional and cannot be replaced by a local flag: a client that has issued nothing
   has no other way to learn that the HOST player has, and its own units would keep comparing
   clean while the shared creeps quietly parted. When the streams separate it says so once
   (`[sync] divergence checking stopped…`) rather than falling silent, because a quiet detector
   reads as a detector finding nothing, which is the comfortable reading and the wrong one.

   **The window that remains is the valuable one**, not a consolation prize: match start, before
   any input, is exactly where a seeding, RNG, map-script or unit-placement desync shows itself —
   real bugs, in the only window this could ever have caught them. Nothing detectable was lost:
   after the inputs part, the detector never had the information to tell a desync from a
   different match.

   **Tests: `relay:test` 92 → 100.** A real difference is still found while both worlds are
   pristine (so the gate is the gate, not the diff quietly breaking); our own command ends it;
   and — the check a local-only flag would fail — a commanded AUTHORITY ends it even though this
   client has issued nothing, with the count riding in the snapshot. Two injections, one per half
   of the condition, each turning its own check red. **Verified in the browser**: after the same
   move order that used to log 13 findings a tick, the client prints the notice **once** and
   `drift` stays **0**.

   Still open, and now separable from the noise: **when does the client's local sim come out?**
   Sequencing B called it "a deliberate temporary state — the local sim comes out once the log is
   quiet". The log can now be quiet, but that is because the comparison is scoped, not because
   the sims agree; they cannot, by construction. That decision is the developer's.

6. ~~**A client whose host ended the game was told nothing.**~~ **Fixed.** v1 has no host
   migration, so a host leaving IS the end of the match — and the relay says so exactly once, with
   `room-closed`. Nothing was listening: `LanLobby` turned it into an error string for a LAN screen
   that had been unmounted since the match began, so the client kept simulating a world nobody
   owned any more, against a wire that would never speak again.

   `LanLobby.onRoomClosed` now fires after the room state settles, `MatchChannel` requires it (for
   the same reason `onPeerRejoin` is required — a channel that quietly lacked it strands a player
   with nothing on screen to say why), and `main.ts` routes it to a modal that freezes the world.

   **The words are the game's own**, read from `UI\FrameDef\GlobalStrings.fdf` through the
   `GetLocalizedString` table the renderer already loads: `GAMEOVER_GAME_OVER` ("Game over."),
   `GAMEOVER_DISCONNECTED` ("You were disconnected.") and `GAMEOVER_QUIT_GAME` — whose `|CFFFFFFFF…|R`
   codes mark the accelerator letter and are stripped, since we render text rather than parse it.
   The English literals in the code are only the fallback for a table that has not loaded; a
   localized install says what it says.

   **Tests: `sim:test` 494 → 496** — the match is told, with the reason, and only after the lobby
   has stopped claiming to be in a room; the rejoin token is forgotten, because there is nothing to
   come back to. The injection (the notification dropped) turns the first red. **Verified in the
   browser**: the host chose End Game and the client's screen froze under the dialog, whose button
   returned it to the main menu.

7. ~~**The loser was never told it lost.**~~ **Fixed.** The stop condition says "play a match to a
   natural end", so the match was played to one: the host marched its five peasants across Echo
   Isles and razed the client's Great Hall. The host got the real **Victory!** screen and the log
   line "Player 2 was defeated. Player 1 was victorious." The client watched its base turn to
   rubble — the snapshot got that right — **and went on playing.** No defeat screen, HUD still
   reading `5/10` food, 103 units to the host's 102.

   **Because the verdict was computed from the wrong world.** The melee victory/defeat screen is a
   plain JASS `dialog`, and every machine runs the map script. blizzard.j's defeat check fires off
   unit DEATH events in the world its script can see — and a client's world never receives the
   host's commands, so the army that razed the hall never moved there, the hall never died
   locally, and no check ever ran. Meanwhile the host's script raised a dialog addressed to
   player 1, which the host correctly did not show (it only renders dialogs visible for its own
   seat). The verdict existed on exactly one machine and reached nobody.

   **So the outcome crosses the wire.** `DialogMessage` is a new member of the game channel:
   the host relays any dialog its script raises for a player who is not sitting here, addressed
   to that player's peer, once per `handleId:revision`. The client rebuilds it into the same
   `DialogObj` its own script would have produced, so `GameDialog` renders the real screen off
   the game's own `ScriptDialog.fdf` and `GlobalStrings.fdf`.

   **One way, deliberately.** The two behaviours a dialog button has are the ENGINE's and both are
   local — any click closes it, a quit button leaves the match — so nothing has to travel back and
   the client's own UI answers its own buttons. That also means this is not a general dialog-relay
   feature: it carries the message and the buttons, and a map script that wants a click routed
   back to the host still cannot have one. Said here rather than discovered later.

   **Tests: `relay:test` 100 → 107.** The loser is told with the game's own words and the button
   that ends the match comes with it; a THIRD player in the room is not handed the loser's screen;
   a verdict for the host's own seat or for a computer slot reports that it went nowhere, so a
   caller retries an unseated peer instead of writing it off. **Two traps hit while writing it,
   both worth recording.** The bystander check first asked the HOST whether it received its own
   broadcast — which proves nothing, because the relay never echoes a sender its own message, and
   the broadcast injection walked straight through it; it needs a real third peer, and `room()`
   caps at two, so a third `join` was being refused as full and receiving nothing for the most
   boring possible reason. And the check for "the host's own seat is not relayed to itself" went
   red on the first run: `sendDialog`'s comment claimed that skip and its code did not.

   **Verified in the browser, end to end, twice** — once to see the break and once to see it fixed.
   Same scenario both times: host razes the client's hall. Now the client gets "You failed to
   achieve victory." in the game's own chrome, and its Quit Game button leaves the match.

8. ~~**A client leaving a match CRASHED the relay — the whole process, for every room on it.**~~
   **Fixed.** Found seconds after item 7 was confirmed: the client clicked Quit Game, and
   `server/rooms.mjs` threw `Cannot read properties of null (reading 'send')` out of the
   connection handler and ended the process.

   `case "relay"` did `if (target) target.conn.send(out)`. A peer whose slot is HELD after a drop
   has `peer.conn = null` by design — item 11a keeps it in the room table so its token can
   reclaim the seat — and the host goes on addressing snapshots to that peer at 10 Hz. **Every
   other send site in the file already guards `p.conn`;** this one is older than the held slot and
   nobody came back to it. One player choosing Quit Game ended everybody's game, on every room the
   relay was hosting.

   **Silence is the fix, not a queue.** What that peer misses while away is a stream of snapshots
   that are stale the moment the next one is built, and a rejoin is already answered with a FULL
   one off the cadence (item 11b) — so the gap heals itself the instant they are back. Buffering
   would make the relay hold match state, which is the one thing it must never do.

   **Tests: `relay:test` 107 → 110, over real sockets**, because the failure was a dead SERVER and
   nothing in-process can show that. The check is not about the message: it is that the relay is
   still answering afterwards, and that the room and its held slot are still there. The injection
   — the original unguarded dereference — turns both of those red rather than aborting the run,
   because the poll that asks is guarded (see the trap list).

**A harness note worth more than it looks:** to reach a natural end, **spawn heroes from the
dev panel** rather than marching starting workers. The developer pointed this out after I spent
two runs watching five peasants get distracted by peons — a worker rush takes minutes, keeps
losing its attack order to retaliation, and twice failed to raze the hall at all. Heroes are one
click each, hit hard enough to end it quickly, and make victory/defeat a cheap thing to test
rather than an expedition.

### Phase G — the wire after the whistle

1. ~~**A finished match kept paying for a wire nobody needed.**~~ **Done.** The developer's rule:
   **the relay is dropped as soon as the game ends — the moment the victory/defeat screen comes
   up.** After that every player has their own independent state of the world and it does not
   matter, because the game is officially over. That is how Warcraft III behaves.

   **The signal is Blizzard's own, and it is not the dialog.** Keying on "a dialog appeared" would
   drop a player off the wire the first time a map raised a quest popup. Read out of the real
   `Scripts\Blizzard.j` (War3Patch.mpq): `CustomVictoryBJ` and `CustomDefeatBJ` both call
   `RemovePlayer(whichPlayer, PLAYER_GAME_RESULT_*)` **before** they show anything, and
   `MeleeDoDefeat` reaches it through `RemovePlayerPreserveUnitsBJ`. So `RemovePlayer` fires
   exactly once per player per match, at the moment the outcome is decided. It was a stub
   returning null; it is now the hook `playerGameOver`.

   **A DEFEAT ends one player's game; anything else ends the MATCH — and only the second kind
   drops the wire.** That is the developer's correction to the first cut of this item, and it is
   the whole rule: a defeated player in a three-way is still watching somebody else's game, and
   hanging up on them would be taking it away. They keep their wire, and their "Continue Game"
   keeps meaning something.

   So the result argument IS read, which puts this squarely in the path of the miscount that
   broke `mapcontrol`. It was taken from the file rather than from memory —
   `Scripts\common.j`, checked in **both** War3.mpq and War3x.mpq, which agree:

   ```
   constant playergameresult PLAYER_GAME_RESULT_VICTORY = ConvertPlayerGameResult(0)
   constant playergameresult PLAYER_GAME_RESULT_DEFEAT  = ConvertPlayerGameResult(1)
   constant playergameresult PLAYER_GAME_RESULT_TIE     = ConvertPlayerGameResult(2)
   constant playergameresult PLAYER_GAME_RESULT_NEUTRAL = ConvertPlayerGameResult(3)
   ```

   The test is written as **"anything but defeat"** rather than "equals victory", and that is not
   pedantry: a TIE or a neutral game-over ends the match just as finally, and matching only on
   victory would leave the wire up forever after one.

   **Two things had to be got right, and neither is obvious from the instruction:**

   - **Relay first, then hang up.** The host learns the outcome from `RemovePlayer` *during* the
     script call, but it owes the loser a screen (item F7) that is only sent later, in the
     per-frame dialog relay. Closing at the hook would tear the socket down in the same frame
     that owes the loser the explanation. So the hook only RECORDS, and the close happens after
     the relay loop.
   - **A match that ended does not also get disconnected.** The host hanging up closes the room,
     so every client is about to be handed `room-closed` — which item F6 turns into "You were
     disconnected." over the top of a perfectly good Victory screen. `showMatchOver` now returns
     early once this machine's match has ended properly. That is news about a wire nobody needs
     any more, not about the match.

   **A client cannot use the same signal, so the authority stamps it.** A client's own script
   never runs the defeat check (that is the whole of F7), so `RemovePlayer` never fires there.
   `DialogMessage` grew `over?: boolean` — the host sets it on a dialog relayed to a seat whose
   game it just saw end — and the client hangs up on that rather than on the mere arrival of a
   dialog.

   **The "defeated host ends everyone's match" hazard the first cut carried is gone**, and it is
   gone as a consequence rather than by a second patch: a defeated host is a DEFEAT, so it no
   longer decides anything and the host keeps hosting for whoever is still playing.

   **What remains, in a game with more than two humans:** a player knocked out early keeps their
   wire and goes on watching, which is right — but when the match finally ends they get
   `room-closed` rather than a screen, so they see "Game over. / You were disconnected." instead
   of a result. Honest, since their wire genuinely did just go, and the title is at least the
   right one. Worth a real ending when there is a third seat to test it with.

   **Tests: `relay:test` 110 → 114, `jass:test` audience 23 → 25.** An ordinary dialog carries no
   ending and the verdict does (so the stamp is the stamp, not "every relayed dialog"); ending
   the match closes the channel; and `RemovePlayer` reports **both** the player and the raw
   result index, which is the check that stops the enum silently rotting. Two injections —
   `endMatch` that does not close, and a native that reports every result as victory — each turn
   their own named check red, and the second one is precisely the `mapcontrol` failure mode.

   **Verified in the browser, the whole flow, and re-run after the defeat/victory split.** Host
   razes the client's hall: host gets Victory!, **the loser still gets "You failed to achieve
   victory."** — so the relay-before-hang-up ordering held — the room is **gone from the relay**
   the moment the screens appear, there is no "You were disconnected." stacked on the defeat
   screen, and the client's `[sync]` counter **freezes at `received 1519`** and stays there.

   That last run answered a question the split raised and the code alone could not: blizzard.j
   declares the defeat and the victory **in the same script pass**, so `matchDecided` is already
   true when the frame's relay loop runs and the loser's screen goes out stamped as final. Had
   victory landed a tick later, the loser would have been left holding an unstamped dialog and
   then handed a disconnect notice on top of it. It does not, and now that is measured rather
   than assumed.

   **And then driven in a browser too — the case the split exists for.** Four seats on **Lost
   Temple**: two humans and two computers, the host marches three heroes into the client's base
   and razes it. The host's log reads **"Player 2 was defeated." and nothing else** — no victory,
   because two computers are still standing — and the three things that had to be true were:

   - the **room is still listed** on the relay: nobody hung up;
   - the client's `[sync]` counter is still **climbing** (`received 2692 → 2701 → 2709`): its wire
     is alive and it is still being handed the world;
   - the client shows **"You failed to achieve victory."** and no disconnect notice.

   Before the split, all three would have been false: any `RemovePlayer` decided the match, so
   one player's defeat would have torn the room down under two computers that were still playing.

   **A detail checked against Blizzard rather than assumed.** The defeated player's dialog offers
   only *Quit Game*, with no "Continue Observing" — and that is faithful, not missing:
   `MeleeDefeatDialogBJ` adds that button only `if (not bj_meleeGameOver and
   IsMapFlagSet(MAP_OBSERVERS_ON_DEATH))`, and observers-on-death is off in a default melee game.
   So under the default rules the wire staying up after a defeat matters for the OTHER players —
   the host must keep hosting — rather than for the loser's spectating. It becomes directly
   useful for them the day that lobby option exists.

   **Still not driven:** what a player defeated early sees when the match *finally* ends. They
   would get `room-closed` rather than a result screen (see above). The 1v1 ending is verified;
   this one needs the two computers killed as well.

2. **`?maps=` takes names, not just a count — because the harness could not reach the map it was
   asked for.** `?maps=8` samples the first N of an install holding hundreds, so "test it on Lost
   Temple" was unreachable: Lost Temple sorts past the twenty-map cap. That is the same gap
   `?maps=N` itself was invented to close, one level in — a harness that cannot reach the MAP it
   was asked for reports the wrong thing about it, just as one that cannot reach a screen does.

   `?dev&maps=LostTemple,EchoIsles` now mounts exactly those two and shows the menu, matching
   names the way `?map=` already does (case-insensitive substring, Frozen Throne first where both
   editions ship one). A count still means a count; the cap still applies to both, because
   fetching is the slow part either way. `import.meta.env.DEV`-only, like the rest of the boot.

   Found the hard way: two runs were spent on Adrenaline instead, a heavily forested 4-player map
   where the heroes took minutes to path anywhere and the base hunt never finished.

3. **The six-bug reproduction session.** The developer's live two-window playtest reported six
   bugs; before fixing any of them, one scripted two-window session (`?dev&map=EchoIsles&lan=host`
   / `lan=join`, fresh relay) reproduced what it could and pinned each mechanism in code. What was
   actually seen, per bug — corrections to the report included:

   - **Bug 4 (client-trained unit comes out host-owned) — reproduced, and the root cause is NOT
     the id collision.** The client trained a peon from its Great Hall; the peon came out with a
     red "Player 1" tooltip, a red selection circle and an EMPTY command card on the client — and
     the HOST's food climbed 5/12 → 6/12 and its worker count 5 → 6, so the mis-ownership is real
     on the authority, not a presentation artifact. Mechanism:
     `world.trainCompletions` carries no owner (`src/sim/world.ts:1317`, pushed at `:2600`), and
     the renderer's drain spawns every trained unit as
     `this.spawnUnit(d, sx, sy, this.localPlayer, ...)` (`src/render/mapViewer.ts:5830`).
     Harmless in single-player, where only the local player ever trains; on a host applying a
     client's command it hands the client's unit to the host. **Option 2 does not fix this** —
     the host's drain is the bug; the event must carry (or the drain must derive, via
     `buildingId`) the building's owner. A consequence observed live: the host-owned twin then
     stands inside the client's base granting the HOST live vision there — an intel leak.
   - **Bug 6 (client-built building is only an ubersplat) — reproduced.** The client placed an
     Orc Burrow (cost deducted 160g/40w, local food cap 10 → 20 on completion); 60+ s later the
     site showed the ground splat and a floating health bar and **no model**, on the client,
     while its peon stood beside it idle. The dot/model split showed up here too: the client's
     minimap draws every payload unit (`dotsFromSnapshot`, host-id-keyed) while a model needs a
     render `Entry` under that id — and entries are created ONLY by the local sim's own spawns
     (`mapViewer` never iterates snapshot units; grep confirms). A host id with no local entry is
     a dot with no body; a local entry whose id means something else on the host is a body lying
     about itself. That is item 2c's missing path, verbatim.
   - **Bug 1 (client cannot see the host) — reproduced with a caveat.** A client peon marched
     into the host's base and stood on empty grass: no Town Hall, no peasants, nothing — while a
     neutral creep nearby DID draw, so the AoI wire itself was delivering. The caveat: it was
     night, the peon's night sight is short, and the client's minimap did afterwards show the
     host's mine and one red dot as explored — so "cannot see AT ALL" may be "the payload never
     contained what the report expected" rather than "nothing is ever sent". Per the plan: pin it
     properly after 2b, when ids can no longer diverge.
   - **Bug 2 (host must stay focused) — does NOT reproduce in this harness, and that is itself
     the finding.** Both agent-browser windows ran unthrottled: the host held a steady ~10 Hz
     snapshot cadence (measured 137 sent over 16 s) with neither window focused. The bug needs
     real, visible, occludable Chrome windows. The mechanism is confirmed in code regardless:
     the host's fixed-timestep sim is pumped ONLY from the render loop's
     `requestAnimationFrame` (`src/render/mapViewer.ts:5771`, loop at `:6091`), which Chrome
     throttles to ~0 for hidden/occluded windows — and `MAX_STEPS_PER_FRAME` then DROPS the
     accumulated backlog on refocus (`:5777`), so the lost time is lost for good. The moving
     shadows are the other half, confirmed: `updateShadowBatch` iterates the client's LOCAL
     `world.units` (`src/render/mapViewer.ts:6274`) while models draw from the snapshot — the
     shadows animate off the client's own prediction while the models wait for snapshots that
     are not coming. **Any fix must be verified with real visible windows, not this harness.**
   - **Bug 3 (jitter) — deferred, wire measured healthy.** Snapshots arrived at a steady ~10 Hz
     with `stale 0`; positions render verbatim with no interpolation (by design, "none in v1").
     Consistent with 10 Hz-shaped stepping; judged properly only once the world steps and ids
     are stable, per the plan.
   - **Bug 5 (Archmage wearing an Altar's model) — not re-created verbatim**; it needs the host
     and client to allocate colliding ids to different unit kinds, which this session's light
     play did not line up. The family is demonstrated structurally by bugs 4/6: position/stats
     from the host's snapshot under one id, model/identity from the client's local entry under
     the same number meaning something else.

   Two more facts recorded for 2d: the client's HUD resources are its own prediction (its gold
   kept climbing from local-sim mining while the host's books differ), and a client's local-sim
   deaths move its food/unit counters (its first peon died to a creep camp on both sims and the
   client's HUD read the local copy). Both freeze or lie the moment the client stops stepping —
   the snapshot must carry the recipient's stash.

4. **The authority no longer stops when Chrome stops its render loop (playtest bug 2).** The
   whole game advanced only inside the rAF frame (`advanceSim`'s block used to live inline in
   `mapViewer.start()`), and Chrome stops rAF outright for a hidden or occluded window. Two
   windows on ONE machine means the host is usually the covered one — so the authority froze,
   every client stopped receiving, and `MAX_STEPS_PER_FRAME` dropped the backlog on refocus, so
   the lost time was lost for good. The developer's observed "client movement only registers
   while the HOST window is focused" is exactly this, and the moving shadows were the client's
   own `updateShadowBatch` reading its LOCAL sim while the models waited on snapshots.

   **The fix is a dedicated-Worker clock.** Page timers are clamped in background tabs (~1 Hz,
   worse under intensive throttling); a dedicated Worker's are not. `startBackgroundPump` spins
   one up the first frame a match is `networked` (single-player keeps the browser's natural
   "hidden tab = paused game"), posting every 50 ms; the handler stands down while rAF is alive
   (`lastFrameAt` within 200 ms) and otherwise drives two things:

   - **`advanceSim(now)`** — the fixed-timestep block, extracted, now owning its own clock
     (`simLast`) SHARED between both drivers, so whichever runs next advances only by the time
     the other has not already spent. Sim, commands, vision, snapshot emit — all of `rts.tick`.
   - **`drainWorldSpawns(world)`** — the drains that CREATE world state (trained units, summons,
     script spawns, felled trees' line-of-sight), split out of the render loop, because the sim
     owns no models: the renderer's `spawnUnit` is what makes a trained unit's record, and
     until it runs no snapshot can carry the unit. Cosmetic drains (effects, spell sounds, item
     art) stay frame-only — they dress a window nobody is looking at, and flushing them late on
     refocus is harmless where a missing UNIT is not. Every queue is drain-once, so the frame
     and the pump can both call the same code and whichever runs first finds the work.

   **Verified A/B in the browser, with a true red baseline.** The harness cannot occlude a
   headless window, so occlusion was emulated by evaluating
   `window.requestAnimationFrame = () => 0` on the host mid-match — the frame loop schedules
   its successor through that call, so this stops it exactly as occlusion does. On the PRE-fix
   build (`git stash`, fresh windows): the client's `[sync] received` froze at 90 and stayed
   frozen across three samples over 30 s. On the fixed build (stash popped, fresh windows):
   received climbed 110 → 357 at the full 10 Hz with the host's render loop dead — and a peon
   the CLIENT trained during that state completed AND spawned (103 → 104 units in the client's
   snapshot-drawn view), which only the pump's `drainWorldSpawns` could have done. Honest
   limits: the emulation kills rAF, which is the dominant effect of occlusion but not all of it
   (real backgrounding also clamps page timers — which is why the clock is in a Worker, the
   standard exemption); the true two-visible-windows-on-a-desktop case still needs the
   developer's eyes. Counter moved and declared: `grep -c simWorld src/render/mapViewer.ts`
   32 → 33 — the one new use is the pump handing the world to the same drain code the frame
   uses, a driver rather than a new draw surface.

5. **A trained unit belongs to whoever owned the trainer (playtest bug 4).** The sim's
   `trainCompletions` event carried no owner, and the renderer's drain filled the gap with
   `this.localPlayer` — right in single-player, where only the local player ever trains, and
   wrong on a LAN host completing a REMOTE player's training: every peon a client trained came
   out host-owned, ate the host's food, sat uncommandable behind an empty card on the client,
   and stood in the client's base leaking live vision to the host.

   The owner is captured ON the event at completion time (`world.ts` `tickBuildings`) rather
   than re-read at the drain — the unit belongs to whoever owned the building when the job
   finished. The drain spawns with `t.owner`/`teamOf(t.owner)`, and the "unit ready" voice is
   now gated on `t.owner === localPlayer` like the research chime always was — a host should
   not hear a client's peon announce itself. Summons and script spawns already carried their
   owner; training was the only drain with the localPlayer assumption.

   **Tested where it lives:** `sim-order-funnel-test` grew a named check — "the completion
   carries the TRAINER's owner, not a machine default" — driven through the real
   `enqueueTrain` → `tickBuildings` path on a building owned by player 3. Reintroducing the
   bug (owner hard-wired to 0) turns exactly that check red; restored, the suite is green.
   `sim:test` 496 → **499**. **Verified in the browser:** client trains a peon → it comes out
   with a green circle and a full command card on the client (worker count 6, food 6/10), and
   the HOST's books no longer move (5/12 food, 5 workers — they read 6/12 and 6 before the
   fix). Note the trained unit now also lands on the same id in both sims in this scenario
   (both allocate the next id for the same unit), so the client's drawn peon is whole — the
   id-divergence family (bugs 1/5/6) still needs option 2 for anything the two machines
   create in different orders.

6. **Option 2's sizing pass (2a), read-only.** Every `sim.units.get` site in `rts.ts` (55), both
   `sim.units` iterations, all eleven `frameUnit()` consumers, every unit-record read off
   `simWorld`/`simView` in `mapViewer.ts`, and `simView`'s own surface were inventoried for
   WHICH `SimUnit` fields they read, then held against `UnitSnapshot`. The half-populated-record
   risk turns out to be small on the UNIT side and real on the WORLD side.

   **Unit fields: the snapshot already carries what the readers read.** The dominant reads —
   `x`/`y` (~45 sites), `owner` (~28), `building.*` (~25), `hp` (~13), `worker.*`, `inventory`,
   `abilities`, `buffs`, the whole `infoFor` panel block, the hero block, `garrison`,
   `radius`, `order`/`moving`/`swingSeq`/`chopSeq`/`spawning` (entry-sync animation) — are all
   on `UnitSnapshot` field-for-field, which is unsurprising: the type was built by reading
   these same consumers (its own header says so). Existence-only sites (~14, e.g. `pruneSelection`,
   `livingGroup`) keep working under 2b's create/remove semantics — "exists" becomes "was sent",
   which is the intended meaning. The stragglers, none load-bearing:
   - `pathStamp.fp` (building footprint corners, `mapViewer` ~2211) — re-derivable from the
     unit DEF's `pathTex` via the registry; the record need not carry it.
   - `path`/`waypoint` (`debugUnitPaths`) — the Show Pathing debug overlay; on a frozen client
     sim it simply draws nothing. Accepted loss.
   - `paused` (`simView.isUnitPaused`) and the waygate pair (`waygateIsActive`/`waygateDestination`)
     — script/simView surfaces; moot on a client once 2e settles what happens to its script.
   - `unsummonArt`/summon-triple WRITES from the summon drain — authority-side only; a client
     under option 2 never drains summons.
   - `prevX`/`prevY` did NOT show up in any reader — the Phase E note about the renderer
     leaning on it should be re-checked once during 2b, then dropped.

   **World state: three real gaps, all per-recipient, all wire changes (bump PROTOCOL_VERSION):**
   1. **The recipient's stash** — gold, lumber, food used/cap (item 2d, already on the plan):
      `stashFor`/`foodFor` read the LOCAL sim, so a frozen client's HUD freezes or lies.
   2. **The recipient's TECH state** (researched upgrade levels): `techMeets` gates every
      command-card button's requirements, and research completes in the HOST's
      `tickBuildings` — a frozen client never learns its own Forged Swords finished, so
      buttons stay greyed and upgrade chains stick at level 0. Needs the recipient's
      researched-levels map in the snapshot (unit STATS already arrive correct — the host's
      `recomputeStats` bakes upgrades into the record).
   3. **Shop stock**: `BuildingSnapshot` deliberately withholds `stock` (it reaches the client
      through `shopStock` on the read window — the LOCAL sim again), and stock replenishes on
      the host's game clock. A client's shop card would freeze. Carry stock for shops the
      recipient can see, or accept a stale card in v1 and say so.

   The highest-volume readers (entry sync, `pickAt`, `updateHealthBars`, rings, hover, and
   `mapViewer`'s `units.values()` sweeps — `updateShadowBatch`, `updateAuraEffects`,
   `tickPendingBuild`, Blood Mage spheres) all read fields the snapshot carries, so 2b can
   proceed: records written from `UnitSnapshot` satisfy every reader, and the three world-side
   lanes above are the whole of what must be ADDED to the wire.

7. **Option 2's applier (2b): a client's sim stops stepping and the payload writes the
   records.** `src/game/snapshotApply.ts` (standalone-compiling, in the sim build):
   `applyWorldSnapshot` CREATES a record for an id the store has not seen (through
   `addSimUnit` under the HOST's id — a client allocates no ids of its own, so none can
   collide), UPDATES the ~60 carried fields (`writeUnitSnapshot`, `snapshotFor` run in
   reverse: composites PATCH the def-seeded sub-objects rather than replacing them, so
   def-derived fields the wire omits survive), and REMOVES records absent from the payload
   through the sim's own `removeUnit`, so footprints unstamp and cells free. Absence means
   "you cannot see it" — the enemy's base is now out of the client's process MEMORY, not
   merely off its screen. Mines keep their last gold reading when sent -1 (no eyes); ground
   items follow the units' create/remove rule; the world clock is the payload's.

   In `rts.tick`, `frozenClient` (wire attached, not host) skips `sim.tick` and applies the
   newest payload exactly once per arrival; everything downstream — drains (now empty),
   corpse bookkeeping, `viewpoints.tick` (client fog now rebuilds from the units it was
   SENT, which is 2f by construction), the entry sync — runs unchanged against the written
   records. The renderer refuses two things on a frozen client: `tickPendingBuild` (a local
   build-start would mint a local id) and `drainWorldSpawns` (same, for script spawns).

   **Verified headlessly, with a red-proven maphack check.** `tools/sim-apply-test.cjs`
   (13 checks, `sim:test` 499 → **512**): "a record absent from the payload is GONE — not
   hidden, gone" goes red when the removal loop is disabled and green restored; creation
   under a foreign id, field landing, `prevX` roll-forward, the morph `typeId` rewrite, the
   building patch keeping def-derived fields, mine -1 semantics and item removal all have
   named checks. `relay:test` 114, typecheck and the standalone compile (now including
   `snapshotApply.ts`) clean.

   **NOT yet verified in the browser** — stated plainly: the two-window drive for this item
   was attempted repeatedly and the agent-browser daemon wedged under the two WebGL
   contexts each time (the known fragility; kills + retries per the harness rules did not
   yield a stable session, and the client window also kept being reloaded out of its match
   by a dev-server restart from an edited `package.json`). What the next session must
   confirm live before building 2c on top: the client's unit-count readout DROPS from 103
   to the sent-only set after the first payload (the maphack closure, visible in the
   corner), its own base still draws and orders still walk its peons, and no spurious
   verdict fires from the client's still-running map script against the reduced world.
   **Known interim regressions this staging accepts until 2c**: a unit created mid-match
   (e.g. a client-trained peon) gets a RECORD on the client but no render entry — a dot
   with no body — because entries are still only created by local spawns; and a
   re-scouted enemy building's entry was dropped with its record, so it will not redraw
   until entries grow from `ApplyResult.created` (2c's whole job).

8. **The developer's first 2b playtest found two real breaks, both now fixed and driven
   live.** The report: "the client couldn't see any of their units and lost instantly" —
   its start area explored but empty of models.

   - **The client's own base was records without bodies.** Melee starting units are born
     by the MAP SCRIPT (`startMelee` → `runMapScript`), and their models arrive through the
     script-spawn drain — which item 7's gate had turned off for frozen clients wholesale.
     That gate confused two different things: the queue drains genuinely CREATE sim records
     under fresh local ids (must stay off), while the script-spawn drain only gives a body
     to a record that already exists under ids every machine allocates identically. The
     drain is now split: script spawns attach for everyone, first; the creating drains
     still refuse a frozen client.
   - **The instant defeat was the client's own script judging an AoI world — the 2e fork,
     decided by a live failure.** The client's melee victory check, still being pumped,
     read a world from which the applier had (correctly) removed every host unit it cannot
     see, concluded the opponent had nothing, and ended the match on the spot. A script
     read against an AoI subset can never judge a match, so the fork closes on the side
     the doc suspected was honest: **a frozen client runs the script INIT (config/main —
     the starting bases and their agreed ids are born there) but never PUMPS it.** Timers,
     region triggers and victory checks run only on the authority; what they produce
     reaches a client over the wire, which items F7/G1 already built (dialogs and the
     `over`-stamped verdict). Melee loses nothing; a custom map's local presentation now
     plainly waits on 2e's relay rather than half-running against a wrong world.

   **Verified live, two windows through the relay:** the client draws its full base, its
   readout says **6 units** — the record store holding exactly its own hall and five
   peons, the maphack closure visible in the corner where 103 used to sit — no verdict
   fires over a minute of play, a client move order crosses and its peon walks in the
   snapshot-drawn view, and the host runs untouched at 103. Suites unchanged:
   `sim:test` 512, `relay:test` 114, typecheck clean. **Still owed to close item 7's
   verification debt:** a natural end (host razes the client's hall → both real screens
   over the F7/G1 relay) has not been re-driven on THIS build, and the 2c regressions
   (mid-match units are dots without bodies on a client) stand until entries grow from
   `ApplyResult.created`.

### The closing run

One clean pass on a build carrying all eight fixes, because the previous end-to-end drive had
ended with the relay dying (item 8) and no run had ever completed on the mended build.

Two windows, the real menus, nothing scripted: **Local Area Network → Create Game → Echo Isles →
Create → the second window sees `Player's Game 1/2` → Join → both rosters read 2/2 and "Everyone
is here. Start when you are ready." → Start → both in the match.** Then the host spawned three
Alchemists from the dev panel — **the developer's tip, and it is the difference between a test and
an expedition**: a worker rush takes minutes and keeps losing its attack order to retaliation,
where three level-6 heroes cross the map and raze a Great Hall in about a minute — marched them
across, and razed the client's hall. The host got the real **Victory!** screen.

**The relay was still listening, still serving, with the room intact, at the end of all of it** —
which is the exact thing that failed last time, and the one claim this run existed to make.

**Honest about what this pass did NOT capture:** the client's own screen at the moment of defeat.
Its browser daemon wedged mid-run (the known two-WebGL-context fragility), and per the harness
rules that is one retry and move on rather than an iteration spent fighting it. The client's
defeat screen — "You failed to achieve victory." in the game's own chrome, Quit Game returning to
the menu — was captured in the previous iteration, on this same code path, unchanged since.

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

- ~~**9/10 sequencing.**~~ **Decided — B: the client renders snapshots and keeps simulating**, so the two can be diffed and the divergence logged (item 10a is that detector). A deliberate temporary state: the local sim comes out once the log is quiet.
- ~~**When does the client's local sim come out?**~~ **Decided — option 2: stop STEPPING it, keep
  it as a record store the snapshot writes.** Four options were put to the developer and this is
  the one taken; the other three, and why they lose, are worth keeping:

  1. *Leave it.* Free, and keeps both costs below.
  2. **Chosen.** `sim.tick` is skipped on a client; arriving snapshots create, update and remove
     records. The ~55 identity-and-permission sites in `rts.ts` keep working unchanged, because
     the records still exist and carry the fields they read — `owner`, `x`, `y`, `building`,
     `hp`, `inventory` are all already on `UnitSnapshot`.
  3. *Keep stepping, reconcile each snapshot.* Rejected: you can only reconcile what you were
     SENT, so fogged units keep their locally-simulated positions and the maphack below survives
     as a mirror nobody can check.
  4. *Delete the `SimWorld` on clients entirely.* The endgame, and this is a staged step toward
     it rather than a detour — 2 first shows which fields the wire is actually missing.

  **What decided it was not CPU, it was a maphack.** A client's process holds the WHOLE map
  today: it runs the same melee init for every slot, so the enemy's base is in its `SimWorld`.
  Measured rather than assumed — both windows' debug readout says `103 units`, identical, in a
  match where AoI filtering is working. The filtering keeps the enemy off the SCREEN, not out of
  MEMORY, and devtools is all it takes. That is a bigger hole than the client-side fog
  re-derivation this document warns about in its own traps.

  **Known cost, and it is a phase rather than a commit:** a client also runs the map script.
  `runMapScript` executes on every machine — that is why `GetLocalPlayer` had to be made
  per-recipient (item 7b). A client that stops simulating has a JASS interpreter still mutating a
  world that no longer exists, so the script's world-writing half must be muzzled on clients, and
  anything it drives locally then has to arrive over the wire instead. Item F7 is the first
  instance of exactly that, done for the victory/defeat dialog. The half-populated-record risk in
  option 2 is bounded and testable, and sizing it is the first move.
- **Host input delay.** Handicap the host to the room's median RTT, or accept the advantage in v1?
- **NAT traversal.** Pure relay (simple, all traffic through the free box, bandwidth-bound) vs. WebRTC
  data channels with the cloud box as signaling only (cheaper to host, much more moving parts).
  Bandwidth on a free tier likely decides this.
- ~~**Snapshot encoding.**~~ **Decided — JSON first, binary when it hurts.** The developer's call,
  taken knowingly rather than inherited: this file had leaned that way since before there was a
  snapshot to encode, which made it a guess and not a decision. Snapshots are new code and will be
  wrong at first, and a payload readable in devtools is worth more during that stretch than the
  bandwidth a binary format would save. Relay bandwidth on a free tier is the thing that would
  force the change; revisit then, not before. Unblocks [item 5](#remaining-work-in-order-2).
- ~~**Are player viewpoints created at match START or lazily?**~~ **Decided — at match start.**
  Every slot gets a `Viewpoint` at tick 0. This closes Phase D item 4's known limitation outright
  (a one-shot `SetFogState` is not replayed onto viewpoints created later) rather than carrying it
  as a live bug, and it makes the N-rebuild cost a constant paid up front — ~0.75 ms per viewpoint
  at 10 Hz, four viewpoints = 3.01 ms per round at Echo Isles scale (measured, Phase D item 7).
  The lazy alternative would have saved ten grids on a twelve-slot two-player match and paid for it
  with an unpredictable mid-match cost spike and a fog hole left open. Unblocks
  [item 2](#remaining-work-in-order-2).
- ~~**Item 7b: enforce Blizzard's no-net-traffic contract, or accept the risk?**~~ **Decided,
  twice, and the second answer was not on the original menu.** First: evaluate a
  `GetLocalPlayer`-gated block **once per recipient**, because that is the correct behaviour.
  Then, when the work was sized: neither enforce-everywhere nor accept-the-risk, but **the
  host's own pass runs unchanged and only the extra passes are muzzled** — so a world write
  inside a gate happens exactly once, never N times and never zero times. World behaviour is
  identical to before the item; only presentation became per-recipient. Both the developer's
  calls; see [item 7b](#remaining-work-in-order-2).
- **Cold start.** A free instance sleeping after 15 min means the first player waits ~30–60 s for the
  *relay* to wake. Survivable with an honest "waking server" screen — and note this only ever delays
  lobby join, never an in-progress match, since the match itself does not run there.
