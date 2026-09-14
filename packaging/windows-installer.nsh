; OpenWar3's Windows installer — electron-builder's ASSISTED NSIS installer (package.json
; `build.nsis`), bent in one direction: the folder it asks for is the player's Warcraft III 1.30.4
; folder, and the app is installed into an `OpenWar3` folder INSIDE it.
;
; Why inside: the desktop app then finds the game without asking (electron/locate.mjs reads its
; own executable's grandparent), and the two travel together — move or delete the Warcraft III
; folder and OpenWar3 goes with it instead of pointing at nothing. Nothing of the game's is
; written, replaced or removed; the only thing the installer adds to that folder is ours.
;
; The rule for what counts as the folder is the SAME one the app asks at the picker and at every
; launch (electron/install.mjs `looksLikeInstall`, src/vfs/version.ts): a `Data` folder and a
; `.build.info` whose version is 1.30.4. `pnpm app:test` checks the version below against both.
;
; How this file is wired in, since none of it is visible from here (app-builder-lib
; templates/nsis/assistedInstaller.nsh):
;   • it is included into the script HEADER, before common.nsh/MUI2/multiUser and before the
;     plugin directories are registered — so a Function here may only use what it includes
;     itself and no plugin, while a MACRO is expanded where the template inserts it and may use
;     everything the template has by then;
;   • the installer script is compiled TWICE, once to build the uninstaller, and a Function
;     that one of the two never calls is warning 6010, which electron-builder treats as an error;
;   • `perMachine` is on, so there is no per-user/all-users page between the welcome page and
;     the directory page — which is what lets the directory page's settings below be defined
;     inside `customWelcomePage` and still reach it. Program Files needs elevation anyway.

!define OW3_REQUIRED_VERSION "1.30.4"

!include LogicLib.nsh
!include FileFunc.nsh

!ifndef BUILD_UNINSTALLER

Var ow3Folder   ; in:  the folder to ask about
Var ow3Verdict  ; out: "ok", "missing" (not Warcraft III at all) or "version" (the wrong one)

; Is $ow3Folder a Warcraft III 1.30.4 folder? The version row of `.build.info` ends
; `|1.30.4.<build>|<complete>`, so "|1.30.4." is searched for. A line longer than NSIS's string
; limit arrives in pieces (read 1000 characters at a time, so the glued string still fits), and
; each piece is searched with the last 7 characters of the one before it in front.
Function ow3AskFolder
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $ow3Verdict "missing"
  ${If} ${FileExists} "$ow3Folder\.build.info"
  ${AndIf} ${FileExists} "$ow3Folder\Data\*.*"
    StrCpy $ow3Verdict "version"
    ClearErrors
    FileOpen $0 "$ow3Folder\.build.info" r
    ${IfNot} ${Errors}
      StrCpy $2 ""
      ${Do}
        ClearErrors
        FileRead $0 $1 1000
        ${If} ${Errors}
          ${Break}
        ${EndIf}
        StrCpy $1 "$2$1"
        ; substring search: slide an 8-character window along the line
        StrLen $3 $1
        StrCpy $4 0
        ${DoWhile} $4 < $3
          StrCpy $2 $1 8 $4
          ${If} $2 == "|${OW3_REQUIRED_VERSION}."
            StrCpy $ow3Verdict "ok"
            ${Break}
          ${EndIf}
          IntOp $4 $4 + 1
        ${Loop}
        ${If} $ow3Verdict == "ok"
          ${Break}
        ${EndIf}
        StrCpy $2 $1 "" -7
      ${Loop}
      FileClose $0
    ${EndIf}
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Try one candidate: leaves it in $ow3Folder with verdict "ok", or anything else.
!macro ow3Try path
  ${If} $ow3Verdict != "ok"
    StrCpy $ow3Folder "${path}"
    ${If} $ow3Folder != ""
      Call ow3AskFolder
    ${EndIf}
  ${EndIf}
!macroend

; Where Blizzard's installers wrote the folder down — the same list, in the same order, as
; electron/locate.mjs, which asks again at launch. Leaves $ow3Folder "" when none of them is one.
Function ow3FindWarcraft
  Push $0
  StrCpy $ow3Verdict ""
  ReadRegStr $0 HKCU "Software\Blizzard Entertainment\Warcraft III" "InstallPath"
  !insertmacro ow3Try $0
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Blizzard Entertainment\Warcraft III" "InstallPath"
  !insertmacro ow3Try $0
  ReadRegStr $0 HKLM "SOFTWARE\Blizzard Entertainment\Warcraft III" "InstallPath"
  !insertmacro ow3Try $0
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Warcraft III" "InstallLocation"
  !insertmacro ow3Try $0
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Warcraft III" "InstallLocation"
  !insertmacro ow3Try $0
  !insertmacro ow3Try "$PROGRAMFILES32\Warcraft III"
  !insertmacro ow3Try "$PROGRAMFILES64\Warcraft III"
  ${If} $ow3Verdict != "ok"
    StrCpy $ow3Folder ""
  ${EndIf}
  Pop $0
FunctionEnd

; Leaving the directory page: refuse anything that is not a 1.30.4 folder, with the reason. The
; app's own folder inside one is accepted too, which is what a reinstall over itself shows.
Function ow3DirectoryLeave
  StrCpy $ow3Folder $INSTDIR
  Call ow3AskFolder
  ${If} $ow3Verdict != "ok"
    ${GetFileName} $INSTDIR $0
    ${If} $0 == "${APP_FILENAME}"
      ${GetParent} $INSTDIR $ow3Folder
      Call ow3AskFolder
    ${EndIf}
  ${EndIf}
  ${If} $ow3Verdict == "missing"
    MessageBox MB_OK|MB_ICONEXCLAMATION "That is not a Warcraft III folder.$\r$\n$\r$\nChoose the folder Warcraft III: The Frozen Throne is installed in — the one with $\"Warcraft III.exe$\" and a $\"Data$\" folder in it."
    Abort
  ${ElseIf} $ow3Verdict == "version"
    MessageBox MB_OK|MB_ICONEXCLAMATION "That Warcraft III is not version ${OW3_REQUIRED_VERSION}.$\r$\n$\r$\nOpenWar3 reads every unit, ability and cost out of the game's own files, so it needs exactly The Frozen Throne ${OW3_REQUIRED_VERSION}."
    Abort
  ${EndIf}
FunctionEnd

; Runs after the directory page and shows nothing, so it is never seen. Its job is the one thing
; that must not be left to the template: the template appends `\OpenWar3` only when the path does
; not already CONTAIN "OpenWar3" anywhere, so a Warcraft III folder under, say, `D:\OpenWar3 stuff\`
; would be installed into directly — and the uninstaller's `RMDir /r $INSTDIR` would then take
; the game with it. Setting $INSTDIR here sticks, where the directory page's own leave does not.
Function ow3InstallInsideWarcraft
  ${If} ${FileExists} "$INSTDIR\.build.info"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
FunctionEnd

!macro customWelcomePage
  ; Skips the welcome page on an update, like every other page electron-builder shows. Defined
  ; HERE and not beside the other functions: `${isUpdated}` calls the StdUtils plugin, whose
  ; directory is only registered after this file is included.
  Function ow3SkipIfUpdated
    ${If} ${isUpdated}
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE ow3SkipIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "Welcome to OpenWar3"
  !define MUI_WELCOMEPAGE_TEXT "OpenWar3 plays out of your own copy of Warcraft III: The Frozen Throne ${OW3_REQUIRED_VERSION} and ships none of its files.$\r$\n$\r$\nOn the next page, choose your Warcraft III folder. OpenWar3 is installed into an OpenWar3 folder inside it, and nothing of the game's is changed.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME

  ; Consumed by the MUI_PAGE_DIRECTORY the template inserts next.
  !define MUI_PAGE_HEADER_TEXT "Choose your Warcraft III folder"
  !define MUI_PAGE_HEADER_SUBTEXT "OpenWar3 needs Warcraft III: The Frozen Throne ${OW3_REQUIRED_VERSION}."
  !define MUI_DIRECTORYPAGE_TEXT_TOP "Choose the folder Warcraft III is installed in — the one with $\"Warcraft III.exe$\" in it. OpenWar3 will be installed into an OpenWar3 folder inside it."
  !define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Warcraft III folder"
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE ow3DirectoryLeave
!macroend

!macro customPageAfterChangeDir
  Page custom ow3InstallInsideWarcraft
!macroend

; In .onInit, after electron-builder has set $INSTDIR (the last install's location, or /D=, or
; Program Files\OpenWar3).
!macro customInit
  ; A silent install is shown no page, so the guard above never runs: the same rule, here.
  ${If} ${FileExists} "$INSTDIR\.build.info"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}

  ; The directory page shows the WARCRAFT III folder, not ours: the previous install's parent if
  ; that is one, else the first place the game is found, else where its launcher puts it by
  ; default. The template puts `\OpenWar3` back after the page.
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    ${GetParent} $INSTDIR $ow3Folder
    Call ow3AskFolder
    ${If} $ow3Verdict == "ok"
      StrCpy $INSTDIR $ow3Folder
    ${Else}
      Call ow3FindWarcraft
      ${If} $ow3Folder != ""
        StrCpy $INSTDIR $ow3Folder
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES32\Warcraft III"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!else

; The uninstaller removes $INSTDIR whole. That is only ever our own folder — the three guards
; above see to it — but a folder that IS a Warcraft III install is refused here as well, because
; this is the one line in the installer that could destroy something that is not ours.
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
