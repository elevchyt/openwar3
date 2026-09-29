# Linux: the AppImages, and the 32-bit one

Read this before touching `electron/legacy/`, `tools/build-legacy-main.mjs`, the `linux32` scripts
in the root `package.json`, or the Electron version the 32-bit Linux build is pinned to.

## Two AppImages

| File | Arch | Electron | Updater reads |
|---|---|---|---|
| `OpenWar3-<version>.AppImage` | x86-64 | the project's (44) | `latest-linux.yml` |
| `OpenWar3-<version>-i386.AppImage` | x86 (32-bit) | **18.3.15** | `latest-linux-ia32.yml` |

`pnpm release` builds the first, `pnpm release:linux32` the second (`dist:linux32` without the
upload). They are two electron-builder runs because electron-builder has no per-arch
`electronVersion`, the same reason the Windows build carries its own `-c.electronVersion` flag
(docs/windows.md).

The updater needs nothing of its own for this. electron-builder names a non-x64 Linux update file
after its arch (`app-builder-lib` `getArchPrefixForUpdateFile`), and electron-updater asks for the
file named after the RUNNING process's arch (`Provider.getChannelFilePrefix`: `-linux` + `-ia32`
unless `x64`). So a 32-bit install reads `latest-linux-ia32.yml` and is offered the i386 AppImage,
and a 64-bit one never sees it. The one way to break this is to publish the i386 AppImage without
its yml: the 32-bit players then never hear of an update.

## Why Electron 18

Electron stopped publishing `linux-ia32` after **18.3.15**: its 19.0.0 release has `linux-x64`,
`linux-arm64` and `linux-armv7l` assets and no `linux-ia32`, and nothing since has one. So a 32-bit
AppImage is Electron 18 (Chromium 100, Node 16.13, out of support since 2022) or nothing. The page
is the same bundle either way: the renderer runs on Chromium 100 unchanged (es2022 target, nothing
it uses is newer — checked at the time this was added; a `:has()`, a `structuredClone`, an
`AbortSignal.timeout` would change that).

The MAIN process is where the gaps are, and they are filled in ONE place, in front of the shell
rather than inside it: `electron/legacy/compat.mjs`, bundled with `electron/main.mjs` behind it
into `electron/main-legacy.cjs` by `tools/build-legacy-main.mjs` (gitignored, rebuilt by the
scripts). The i386 build points `main` at that file with `-c.extraMetadata.main`.

- **An ES module main script** arrived in Electron 28 — so the bundle is CommonJS.
- **`protocol.handle`** (Electron 25), which `ow3-install://` is served through — adapted onto
  `registerStreamProtocol`.
- **`Response`, `Readable.toWeb`, `globalThis.crypto`** (Node 17–19) — the three web-ish globals
  `install.mjs` and the relay reach for.
- **Chromium 100 collects its own garbage too late.** The menu load leaves 1–1.6 GB of garbage in
  the renderer's Oilpan heap that Chromium only collects ~15 s later; a 64-bit process rides that
  out and a 32-bit one runs out of address space (three crashes out of three before the menu drew).
  The shell asks for a collection whenever the renderer has grown 400 MB since its last low point.
  Measured, allocator not found, and the numbers are in the file's own comment.

`pnpm dist:linux32` then `release/linux-ia32-unpacked/openwar3` is the build as shipped. Running it
on a 64-bit machine needs the i386 NSS/NSPR/sqlite libraries, which apt will download without
root (`apt-get download libnss3:i386 libnspr4:i386 libsqlite3-0:i386`, `dpkg -x` each, point
`LD_LIBRARY_PATH` at the result). The 64-bit Electron 18 from its GitHub release runs
`electron/main-legacy.cjs` directly and is the quicker way to test the shell itself — it is the
same Chromium, only with more address space, so it shows the garbage without dying of it.

## What is not solved

The peak is lowered, not removed: ~2.0 GB resident and ~2.7 GB mapped during the menu load on the
32-bit build. On a 64-bit kernel a 32-bit process has 4 GB of address space; on a 32-bit KERNEL
it has 3 GB, which is less headroom than we measured with. A crash on a real 32-bit machine is
most likely this, and the next lever is finding the Blink object behind the garbage (the
elimination so far is in `compat.mjs`) rather than a lower threshold.
