// The JASS a later-format map expects and 1.30.4's own `common.j` does not declare.
//
// **This is OUR file, not Blizzard's.** OpenWar3 ships zero Blizzard code (CLAUDE.md's legal
// boundary), and the install's `Scripts\common.j` is read from the player's own folder like
// every other asset. What is written here is the small set of declarations a map built
// against a 1.31+ editor refers to and a 1.30.4 install has never heard of — written from
// scratch, naming only the API, and loaded AFTER the install's common.j so nothing it already
// declares is redeclared.
//
// How little is needed is the point. 1.30.4's common.j already declares **97 `Blz*` natives**
// (the unit-stat family, the ability and item tooltip family, the special-effect family,
// `BlzSetEventDamage`, the mouse events); those are ordinary unimplemented natives and belong
// in `src/jass/natives/`, not here. What is genuinely absent is a much shorter list.
//
// **The numbers are ours and only have to agree with the interpreter.** A `ConvertX(n)` index
// never appears in a map FILE — the map writes the constant's NAME, the compiler resolves it
// through this declaration, and our own dispatch compares the same index back. So the values
// below are allocated by us, continuing the file's own sequence past the highest index 1.30.4
// uses (the five spell phases, 289–293), and they are stated in exactly one place: here and
// `src/jass/interpreter.ts`, which must not disagree.

/**
 * The prelude, as JASS source. Loaded between the install's `common.j` and its `blizzard.j`,
 * for every map — a 2003 map simply never refers to any of it.
 */
export const COMPAT_PRELUDE = `
//============================================================================
// OpenWar3 compatibility prelude — see src/compat/prelude.ts.
// Declarations a map saved by a 1.31+ World Editor expects, which the
// 1.30.4 common.j does not carry. OpenWar3's own file; no Blizzard code.
//============================================================================

// --- damage events (1.31) ---------------------------------------------------
// A map's "damage engine" registers ONE of these per player instead of one
// EVENT_UNIT_DAMAGED per unit. DAMAGED fires when a blow has landed;
// DAMAGING fires BEFORE the reduction and lets the script change the amount,
// which our sim has no seam for yet — it is declared so the registration
// compiles and is never raised. Registering an event that never fires is
// exactly what the engine does for a map that asks about something absent.

// --- camera fields (1.31) ---------------------------------------------------
// The three LOCAL rotations, which turn the camera about its own axes rather
// than about the target point.

// --- units (1.31) -----------------------------------------------------------
// The skin is a Reforged HD art swap. We draw SD out of an SD install, so the
// skin id is read and dropped and the unit is created exactly as CreateUnit
// would — which is what the map wanted the call for.
native BlzCreateUnitWithSkin takes player id, integer unitid, real x, real y, real face, integer skinId returns unit
native BlzSetUnitFacingEx    takes unit whichUnit, real facingAngle returns nothing

// --- the start-location priority pair (1.31) --------------------------------
native SetEnemyStartLocPrioCount takes integer whichStartLoc, integer prioSlotCount returns nothing
native SetEnemyStartLocPrio      takes integer whichStartLoc, integer prioSlotIndex, integer otherStartLocIndex, startlocprio priority returns nothing

// --- the custom-UI frame API (1.31) -----------------------------------------
// A map ships its own .fdf/.toc and builds frames over the console. Declared
// so a map that uses it compiles and runs with its extra UI absent rather than
// not at all; see docs/map-compatibility.md step 5b.
type framehandle       extends    handle
type originframetype   extends    handle
type framepointtype    extends    handle
type frameeventtype    extends    handle

constant native ConvertOriginFrameType takes integer i returns originframetype
constant native ConvertFramePointType  takes integer i returns framepointtype
constant native ConvertFrameEventType  takes integer i returns frameeventtype




globals
    constant playerunitevent EVENT_PLAYER_UNIT_DAMAGED  = ConvertPlayerUnitEvent(308)
    constant playerunitevent EVENT_PLAYER_UNIT_DAMAGING = ConvertPlayerUnitEvent(315)
    constant camerafield CAMERA_FIELD_LOCAL_PITCH = ConvertCameraField(7)
    constant camerafield CAMERA_FIELD_LOCAL_YAW   = ConvertCameraField(8)
    constant camerafield CAMERA_FIELD_LOCAL_ROLL  = ConvertCameraField(9)
    constant originframetype ORIGIN_FRAME_GAME_UI            = ConvertOriginFrameType(0)
    constant originframetype ORIGIN_FRAME_COMMAND_BUTTON     = ConvertOriginFrameType(1)
    constant originframetype ORIGIN_FRAME_HERO_BAR           = ConvertOriginFrameType(2)
    constant originframetype ORIGIN_FRAME_HERO_BUTTON        = ConvertOriginFrameType(3)
    constant originframetype ORIGIN_FRAME_HERO_HP_BAR        = ConvertOriginFrameType(4)
    constant originframetype ORIGIN_FRAME_HERO_MANA_BAR      = ConvertOriginFrameType(5)
    constant originframetype ORIGIN_FRAME_HERO_BUTTON_INDICATOR = ConvertOriginFrameType(6)
    constant originframetype ORIGIN_FRAME_ITEM_BUTTON        = ConvertOriginFrameType(7)
    constant originframetype ORIGIN_FRAME_MINIMAP            = ConvertOriginFrameType(8)
    constant originframetype ORIGIN_FRAME_MINIMAP_BUTTON     = ConvertOriginFrameType(9)
    constant originframetype ORIGIN_FRAME_SYSTEM_BUTTON      = ConvertOriginFrameType(10)
    constant originframetype ORIGIN_FRAME_TOOLTIP            = ConvertOriginFrameType(11)
    constant originframetype ORIGIN_FRAME_UBERTOOLTIP        = ConvertOriginFrameType(12)
    constant originframetype ORIGIN_FRAME_CHAT_MSG           = ConvertOriginFrameType(13)
    constant originframetype ORIGIN_FRAME_UNIT_MSG           = ConvertOriginFrameType(14)
    constant originframetype ORIGIN_FRAME_TOP_MSG            = ConvertOriginFrameType(15)
    constant originframetype ORIGIN_FRAME_PORTRAIT           = ConvertOriginFrameType(16)
    constant originframetype ORIGIN_FRAME_WORLD_FRAME        = ConvertOriginFrameType(17)
    constant framepointtype FRAMEPOINT_TOPLEFT     = ConvertFramePointType(0)
    constant framepointtype FRAMEPOINT_TOP         = ConvertFramePointType(1)
    constant framepointtype FRAMEPOINT_TOPRIGHT    = ConvertFramePointType(2)
    constant framepointtype FRAMEPOINT_LEFT        = ConvertFramePointType(3)
    constant framepointtype FRAMEPOINT_CENTER      = ConvertFramePointType(4)
    constant framepointtype FRAMEPOINT_RIGHT       = ConvertFramePointType(5)
    constant framepointtype FRAMEPOINT_BOTTOMLEFT  = ConvertFramePointType(6)
    constant framepointtype FRAMEPOINT_BOTTOM      = ConvertFramePointType(7)
    constant framepointtype FRAMEPOINT_BOTTOMRIGHT = ConvertFramePointType(8)
    constant frameeventtype FRAMEEVENT_CONTROL_CLICK          = ConvertFrameEventType(1)
    constant frameeventtype FRAMEEVENT_MOUSE_ENTER            = ConvertFrameEventType(2)
    constant frameeventtype FRAMEEVENT_MOUSE_LEAVE            = ConvertFrameEventType(3)
    constant frameeventtype FRAMEEVENT_MOUSE_UP               = ConvertFrameEventType(4)
    constant frameeventtype FRAMEEVENT_MOUSE_DOWN             = ConvertFrameEventType(5)
    constant frameeventtype FRAMEEVENT_MOUSE_WHEEL            = ConvertFrameEventType(6)
    constant frameeventtype FRAMEEVENT_CHECKBOX_CHECKED       = ConvertFrameEventType(7)
    constant frameeventtype FRAMEEVENT_CHECKBOX_UNCHECKED     = ConvertFrameEventType(8)
    constant frameeventtype FRAMEEVENT_EDITBOX_TEXT_CHANGED   = ConvertFrameEventType(9)
    constant frameeventtype FRAMEEVENT_POPUPMENU_ITEM_CHANGED = ConvertFrameEventType(10)
    constant frameeventtype FRAMEEVENT_MOUSE_DOUBLECLICK      = ConvertFrameEventType(11)
    constant frameeventtype FRAMEEVENT_SPRITE_ANIM_UPDATE     = ConvertFrameEventType(12)
endglobals

native BlzLoadTOCFile              takes string TOCFile returns boolean
native BlzCreateFrame              takes string name, framehandle owner, integer priority, integer createContext returns framehandle
native BlzCreateSimpleFrame        takes string name, framehandle owner, integer createContext returns framehandle
native BlzCreateFrameByType        takes string typeName, string name, framehandle owner, string inherits, integer createContext returns framehandle
native BlzDestroyFrame             takes framehandle frame returns nothing
native BlzFrameSetPoint            takes framehandle frame, framepointtype point, framehandle relative, framepointtype relativePoint, real x, real y returns nothing
native BlzFrameSetAbsPoint         takes framehandle frame, framepointtype point, real x, real y returns nothing
native BlzFrameClearAllPoints      takes framehandle frame returns nothing
native BlzFrameSetAllPoints        takes framehandle frame, framehandle relative returns nothing
native BlzFrameSetVisible          takes framehandle frame, boolean visible returns nothing
native BlzFrameIsVisible           takes framehandle frame returns boolean
native BlzGetFrameByName           takes string name, integer createContext returns framehandle
native BlzFrameGetName             takes framehandle frame returns string
native BlzFrameClick               takes framehandle frame returns nothing
native BlzFrameSetText             takes framehandle frame, string text returns nothing
native BlzFrameGetText             takes framehandle frame returns string
native BlzFrameSetTexture          takes framehandle frame, string texFile, integer flag, boolean blend returns nothing
native BlzFrameSetScale            takes framehandle frame, real scale returns nothing
native BlzFrameSetTooltip          takes framehandle frame, framehandle tooltip returns nothing
native BlzFrameSetSize             takes framehandle frame, real width, real height returns nothing
native BlzFrameSetEnable           takes framehandle frame, boolean enabled returns nothing
native BlzFrameSetAlpha            takes framehandle frame, integer alpha returns nothing
native BlzFrameSetValue            takes framehandle frame, real value returns nothing
native BlzGetOriginFrame           takes originframetype frameType, integer index returns framehandle
native BlzHideOriginFrames         takes boolean enable returns nothing
native BlzGetTriggerFrame          takes nothing returns framehandle
native BlzGetTriggerFrameEvent     takes nothing returns frameeventtype
native BlzTriggerRegisterFrameEvent takes trigger whichTrigger, framehandle frame, frameeventtype eventId returns event

// --- the minimap terrain texture (1.31) -------------------------------------
native BlzChangeMinimapTerrainTex takes string texFile returns boolean
`;
