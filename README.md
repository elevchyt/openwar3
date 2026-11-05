# OpenWar3

<img src="public/demoscreens/game2.avif" width="800">
<img src="public/demoscreens/game1.avif" width="800">

A recreation of the **Warcraft III** engine in TypeScript. Ships **zero Blizzard assets** — it reads
your own install at runtime. **The Frozen Throne 1.30.4 is required.**

## Features

- **Cross-platform** — Windows, Linux, macOS, anything with a browser
- **Multiplayer reconnect** — no more dropped games lost
- **Computer+** — a smarter melee AI that never cheats ([how it works](docs/computer-plus.md))
- **Huge control groups** and a **select-army hotkey** (-)
- **Voice control** accessibility mode
- **Push-to-talk voice chat** in multiplayer

## Quick start

Download the desktop app from [Releases](../../releases), run it, and point it at your Warcraft III
folder. It remembers the folder and updates itself.

From source:

```bash
pnpm install
pnpm dev     # http://localhost:5173
pnpm app     # desktop app (after pnpm build)
```

LAN and online play works out of the box in the desktop app — see [docs/multiplayer.md](docs/multiplayer.md).

## Legal

Original code, no copyrighted assets. Game files are read locally and never uploaded.
Licensed under the [MIT License](LICENSE).
