# Reverse-engineering source: "Reverse Engineer Game.dll" (Hive Workshop thread 268718)

> **Source:** https://www.hiveworkshop.com/threads/reverse-engineer-game-dll.268718/ (3 pages)
> **Scraped:** 2026-07-03 (hiveworkshop 403s plain fetchers — pulled with a browser User-Agent; see `docs/REFERENCES.md`).
> **Why it's here:** the user asked us to archive this thread locally, **especially the posts by "A Void"**, as a
> reference for making OpenWar3 behave like the real engine. A Void extracted the C++ **source-file strings** and the
> **`Game.pdb` internal source tree** out of `Game.dll`, which exposes Blizzard's real class names and module layout.

## Why this matters for OpenWar3

The single most useful artifact here is A Void's **post 1**: a dump of the literal strings compiled into `Game.dll`.
Two things fall out of it that we can build against:

1. **The engine's real class/file names** (from `.cpp`/`.h` strings). These are the ground-truth names for the
   subsystems we are re-creating — match them when naming our own modules so the mapping stays obvious:
   - Gameplay objects: `CWidget.cpp`, `CUnit`, `CItem.cpp`, `CDestructable.cpp`, `CAbilityAttack.cpp`,
     `CAbilityMove.cpp`, `NetUnit.cpp`, `CCaptainAI.cpp`.
   - Engine/UI + config: `Engine.cpp`, `CGameUI.cpp`, `CMiscCustom.cpp`, `CPreferencesWar3.cpp`.
   - UI framework (from the `Game.pdb` tree): `engine\source\frame\` (`CHighlightFrame`, `CEditBox`,
     `CSimpleMessageFrame`), `engine\source\framedef\IFrameDef.h`, `engine\source\fdfile\FDFile.h` +
     `MenuHashNode.h` — i.e. the **FDF/TOC frame system** that drives the console/HUD. `engine\source\gxu\IGxuFont.h`
     is the font subsystem.
   - Menus ("glue"): `war3\source\glue\` — `CSinglePlayerMenu`, `CSkirmish`, `CCampaignMenu`, `CMinimapImage`,
     the `CBattleNet*` panels, `CViewReplayScreen`, `CLoadSavedGameScreen`.
   - World Editor object data: `war3\source\worldedit\` — `WECustomObjectData`, `CCustomObjectData`.

2. **Confirmation of the data-file and asset names the engine reads** — cross-check our data layer against these:
   `Units\MiscData.txt`, `Units\MiscGame.txt`, the per-race `*UnitFunc/Strings`, `*AbilityFunc/Strings`,
   `*UpgradeFunc/Strings` tables, `Units\ItemFunc.txt`/`ItemStrings.txt`, `Units\CommandFunc.txt`/`CommandStrings.txt`,
   `CustomKeys.txt`, plus `common.j`/`common.ai`, the `%o.w3u/.w3t/.w3a/.w3h/.w3q/.w3b/.w3d` object-data extensions,
   and UI art like `ReplaceableTextures\Selection\SpellAreaOfEffect.blp` and `ReplaceableTextures\CommandButtons\BTNTemp.blp`.

> ⚠️ **Legal / usage boundary (echoed by A Void and Dr Super Good in-thread):** modifying or redistributing `Game.dll`
> is against Blizzard's EULA. OpenWar3 does **not** use, ship, or derive from Blizzard binaries. We treat these strings
> as *documentation of behaviour and naming* only — a map of what to build cleanly ourselves — never as code to lift.

## Thread technical summary (all participants)

- **Premise (aple, edo494):** `Game.dll` (~11 MB) holds the bulk of gameplay: the UI, unit selection, the
  hero/building/item/widget type classification, and spell/trigger execution (plus the no-CD patch). Rewriting a
  drop-in `Game.dll` from scratch was judged **infeasible** — most of the DLL is code, and a replacement must keep the
  exported function names or the game fails to start / null-derefs. Disassembly yields compilable-but-garbage-named C/C++.
- **Language:** confirmed **C++** (A Void, DracoL1ch) — consistent with the `.cpp` strings.
- **What people actually do instead — injection, not replacement:** the working approach (ENAleksey's *RenderEdge*,
  and the older *SharpCraft* / *Reinventing the Craft*) is a **custom .exe that injects a library** into WC3 via
  **EasyHook**, hooks Direct3D, and draws a **new UI on top of** the original (the old UI can't be removed/edited;
  black bars are stripped via ZUKMAN's render hack). Trade-offs noted: **breaks official multiplayer** and costs
  performance on old machines; WC3 is largely single-threaded (DracoL1ch).
- **Extensibility that RenderEdge added (ENAleksey)** — useful as a menu of behaviours players expect:
  - Custom JASS **input natives**: `GetMouseX/Y`, `GetMouseTerrainX/Y/Z`, `IsMouseOverUI`, `GetWheelDelta`,
    `SetMousePos`, and `TriggerRegisterMouseWheelEvent` / `TriggerRegisterMouseMoveEvent`.
  - A **custom GUI control system** with natives like `CtrlSetText`, `CtrlSetDepth`, `CtrlSetColor`, `CtrlSetAngle`
    (controls can be skinned with `.blp` textures).
- **Notable participants:** GhostWolf (author of *mdx-m3-viewer*, our rendering base), TriggerHappy, 0x41414141,
  DracoL1ch, Dr Super Good — i.e. the same RE community our other references come from.

---

## A Void — full posts (verbatim, quote boilerplate trimmed)

### A Void — post 1 (page 1) — extracted Game.dll strings

I'm not sure if it helps, but I have Warcraft 3 source code strings extracted from Game.dll. I will copy and paste them here.

<details>
<summary>Full extracted string dump (paths, .cpp/.h names, asset references, Game.pdb source tree)</summary>

```text
Warcraft 3 was coded in C++ based on the frequent .cpp files in the source code.

		Game.dll

.RoE.Ro

Race.mpq

tx.mpq

War3X_med.mpq

War3_med.mpq

War3X_low.mpq

War3_low.mpq

War3XLocal.mpq

War3X.mpq

War3.mpq

War3Patch.mpq

oSkin.txt

.\CMiscCustom.cpp

o.\CPreferencesWar3.cpp

ui\startupstrings.txt

8LoFramedefErrors.log

UI\war3skins.txt

UI\FrameDef\FrameDef.toc

.\Engine.cpp

config.txt

war3mapMap.tga

war3mapMap.blp

Units\MiscGame.txt

UI\SoundInfo\MiscData.txt

UI\MiscUI.txt

UI\MiscData.txt

Units\MiscData.txt

advapi32.dll

%c.mpq

Path.tga

ReplaceableTextures\Selection\SpellAreaOfEffect.blp

25.0

.\CAbilityAttack.cpp

 o.\CAbilityMove.cpp

%o.w3u

%o.w3t

%o.w3a

%o.w3h

%o.w3q

%o.w3b

2oo.w3d

%s%s%s.mdl

o.\CDestructable.cpp

%s_portrait.mdx

%s.mdx

.\CWidget.cpp

o.\CItem.cpp

.\NetUnit.cpp

ocommon.ai

common.j

op(.o

x.o.\CCaptainAI.cpp

units\critters\VillagerKid\VillagerKid.mdl

sound\interface\mouseclick2.wav

sound\interface\mouseclick1.wav

.\CGameUI.cpp

CustomKeys.txt

Units\ItemFunc.txt

Units\CommandFunc.txt

Units\Telemetry.txt

Units\ItemStrings.txt

Units\CommandStrings.txt

Units\NeutralUpgradeFunc.txt

Units\UndeadUpgradeFunc.txt

Units\OrcUpgradeFunc.txt

Units\NightElfUpgradeFunc.txt

Units\HumanUpgradeFunc.txt

Units\CampaignUpgradeFunc.txt

Units\NeutralUpgradeStrings.txt

Units\UndeadUpgradeStrings.txt

Units\OrcUpgradeStrings.txt

Units\NightElfUpgradeStrings.txt

Units\HumanUpgradeStrings.txt

Units\CampaignUpgradeStrings.txt

Units\ItemAbilityFunc.txt

Units\UndeadAbilityFunc.txt

Units\OrcAbilityFunc.txt

Units\NightElfAbilityFunc.txt

Units\NeutralAbilityFunc.txt

Units\HumanAbilityFunc.txt

Units\CommonAbilityFunc.txt

Units\CampaignAbilityFunc.txt

Units\ItemAbilityStrings.txt

Units\UndeadAbilityStrings.txt

Units\OrcAbilityStrings.txt

Units\NightElfAbilityStrings.txt

Units\NeutralAbilityStrings.txt

Units\HumanAbilityStrings.txt

Units\CommonAbilityStrings.txt

Units\CampaignAbilityStrings.txt

Units\UndeadUnitFunc.txt

Units\OrcUnitFunc.txt

Units\NightElfUnitFunc.txt

Units\NeutralUnitFunc.txt

Units\HumanUnitFunc.txt

Units\CampaignUnitFunc.txt

Units\UnitGlobalStrings.txt

Units\UndeadUnitStrings.txt

Units\OrcUnitStrings.txt

Units\NightElfUnitStrings.txt

Units\NeutralUnitStrings.txt

Units\HumanUnitStrings.txt

Units\CampaignUnitStrings.txt

oabilities\weapons\spear\spearmissile.mdl

Abilities\Spells\Other\TempSpellArt\TempSpellArt.mdl

ReplaceableTextures\CommandButtons\BTNTemp.blp

ReplaceableTextures\Selection\SpellAreaOfEffect.blp

SoundManagerLog.txt

 %-4.1f

%5.2f

4oUI\TipStrings.txt

%s%s.w3z

UI\HelpStrings.txt

ui\widgets\escmenu\human\observer-icon.blp

Sound\Music\mp3Music\PH1.mp3

.\CMultiBoard.cpp

Environment\DNC\DNCLordaeron\DNCLordaeronTerrain\DNCLordaeronTerrain.mdl

Environment\DNC\DNCLordaeron\DNCLordaeronUnit\DNCLordaeronUnit.mdl

.\CWorldFrameWar3.cpp

9o.\CBuildMode.cpp

o.\CBuildFrame.cpp

.\CGameWar3.cpp

maps\campaign\War3XBonusCredits.w3x

maps\campaign\War3XRegularCreditsIce.w3x

maps\campaign\BonusCredits.w3m

maps\campaign\WarcraftIIICredits.w3m

blizzard.j

scripts\common.j

o0.03

Campaigns.w3v

o%s\Campaigns.w3p

.\CFogOfWarMap.cpp

VAo.\CPlayerWar3.cpp

selection.log

.\CSelectionWar3.cpp

o.\CGameState.cpp

ZEo.\Jass.cpp

Nodes.h

.\Compile.cpp

Eo.\Instance.cpp

.\scanner.cpp

.\parser.cpp

Fo.\Agile.cpp

 %4.2f

 %4.2f

Go.\CAgent.cpp

Go.\Integer.cpp

o0AGo.\Position.cpp

.\FloatProp.cpp

.\AgentRef.cpp

Ho.\CAgentBase.cpp

Ho.\ipse_thread.cpp

256.0

16.0

10.0

-128000.0

.\cproximitymap.cpp

.\agent_.cpp

.\cmemblock.cpp

.\FileCache.cpp

\%s%08x.pre

.\CDataAllocator.cpp

.\Prop.cpp

.\Status.cpp

ZLo0ULo.\RCString.cpp

fLo.\CDataRecycler.cpp

fLo.\CDataStoreChunked.cpp

o.\Database.cpp

Lo.db

.\SysMessage.cpp

.\TextBlock.cpp

.\Profile.cpp

.\Sprite.cpp

.\Lightning.cpp

.\Texture.cpp

_mip%d.tga

8No 8No.\GfxSingletonManager.cpp

No.\Tokenizer.cpp

No.\SprAnimList.cpp

No.\SprLinkTable.cpp

Po.\ModelCreate.cpp

Doodads\Cinematic\ArthasIllidanFight\ArthasCape%s.mrf

.\WorldMatrix.cpp

.\MdlAnim.cpp

.\Interp.cpp

B.\CGxDevice\CGxDevice.cpp

Ro.\CGxDeviceD3d\CGxDeviceD3d.cpp

BlizzardCursor.cur

WAR3.ICO

WAR3X.ICO

Ro.\CGxDeviceOpenGL\CGxDeviceOpenGl.cpp

.\GxMovie\GxVideo.cpp

d3d8.dll

.\CGxDeviceD3d\CGxD3dScene.cpp

So.\CGxDeviceD3d\CGxD3dPrim.cpp

%d.%d

.\CGxDeviceOpenGL\CGxOglTexture.cpp

.\CGxDeviceOpenGL\CGxOglScene.cpp

.\CGxDeviceOpenGL\CGxOglPrim.cpp

.\NetGameStore.cpp

Replay\LastReplay.w3g

TempReplay.w3g

Battle.net

font\font.ccd

font\font.clh

font\font.exp

font\font.gid

UI\Widgets\BattleNet\chaticons\iconselection-border-disabled.blp

UI\Widgets\BattleNet\chaticons\iconselection-border-hilight.blp

UI\Widgets\BattleNet\chaticons\iconselection-border-active.blp

UI\Widgets\Glues\Minimap-Unknown.blp

ui\widgets\glues\icon-folder-up.blp

ui\widgets\glues\icon-folder.blp

ui\widgets\glues\icon-file.blp

ui\widgets\glues\icon-file-ums.blp

ui\widgets\glues\icon-file-melee.blp

ui\widgets\glues\dialogbox-question.blp

ui\widgets\glues\dialogbox-error.blp

ui\widgets\glues\dialogbox-message.blp

UI\Widgets\BattleNet\friends-nonmutual.blp

UI\Widgets\BattleNet\friends-mutual.blp

UI\Widgets\BattleNet\friends-privategame.blp

UI\Widgets\BattleNet\friends-publicgame.blp

UI\Widgets\BattleNet\friends-chatroom.blp

UI\Widgets\BattleNet\friends-online.blp

UI\Widgets\BattleNet\friends-offline.blp

UI\Widgets\BattleNet\chaticons\clan-orc-initiate.blp

UI\Widgets\BattleNet\chaticons\clan-orc-leader.blp

UI\Widgets\BattleNet\chaticons\clan-orc-officer.blp

UI\Widgets\BattleNet\chaticons\clan-orc-member.blp

UI\Widgets\BattleNet\bnet-userlist-back.blp

UI\Widgets\BattleNet\bnet-userlist-mod-back.blp

UI\widgets\BattleNet\bnet-tooltip-background.blp

UI\widgets\BattleNet\bnet-tooltip-border.blp

UI\Widgets\Glues\ThumbsDown-Disabled.blp

UI\Widgets\Glues\ThumbsDown-Down.blp

UI\Widgets\Glues\ThumbsDown-Up.blp

UI\Widgets\Glues\ThumbsUp-Disabled.blp

UI\Widgets\Glues\ThumbsUp-Down.blp

UI\Widgets\Glues\ThumbsUp-Up.blp

UI\Widgets\BattleNet\chaticons\tier1-orc.blp

UI\Widgets\Glues\GlueScreen-Checkbox-CheckDisabled.blp

UI\Widgets\Glues\GlueScreen-Checkbox-Check.blp

UI\Widgets\Glues\GlueScreen-Checkbox-BackgroundDisabled.blp

UI\Widgets\Glues\GlueScreen-Checkbox-BackgroundPressed.blp

UI\Widgets\Glues\GlueScreen-Checkbox-Background.blp

ui\widgets\glues\Icon-Map-AuthentificationFail.blp

ui\widgets\glues\Icon-Map-Unknown.blp

ui\widgets\glues\Icon-Map-Blizzard.blp

ui\widgets\glues\Icon-Map-Authenticated.blp

ui\widgets\battlenet\chaticons\bnet-unknown.blp

%s%s%s%s.w3g

%s\%s_%s.w3g

units\orc\peon\peon_portrait.mdl

%s.mdl

%s_portrait.mdl

Maps\Test\OrcVsOrc.w3m

%d.%d.%d.%d

War3Patch_med.mpq

War3Patch_low.mpq

Frozen Throne.exe

Warcraft III.exe

UI\Glues\ScoreScreen\scorescreen-silverbannerborder.blp

UI\Glues\ScoreScreen\scorescreen-goldbannerborder.blp

UI\Glues\ScoreScreen\scorescreen-hero-archmage.blp

UI\Glues\ScoreScreen\ScoreScreen-BottomBar\ScoreScreen-BottomBar.mdl

UI\Glues\ScoreScreen\ScoreScreen-CenterBar\ScoreScreen-CenterBar.mdl

YoUI\Glues\BattleNet\PlaceholderAd\WelcomeToBattleNet.png

UI\Widgets\BattleNet\bnet-tab-up.blp

UI\Widgets\BattleNet\bnet-tab-down.blp

BattleNet\bnserver-WAR3.ini

ui\widgets\battlenet\chaticons\iconindex_bel.txt

%sMovies\%s.mpq

UI\Captions\%s.txt

.\FrameDef.cpp

.\SetupFrame.cpp

.\FDFile.cpp

.\Handlers\FrameHandlers.cpp

o.\Handlers\EditBoxHandlers.cpp

o.\IFDFile.cpp

o.\Handlers\MenuHashNode.cpp

7_o.\Handlers\HighlightFrameHashNode.cpp

g_o.\Handlers\BackdropFrameHandlers.cpp

.\Handlers\TextFrameHandlers.cpp

_o.\CLayer.cpp

.\CControl.cpp

o.\CSimpleButton.cpp

.\CSimpleMessageFrame.cpp

0o.\CFrame.cpp

o.\CSimpleFrame.cpp

.\CScreenFrame.cpp

oFRIZQT__.TTF

3o.\CDialog.cpp

o.\CSimpleTop.cpp

o.\CSimpleRender.cpp

o%s.blp

o.\CSimpleStatusBar.cpp

o.\CSpriteFrame.cpp

.\CCheckBox.cpp

ao.\CMenu.cpp

3.\CTextFrame.cpp

o.\CPopupMenu.cpp

.\CEditBox.cpp

laoplao.\CControlSet.cpp

.\CBackdropGenerator.cpp

.\CTextArea.cpp

ao l3o.\CTextButtonFrame.cpp

ao.\CSlider.cpp

o.\CSimpleCheckbox.cpp

bo.\CModelFrame.cpp

bo l3o.\CButtonFrame.cpp

.\CMessageFrame.cpp

o.\CHighlightFrame.cpp

Pbo.\CScrollBar.cpp

mbo.\CListBox.cpp

.\CChatDisplay.cpp

bo.\CFramePoint.cpp

bo.\CInputObserver.cpp

.\EvtSched.cpp

fLo.\EvtTimer.cpp

.\NetProvider.cpp

.\NetProviderBNET.cpp

.\NetProviderLOOP.cpp

.\NetProviderLTCP.cpp

eo.\NetCommon.cpp

fo.\NetRouter.cpp

go.\NetClient.cpp

bncache.dat

.\BattleNetCache.cpp

.\BattleNetChat.cpp

ko.\W32\OsGui.cpp

ko.\W32\OsBattleNet.cpp

%s\bnupdate.exe

Prepatch.lst

kernel32.dll

.\W32\Time.cpp

o.\W32\OsSnd.cpp

VORT_DLS.DLL

S3BASE.DLL

GenuineIntelAuthenticAMDCyrixInsteadCentaurHalls.\W32\OSSystem.cpp

8BLZ2112.HTM

.\W32\OsLock.cpp

OsNetLog.txt

o.\W32\OsTcp.cpp

ws2_32.dll

mswsock.dll

Wno.\W32\OsClipboard.cpp

.\W32\OsCall.cpp

calldump.log

.\W32\OsISndCache.cpp

.\SHA.cpp

Maiev.mod

.\WardenClient.cpp

3ooMisc.txt

%%.%df

UI\TriggerStrings.txt

UI\TriggerData.txt

UI\WorldEditLayout.txt

UI\AIEditorData.txt

UI\UnitEditorData.txt

UI\WorldEditGameStrings.txt

UI\WorldEditStrings.txt

UI\WorldEditData.txt

UI\WorldEditStartupStrings.txt

2soPreview.tga

Map.tga

War3.exe

WEUTiming.txt

TerrainMemory.txt

 setting to 1.0

 %.0f)

xo.\blp.cpp

%s%s\%s.tga

.\CONSOLE.CPP

o.\tga.cpp

.\funcs.cpp

o.\GxuLight.cpp

.\GxuFont.cpp

C%2.2x%2.2x%2.2x%2.2x

.\GxuFontUtil.cpp

.\IGxuFontGlyph.cpp

001.003

001.002

001.001

001.000

5.\MsgBuffer.cpp

.\Param.cpp

o.\AsyncFile.cpp

COMCTL32.dll

WINMM.dll

KERNEL32.dll

comdlg32.dll

ADVAPI32.dll

WININET.dll

Storm.dll

ijl15.dll

MSVCR80.dll

WSOCK32.dll

mss32.dll

OPENGL32.dll

IMM32.dll

USER32.dll

GDI32.dll

SHELL32.dll

ole32.dll

Game.dll

757G7.8

Race.mpq

		Game.dll wDrive

e:\drive1\temp\buildwar3x\war3\source\Data.h

e:\Drive1\temp\buildwar3x\Storm\H\stpl.h

e:\drive1\temp\buildwar3x\war3\source\world\WorldCampaign.cpp

e:\drive1\temp\buildwar3x\war3\source\world\WorldLoad.cpp

e:\drive1\temp\buildwar3x\war3\source\unit\CAbilityMassTeleport.cpp

e:\drive1\temp\buildwar3x\engine\source\agile\FloatModifier.h

e:\drive1\temp\buildwar3x\engine\source\agile\IntegerListener.h

e:\drive1\temp\buildwar3x\engine\source\agile\PositionListener.h

e:\drive1\temp\buildwar3x\engine\source\agile\FloatListener.h

e:\drive1\temp\buildwar3x\war3\source\unit\CAbilityEvasion.cpp

e:\drive1\temp\buildwar3x\war3\source\unit\CAbilityCouple.cpp

e:\drive1\temp\buildwar3x\war3\source\unit\CAbilityCriticalStrike.cpp

e:\drive1\temp\buildwar3x\war3\source\unit\CAbilitySilence.cpp

e:\drive1\temp\buildwar3x\war3\source\unit\CUnitDatabase.cpp

e:\drive1\temp\buildwar3x\war3\source\unit\CCustomData.cpp

e:\drive1\temp\buildwar3x\war3\source\unit\CUnit_Visibility.cpp

e:\drive1\temp\buildwar3x\war3\source\unit\CUnitUI.cpp

e:\drive1\temp\buildwar3x\engine\source\agile\MovementRequest.h

e:\drive1\temp\buildwar3x\war3\source\unit\CUnit_Enum.cpp

e:\drive1\temp\buildwar3x\war3\source\unit\CUnit_Vision.cpp

e:\drive1\temp\buildwar3x\war3\source\unit\CUnit_Ownership.cpp

e:\drive1\temp\buildwar3x\war3\source\unit\CMissile.cpp

e:\drive1\temp\buildwar3x\engine\source\base\CDataStore.h

e:\drive1\temp\buildwar3x\war3\source\ui\CTimerDialog.h

e:\drive1\temp\buildwar3x\war3\source\ui\CScriptDialog.h

e:\drive1\temp\buildwar3x\war3\source\ui\CChatDialog.h

e:\drive1\temp\buildwar3x\war3\source\ui\CLogDialog.h

e:\drive1\temp\buildwar3x\war3\source\ui\CAllianceSlot.h

e:\drive1\temp\buildwar3x\war3\source\ui\CAllianceDialog.h

e:\drive1\temp\buildwar3x\war3\source\ui\CResourceBar.h

e:\drive1\temp\buildwar3x\war3\source\ui\CHeroLevelBar.h

e:\drive1\temp\buildwar3x\war3\source\ui\CBuildTimeIndicator.h

e:\drive1\temp\buildwar3x\war3\source\ui\CInfoPanelBuildingDetail.h

e:\drive1\temp\buildwar3x\war3\source\ui\CInfoPanelUnitDetail.h

e:\drive1\temp\buildwar3x\war3\source\ui\CInfoPanelItemDetail.h

e:\drive1\temp\buildwar3x\war3\source\ui\CInfoPanelDestructableDetail.h

e:\drive1\temp\buildwar3x\war3\source\ui\CReplayPanel.h

e:\drive1\temp\buildwar3x\war3\source\ui\CGameResultDialog.h

e:\drive1\temp\buildwar3x\war3\source\ui\CEscMenuMainPanel.h

e:\drive1\temp\buildwar3x\war3\source\ui\CEscMenuOptionsPanel.h

e:\drive1\temp\buildwar3x\war3\source\ui\CGameSaveSplashDialog.h

e:\drive1\temp\buildwar3x\war3\source\ui\CEscMenuSaveGamePanel.h

e:\drive1\temp\buildwar3x\war3\source\ui\CSuspendDialog.h

e:\drive1\temp\buildwar3x\war3\source\ui\CUnresponsiveDialog.h

e:\drive1\temp\buildwar3x\war3\source\ui\CUpperButtonBar.h

e:\drive1\temp\buildwar3x\war3\source\ui\CChatEditBar.h

e:\drive1\temp\buildwar3x\war3\source\ui\CSimpleConsole.h

e:\drive1\temp\buildwar3x\war3\source\ui\CQuestDialog.h

e:\drive1\temp\buildwar3x\war3\source\ui\CCinematicPanel.h

e:\drive1\temp\buildwar3x\war3\source\ui\CQuestLists.h

e:\drive1\temp\buildwar3x\war3\source\ui\CLeaderboard.h

e:\drive1\temp\buildwar3x\war3\source\ui\CMultiboard.h

e:\drive1\temp\buildwar3x\engine\source\agile\PositionModifier.h

e:\Drive1\temp\buildwar3x\Storm\H\SAPIEXTEND.H

e:\drive1\temp\buildwar3x\war3\source\ui\CSkinManager.h

e:\drive1\temp\buildwar3x\war3\source\ui\CSoundManagerI.h

e:\drive1\temp\buildwar3x\war3\source\game\HashKeyStripacked.h

e:\Drive1\temp\buildwar3x\War3\Source\CAgentWar3.h

e:\drive1\temp\buildwar3x\war3\source\game\CFogMaskTable.h

e:\drive1\temp\buildwar3x\engine\source\jass2\Nodes.h

e:\drive1\temp\buildwar3x\engine\source\jass2\Instance.h

e:\drive1\temp\buildwar3x\engine\source\jass2\Compile.h

e:\drive1\temp\buildwar3x\engine\source\agile\CAgent.h

e:\Drive1\temp\buildwar3x\Storm\H\SAPIExtend.h

e:\drive1\temp\buildwar3x\engine\source\base\Status.h

e:\drive1\temp\buildwar3x\engine\source\anim\Interp.h

e:\drive1\temp\buildwar3x\war3\source\glue\CDialogWar3.h

e:\drive1\temp\buildwar3x\war3\source\glue\CListBoxWar3.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetUserListBox.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetNewsBox.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetFriendsListBox.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetClanMateListBox.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetStatusBox.h

e:\drive1\temp\buildwar3x\war3\source\glue\CCheckListBox.h

e:\drive1\temp\buildwar3x\war3\source\glue\CMapList.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetIconSelectBox.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetProfileListBox.h

e:\drive1\temp\buildwar3x\war3\source\glue\CMapPreferenceBox.h

e:\drive1\temp\buildwar3x\war3\source\glue\CCampaignListBox.h

e:\drive1\temp\buildwar3x\war3\source\glue\CPlayerSlot.h

e:\drive1\temp\buildwar3x\war3\source\glue\CTeamSetup.h

e:\drive1\temp\buildwar3x\war3\source\glue\COptionsMenu.h

e:\drive1\temp\buildwar3x\war3\source\glue\CAdvancedOptionsDisplay.h

e:\drive1\temp\buildwar3x\war3\source\glue\CAdvancedOptionsPane.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetChatroom.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetChatActionMenu.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetTeamInvitation.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetClanPane.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetClanInvitation.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetChatPanel.h

e:\drive1\temp\buildwar3x\war3\source\glue\CMapInfoPane.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetCustomJoinPanel.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetMain.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetProfilePanel.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetTeamPanel.h

e:\drive1\temp\buildwar3x\war3\source\glue\CGameChatroom.h

e:\drive1\temp\buildwar3x\war3\source\glue\CTitle.h

e:\drive1\temp\buildwar3x\war3\source\glue\CLoading.h

e:\drive1\temp\buildwar3x\war3\source\glue\CMainMenu.h

e:\drive1\temp\buildwar3x\war3\source\glue\CLocalMultiplayerJoin.h

e:\drive1\temp\buildwar3x\war3\source\glue\CLocalMultiplayerCreate.h

e:\drive1\temp\buildwar3x\war3\source\glue\CScoreScreen.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetCustomCreatePanel.h

e:\drive1\temp\buildwar3x\war3\source\glue\CCampaignMenu.h

e:\drive1\temp\buildwar3x\war3\source\glue\CSinglePlayerMenu.h

e:\drive1\temp\buildwar3x\war3\source\glue\CViewReplayScreen.h

e:\drive1\temp\buildwar3x\war3\source\glue\CLoadSavedGameScreen.h

e:\drive1\temp\buildwar3x\war3\source\glue\CSkirmish.h

e:\drive1\temp\buildwar3x\war3\source\glue\CAdBanner.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetScheduledGame.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetCustomLoadPanel.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetStandardPanel.h

e:\drive1\temp\buildwar3x\war3\source\glue\CMinimapImage.h

e:\drive1\temp\buildwar3x\war3\source\glue\CLocalMultiplayerLoad.h

e:\drive1\temp\buildwar3x\war3\source\glue\CBattleNetFriendsPane.h

e:\drive1\temp\buildwar3x\war3\source\glue\CCustomCampaignMenu.h

e:\drive1\temp\buildwar3x\engine\source\frame\CHighlightFrame.h

e:\drive1\temp\buildwar3x\engine\source\frame\CEditBox.h

e:\drive1\temp\buildwar3x\engine\source\framedef\IFrameDef.h

e:\drive1\temp\buildwar3x\engine\source\fdfile\FDFile.h

e:\drive1\temp\buildwar3x\engine\source\fdfile\handlers\MenuHashNode.h

e:\drive1\temp\buildwar3x\engine\source\frame\CSimpleMessageFrame.h

e:\drive1\temp\buildwar3x\war3\source\worldedit\WECustomObjectData.h

e:\drive1\temp\buildwar3x\war3\source\worldedit\CCustomObjectData.h

e:\drive1\temp\buildwar3x\engine\source\base\MsgBuffer.h

e:\drive1\temp\buildwar3x\engine\source\gxu\IGxuFont.h

e:\Drive1\temp\buildwar3x\War3\bin\Game.pdb

Also keep in mind that modification of the source code or Game.dll is strictly prohibited by Blizzard. Hive doesn't support such actions as Blizzard could take this site down if that happened. What you're asking for wont happen, nobody will spend tons of hours reverse engineering it only for it to be hunted down by Blizzard.

Reverse engineering a game is a serious crime, it also is dangerous as you would be sued or had to pay the toll.

You should read End User License Agreement.

			Attachments

-

			Game.dllnodrive.txt

				Game.dllnodrive.txt

					9.5 KB

					&middot; Views: 654

-

			Game.dllwithdrive.txt

				Game.dllwithdrive.txt

					7.7 KB

					&middot; Views: 564
```

</details>

### A Void — post 2 (page 1)

> _(quoting aple)_


No problem, it is justified. Warcraft 3 has a lot of potential that has been ruined by these closed limitations. It would be awesome to edit UI or add new things to it.

### A Void — post 3 (page 1)

> _(quoting ENAleksey)_

Sorry, it's not working. It says no Game.dll found, it is there. I tried running it as an administrator..

Edit: It worked now, but there was no sky and it lagged like 1 frame per second.

### A Void — post 4 (page 1)

I just extracted Nirvana and RenderCraft then setup the files to run as administrator. I am running Windows 10. It gave me No Game.dll error and when I clicked on it in Windowed mode it ran the game, it was very laggy and there was no sky. Otherwise if it was running in full screen it crashed.
[image]
			[image]

Btw, I wanted to personally thank you for doing this mod, it is very amazing! It would be interesting to create something with this one day. Wonder how long it took you to do something like this..

### A Void — post 5 (page 1)

> _(quoting ENAleksey)_

I use d3d8/d3d9.dll in my Warcraft 3 folder. You can see why in my signature Warcraft 3 in Windows 10.

Yes i did set those programs to run as administrator. I also tried removing d3d8/d3d9.dll and the sky showed up. The no Game.dll error was still there and the game was very laggy.

### A Void — post 6 (page 1)

> _(quoting Dr Super Good)_

Sneaky Blizzard will release a new War3 patch to break this mod.

#ENAleksey

OK It works! The only problem is that it laggs!

It conflicts with 8 MB Map Size Limit Remover (https://www.hiveworkshop.com/forums/tools-560/warcraft-iii-bypass-map-file-size-limit-ver-6-a-259571/) and D3D9.dll (https://www.hiveworkshop.com/threads/warcraft-3-windows-10-os.269225/post-2723092). I had to remove those.

### A Void — post 7 (page 1)

> _(quoting ENAleksey)_

I noticed that when I look in the horizon it starts to lagg. When I am looking on the ground or closer to the ground it is very smooth.

Maybe it's the problem with far distance? However, this mod is truly amazing and It looks beautiful! I thought that this was Skyrim at first.
[image]

### A Void — post 8 (page 1)

> _(quoting ENAleksey)_


Still laggs. As I've said it is possibly with far distance that causes the problem, try to lower the far distance maybe?

### A Void — post 9 (page 1)

> _(quoting ENAleksey)_


When I change +ReShade.dll to -ReShade.dll it wont open the map:
[image]

### A Void — post 10 (page 1)

> _(quoting Dr Super Good)_

Yes. Absolutely! I can play Far Cry 3 on maximum settings yet I can't play a graphically enhanced Warcraft 3 mod. Sounds logical.

> _(quoting Ezekiel12)_

Step 1 - Download Nirvana (http://www.moddb.com/mods/warcraft-iii-nirvana/downloads/warcraft-iii-nirvana-release-10) and put files into your Warcraft 3 installation.

Step 2 - Download RenderEdge and put files in your Warcraft 3 installation, overwrite if necessary.

Step 3 - Set Nirvana.exe, SharpCraft.exe, EasyHook32Svc.exe and EasyHook6432Svc.exe to run as administrator.

Step 4 - Run [RenderEdge] Start.bat or [RenderEdge] Start -window.bat to launch Warcraft 3.

Step 5 - Done!

and.. here is the video.

### A Void — post 11 (page 2)

> _(quoting Ezekiel12)_


Can you run the program with compatibility mode for Windows 7? Try to disable antivirus for a moment.

### A Void — post 12 (page 2)

> _(quoting DracoL1ch)_


What does Jass have to do with it? Warcraft 3 was coded in C++.

### A Void — post 13 (page 2)

Great news, ENAleksey. It looks amazing, to build your own interface GUI, to have correct aspect ratio (widescreen support), remove interface completely (no black borders.

### A Void — post 14 (page 2)

It's not game.dll it's a custom .exe and a custom library that .exe injects into Warcraft 3 (like SharpCraft or Reinventing the Craft). Official multiplayer will not be possible and it will have a huge performance drop on older computers.

New interface is drawn on top of the old one, since old one can't be removed (or edited) and black bars were removed by rendering the game screen using ZUKMAN's hack that the author modified in his library. Basically this will be good for single player projects.

Edit: It would be great to have GUI functions after you complete creating the natives.

### A Void — post 15 (page 3)

Doesn't work for me, it crashes when I start the map.

