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

## The installer asks for the Warcraft III folder, and installs INSIDE it

`packaging/windows-installer.nsh` is an `include` into electron-builder's assisted installer. The
directory page is relabelled to ask for the **Warcraft III folder**, pre-filled with the first
1.30.4 install it can find, and the app lands in `<Warcraft III>\OpenWar3\`. What counts as the
folder is the same rule the app asks at every launch (`electron/install.mjs` `looksLikeInstall`):
a `Data` folder and a `.build.info` whose version row says 1.30.4. `pnpm app:test` checks the
installer's `OW3_REQUIRED_VERSION` against `install.mjs` and `src/vfs/version.ts`.

Where it looks, in order — the same list `electron/locate.mjs` asks at launch:

| Where | Written by |
|---|---|
| `HKCU\Software\Blizzard Entertainment\Warcraft III` → `InstallPath` | the classic installer; the Battle.net launcher kept it |
| `HKLM\SOFTWARE\(WOW6432Node\)Blizzard Entertainment\Warcraft III` → `InstallPath` | same, machine-wide |
| `HKLM\SOFTWARE\(WOW6432Node\)Microsoft\Windows\CurrentVersion\Uninstall\Warcraft III` → `InstallLocation` | the launcher's uninstall entry |
| `Program Files (x86)\Warcraft III`, `Program Files\Warcraft III` | the launcher's default |

None of these is trusted: each candidate goes through the version check, so a stale value is just
the next row.

`perMachine` is on. Program Files needs elevation anyway, and it is what removes the
per-user/all-users page — the directory page's labels and its leave check are defined inside
`customWelcomePage`, which only reaches the directory page if nothing sits between them.

### The trap: the uninstaller removes `$INSTDIR` whole

electron-builder's uninstaller is `RMDir /r $INSTDIR`. Installing the app *into* a game folder
makes that line the one that could delete somebody's Warcraft III, so `$INSTDIR` is kept off the
game folder three times over, and each guard covers a path the others do not:

1. **After the directory page** (`ow3InstallInsideWarcraft`, an invisible custom page): the
   template only appends `\OpenWar3` when the path does not already *contain* "OpenWar3", so a
   game folder under `D:\OpenWar3 stuff\` would otherwise be installed into directly. A
   directory page's own leave function cannot fix this — `$INSTDIR` is re-read from the text box
   after it — but a later page's can.
2. **In `.onInit`** (`customInit`): a silent install (`/S /D=…`) is shown no page at all.
3. **In the uninstaller** (`customRemoveFiles`): a folder holding `.build.info` or
   `Warcraft III.exe` is never removed, whatever put it in the registry.

## The app finds the game from where it sits

On a fresh install the app never shows the folder picker. Before the window opens,
`electron/main.mjs` asks `detectInstall` whenever nothing valid is remembered, and remembers what
it finds exactly as a picked folder is remembered. The first place it looks is the executable's
own grandparent (`<Warcraft III>\OpenWar3\OpenWar3.exe`) — the installer guaranteed that is the
game — and then the registry list above through `reg.exe` (no native module, which would have to be
built for both architectures). The same "beside the app" look works for an AppImage dropped into a
game folder, where it is the AppImage FILE's folder (`APPIMAGE`) and not its mount that counts.
Nothing found means the load gate's folder picker, unchanged — it is the fallback, not replaced.

## Unsigned

The installer is not code-signed, so SmartScreen says "Windows protected your PC" on first run
(**More info → Run anyway**). Signing is a certificate purchase, not a code change: set
`CSC_LINK`/`CSC_KEY_PASSWORD` (or `win.azureSignOptions`) and electron-builder signs both the app
and the installer.
