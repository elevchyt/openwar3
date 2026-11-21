# Windows: the installer, and where the app finds the game

Read this before touching `packaging/windows-installer.nsh`, the `win`/`nsis` blocks of the root
`package.json`, `electron/locate.mjs`, or the Electron version the Windows build is pinned to.

## One installer, two architectures

`pnpm dist:win` (and `pnpm release:win`, which also uploads) builds **one**
`OpenWar3-Setup-<version>.exe` holding a 64-bit and a 32-bit app. electron-builder packs both
archives into the installer and extracts the one the running Windows can execute, so there is no
"which download do I want" question on the landing page. It builds on Linux, with ONE Windows
program that has to run: `makensis` ships with electron-builder and the executable's icon/version
resources are edited in JavaScript (`resedit`), but the uninstaller is made by compiling a stub
installer and RUNNING it, which on Linux is `spawn wine` — without a `wine` on `PATH` the build
fails at the very end with `wine process failed ENOENT`. Any Wine does; with no root, Flathub's
works as a shim:

```sh
flatpak install --user flathub org.winehq.Wine/x86_64/stable-25.08
printf '#!/bin/sh\nexec flatpak run --user --filesystem=home org.winehq.Wine "$@"\n' > ~/bin/wine && chmod +x ~/bin/wine
```

Under Wine the installer is only good for checking PAGES and FILES, not for trusting its "is
OpenWar3 running?" check: Wine's `powershell.exe` and `findstr.exe` stubs both answer "yes", so
every install stops on "OpenWar3 is running". Run it with
`WINEDLLOVERRIDES="findstr.exe,powershell.exe=d"` to get past that. It is a Wine artifact, not a
bug in the installer.

**The Windows build runs on Electron 43, not the 44 the rest of the project uses.** Electron 44
stopped publishing `win32-ia32` binaries (electron/docs/breaking-changes.md, "Removed: Windows
32-bit (ia32) and Linux 32-bit ARM (armv7l) support"), and 43 is the last line that has them — it
is supported until January 2027. The pin is `-c.electronVersion=43.7.0` in the two `win` scripts,
because electron-builder has no per-platform `electronVersion`. When 43 reaches end of life the
choice is to drop 32-bit (take the flag out and the `ia32` arch with it) or to stay on 43; the
renderer bundle is the same either way.

A 32-bit renderer cannot have the 4 GiB V8 heap the 64-bit one is given, so `electron/main.mjs`
states 1536 MiB for `ia32` instead.

## The installer takes a folder of its own

`packaging/windows-installer.nsh` is an `include` into electron-builder's assisted installer. It
adds a welcome page and one uninstaller guard, and nothing else: the directory page is
electron-builder's own, pre-filled with `Program Files\OpenWar3` (or the last install's folder on
a reinstall), and the installer never asks whether Warcraft III is there.

It used to. The directory page was relabelled to ask for the **Warcraft III folder**, refused
anything that was not a 1.30.4 install, and put the app in `<Warcraft III>\OpenWar3\`. That
locked out every player without a copy of the game — exactly the player the load gate's
"Download game files" is for — and bought nothing the app does not already do itself: the game is
found or picked at FIRST LAUNCH (next section), so the installer has no reason to know where it
is. The welcome page still names the version (`OW3_REQUIRED_VERSION`, which `pnpm app:test`
checks against `electron/install.mjs` and `src/vfs/version.ts`).

`perMachine` is on: an install from before this change is machine-wide, and an update has to find
it where it is (electron-builder reads `InstallLocation` from HKLM), which also means an old
`<Warcraft III>\OpenWar3\` install keeps updating in place.

### The trap: the uninstaller removes `$INSTDIR` whole

electron-builder's uninstaller is `RMDir /r $INSTDIR`. The template appends `\OpenWar3` to a
chosen folder only when the path does not already *contain* "OpenWar3", so a Warcraft III folder
under `D:\OpenWar3 stuff\` could be installed into directly, and older installs sit inside a game
folder by design. `customRemoveFiles` therefore never removes a folder holding `.build.info` or
`Warcraft III.exe`, whatever put it in the registry — keep it.

## The app finds the game at first launch

The app never shows the folder picker when it can find the game. Before the window opens,
`electron/main.mjs` asks `detectInstall` whenever nothing valid is remembered, and remembers what
it finds exactly as a picked folder is remembered. The first place it looks is the executable's
own grandparent (`<Warcraft III>\OpenWar3\OpenWar3.exe` — where the old installer put the app,
and where a player may still choose to), then the registry list below through `reg.exe` (no native
module, which would have to be built for both architectures), then the launcher's default
folders. The same "beside the app" look works for an AppImage dropped into a game folder, where it
is the AppImage FILE's folder (`APPIMAGE`) and not its mount that counts. Nothing found means the
load gate's folder picker (and its "Download game files"), unchanged.

| Where | Written by |
|---|---|
| `HKCU\Software\Blizzard Entertainment\Warcraft III` → `InstallPath` | the classic installer; the Battle.net launcher kept it |
| `HKLM\SOFTWARE\(WOW6432Node\)Blizzard Entertainment\Warcraft III` → `InstallPath` | same, machine-wide |
| `HKLM\SOFTWARE\(WOW6432Node\)Microsoft\Windows\CurrentVersion\Uninstall\Warcraft III` → `InstallLocation` | the launcher's uninstall entry |
| `Program Files (x86)\Warcraft III`, `Program Files\Warcraft III` | the launcher's default |

None of these is trusted: each candidate goes through the same 1.30.4 check the picker asks
(`electron/install.mjs` `looksLikeInstall`), so a stale value is just the next row.

## Unsigned

The installer is not code-signed, so SmartScreen says "Windows protected your PC" on first run
(**More info → Run anyway**). Signing is a certificate purchase, not a code change: set
`CSC_LINK`/`CSC_KEY_PASSWORD` (or `win.azureSignOptions`) and electron-builder signs both the app
and the installer.
