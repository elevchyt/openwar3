; OpenWar3's Windows installer — electron-builder's ASSISTED NSIS installer (package.json
; `build.nsis`), with a welcome page of our own and one guard in the uninstaller.
;
; The installer does NOT ask for the Warcraft III folder. It installs into a folder of its own
; (`Program Files\OpenWar3` by default, or wherever the player points the directory page), and the
; game is found by the app itself on first launch: electron/locate.mjs looks where Blizzard's
; installers wrote it down, and the load gate's folder picker (src/ui/gate.ts) asks for anything it
; cannot find — or offers "Download game files" to a player who has no copy. An installer that
; refused to go on without a 1.30.4 folder locked exactly that player out (docs/windows.md).
;
; How this file is wired in, since none of it is visible from here (app-builder-lib
; templates/nsis/assistedInstaller.nsh):
;   • it is included into the script HEADER, before common.nsh/MUI2/multiUser and before the
;     plugin directories are registered — so a MACRO is expanded where the template inserts it and
;     may use everything the template has by then, while a top-level Function may use no plugin;
;   • the installer script is compiled TWICE, once to build the uninstaller, and a Function
;     that one of the two never calls is warning 6010, which electron-builder treats as an error.

; Stated to the player on the welcome page; `pnpm app:test` checks it against the version the
; app itself asks for (electron/install.mjs, src/vfs/version.ts).
!define OW3_REQUIRED_VERSION "1.30.4"

!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER

!macro customWelcomePage
  ; Skips the welcome page on an update, like every other page electron-builder shows. Defined
  ; HERE and not at the top level: `${isUpdated}` calls the StdUtils plugin, whose directory is
  ; only registered after this file is included.
  Function ow3SkipIfUpdated
    ${If} ${isUpdated}
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE ow3SkipIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "Welcome to OpenWar3"
  !define MUI_WELCOMEPAGE_TEXT "OpenWar3 plays out of your own copy of Warcraft III: The Frozen Throne ${OW3_REQUIRED_VERSION} and ships none of its files.$\r$\n$\r$\nYou do not need it to install OpenWar3: the first time OpenWar3 starts, it looks for the game and asks you for its folder if it cannot find it.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!else

; The uninstaller removes $INSTDIR whole (`RMDir /r`). An older installer put the app INSIDE the
; Warcraft III folder, and the directory page still lets a player point anywhere, so a folder that
; IS a Warcraft III install is refused here: this is the one line in the installer that could
; destroy something that is not ours.
!macro customRemoveFiles
  ${If} ${FileExists} "$INSTDIR\.build.info"
  ${OrIf} ${FileExists} "$INSTDIR\Warcraft III.exe"
    DetailPrint "Not removing $INSTDIR: it is a Warcraft III folder, not OpenWar3's."
  ${Else}
    ; electron-builder's own removal, unchanged (templates/nsis/uninstaller.nsh).
    ${if} ${isUpdated}
      CreateDirectory "$PLUGINSDIR\old-install"

      Push ""
      Call un.atomicRMDir
      Pop $R0

      ${if} $R0 != 0
        DetailPrint "File is busy, aborting: $R0"

        Push ""
        Call un.restoreFiles
        Pop $R0

        Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
      ${endif}
    ${endif}

    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${EndIf}
!macroend

!endif
