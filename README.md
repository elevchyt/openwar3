# OpenWar3

![OpenWar3 screenshot](screenshot.png)

A recreation of the **Warcraft III** engine in TypeScript. Ships **zero Blizzard assets** — uses your own install at runtime.

**The Frozen Throne 1.30.4 is required**, and the game checks it. Every unit's stats, every
ability, every cost and timing is read out of each player's own install, so two people on
different patches would be playing different games — the host would resolve an order against its
Footman while the client drew the one in its own tables, and nothing in the network protocol could
catch it. So the version is a gate rather than a recommendation: an install that is not 1.30.4 is
refused with a message naming what it found, at the folder dialog and again at **every launch**
(the desktop app remembers your folder, and Warcraft III can be patched between one session and
the next). Pre-1.30 MPQ-era installs are older than that build by construction and are not
accepted.

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

### The desktop app

```bash
pnpm build && pnpm app
```

One window, one process. It asks for your Warcraft III folder **once** and remembers it — every
launch after that goes straight to the menu — and it reads that folder off your disk rather than
through the browser's picker, so there is no permission dance and no storage quota. Nothing is
uploaded, and nothing about your install is reachable from the network: the app reads it over a
scheme of its own that exists only inside the process, never over the port it serves the game on.

The desktop app is also the host: starting it starts the relay, so a LAN game needs no terminal —
and it finds the other copies on your network by itself. Open **Local Area Network** on both
machines and the games appear; nobody types an address. (The address box is still there under
**Servers List**, for a machine on another subnet or one the broadcast cannot reach.)

Packaged builds:

```bash
pnpm dist:linux    # release/OpenWar3-<version>.AppImage
pnpm dist:win      # release/… .exe   (NSIS installer)
pnpm dist:mac      # release/… .dmg
```

**The AppImage does not go in your Warcraft III folder** — put it anywhere. It asks where the game
is on first run and remembers, so the two are unrelated on disk. It will only accept a 1.30.4
folder, and re-checks it every launch.

The desktop app **checks this repo's releases at launch** and asks, in the game's own message box,
whether to fetch a newer version; saying yes downloads it in the background and offers to restart
into it. Both steps are yours to refuse — nothing downloads until you say so and nothing replaces
your build until you say so again — and declining just means the offer comes back next launch.

To cut a release, tag the version in `package.json` and:

```bash
GH_TOKEN=<a token with repo scope> pnpm release
```

That builds and uploads the artifacts **plus the `latest-*.yml` beside them**, which is what the
updater actually reads — a release with the AppImage hand-uploaded and no metadata file is
invisible to it. macOS auto-update additionally needs an Apple developer signature; unsigned mac
builds install by hand.

### Playing on a LAN

Two machines on the same network, no cloud and no accounts. On the machine hosting:

```bash
pnpm dev --host
```

The other machine opens `http://<that machine's ip>:5173` and picks **Local Area Network** — games
created on either machine show up in the list. There is nothing else to start: the dev server
carries the relay on its own port, so one open port is enough. Each machine reads its own local
Warcraft III install, as always.

**Firewall.** One port, so one rule. On Windows and macOS the first launch raises the system's own
"allow incoming connections?" prompt — say yes for **private** networks. On Linux, allow it
explicitly:

```bash
sudo ufw allow 5173/tcp
```

The LAN screen warns you outright when the server is bound to this machine only (`pnpm dev`
without `--host`) — the one failure that is otherwise invisible, since the other machine just sees
an empty list. It cannot see through your firewall, though, so if nobody can reach you, that rule
is the thing to check.

**Joining a game on another machine.** Games are found through a relay's room list rather than by
broadcast, so a second machine has to be told where to look. The host's game lobby prints the
address other players type (click it to copy); the joiner adds it under **Join Server**, the icon
button above the games list, and games on every server in that list appear in their own. Either
player can create the game — whoever does runs the authoritative simulation. See
[docs/multiplayer.md](docs/multiplayer.md) for the internet deployment and for why broadcast
discovery waits on a native build.

## Legal

OpenWar3 is original code with zero copyrighted assets. Assets read from your local install, client-side, never uploaded or hosted. Engine fully open.

Licensed under the [MIT License](LICENSE).
