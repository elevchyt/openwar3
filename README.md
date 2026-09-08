# OpenWar3

![OpenWar3 screenshot](screenshot.png)

A recreation of the **Warcraft III** engine in TypeScript. Ships **zero Blizzard assets** — uses your own install at runtime. **The Frozen Throne 1.30.4** is the recommended version — it is what OpenWar3 targets, and its CASC content store is the storage the engine is built around. Older MPQ-era installs still mount, but are supported only on a best-effort basis.

Goal: liberate WC3 from legacy constraints and bring the engine up to modern standards. Features planned:

- **Cross-platform** — Windows, Linux, macOS, anything with a browser
- **Multiplayer reconnect** — no more dropped games lost
- **Better AI** — **Computer+**, a second melee AI beside Blizzard's own: friendlier to newer
  players, and it never cheats at any difficulty. Tick it in Advanced Options ([how it works](docs/computer-plus.md))
- **Huge control groups** — dozens of units can be added to a single control group
- **Select army hotkey** — select all combat units with a single hotkey (-)
- **Voice control accessibility mode** — a gameplay option that allows people with disabilities to enjoy the game
- **Voice chat in multiplayer** — push-to-talk voice chat implemented like in other games like DotA
  
Contributions welcome.

## Quick start

```bash
pnpm install
pnpm dev           # http://localhost:5173
pnpm build         # typecheck + build to dist/
```

### Playing on a LAN

Two machines on the same network, no cloud and no accounts. On the machine hosting:

```bash
pnpm dev --host
```

The other machine opens `http://<that machine's ip>:5173` and picks **Local Area Network** — games
created on either machine show up in the list. There is nothing else to start: the dev server
carries the relay on its own port, so one open port is enough. Each machine reads its own local
Warcraft III install, as always.

(Either player can create the game; whoever does runs the authoritative simulation. Games are found
through the relay's room list rather than by broadcast, so both machines must be pointed at the same
address — see [docs/multiplayer.md](docs/multiplayer.md) for the internet deployment and for why
broadcast discovery waits on a native build.)

## Legal

OpenWar3 is original code with zero copyrighted assets. Assets read from your local install, client-side, never uploaded or hosted. Engine fully open.

Licensed under the [MIT License](LICENSE).
