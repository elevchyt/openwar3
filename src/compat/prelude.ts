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

// --- the object-FIELD accessors (1.29-1.31) ---------------------------------
// A map reads and writes a unit's or an ability's object-data column at run time. The
// field is an opaque handle wrapping the column's own metadata id, which is why the
// Convert* pair below is all the declaration needs: a map names the constant, the
// constant is ours to mint, and the engine is handed the id it already routes by
// (data/objectData.ts UNIT_SETTERS). The GETTERS read the row; the per-UNIT setters
// are not implemented (they change ONE unit, while our routing writes the TYPE) and
// answer their typed default, which is the same thing a 2003 map gets from a native
// this engine has not written yet.
type unitrealfield             extends    handle
type unitintegerfield          extends    handle
type unitbooleanfield          extends    handle
type unitstringfield           extends    handle
type unitweaponrealfield       extends    handle
type unitweaponintegerfield    extends    handle
type unitweaponbooleanfield    extends    handle
type unitweaponstringfield     extends    handle
type itemrealfield             extends    handle
type itemintegerfield          extends    handle
type itembooleanfield          extends    handle
type itemstringfield           extends    handle
type abilityrealfield          extends    handle
type abilityintegerfield       extends    handle
type abilitybooleanfield       extends    handle
type abilitystringfield        extends    handle
type abilityreallevelfield     extends    handle
type abilityintegerlevelfield  extends    handle
type abilitybooleanlevelfield  extends    handle
type abilitystringlevelfield   extends    handle
type abilityreallevelarrayfield    extends handle
type abilityintegerlevelarrayfield extends handle
type abilitybooleanlevelarrayfield extends handle
type abilitystringlevelarrayfield  extends handle

constant native ConvertUnitRealField            takes integer i returns unitrealfield
constant native ConvertUnitIntegerField         takes integer i returns unitintegerfield
constant native ConvertUnitBooleanField         takes integer i returns unitbooleanfield
constant native ConvertUnitStringField          takes integer i returns unitstringfield
constant native ConvertUnitWeaponRealField      takes integer i returns unitweaponrealfield
constant native ConvertUnitWeaponIntegerField   takes integer i returns unitweaponintegerfield
constant native ConvertUnitWeaponBooleanField   takes integer i returns unitweaponbooleanfield
constant native ConvertUnitWeaponStringField    takes integer i returns unitweaponstringfield
constant native ConvertItemRealField            takes integer i returns itemrealfield
constant native ConvertItemIntegerField         takes integer i returns itemintegerfield
constant native ConvertItemBooleanField         takes integer i returns itembooleanfield
constant native ConvertItemStringField          takes integer i returns itemstringfield
constant native ConvertAbilityRealField         takes integer i returns abilityrealfield
constant native ConvertAbilityIntegerField      takes integer i returns abilityintegerfield
constant native ConvertAbilityBooleanField      takes integer i returns abilitybooleanfield
constant native ConvertAbilityStringField       takes integer i returns abilitystringfield
constant native ConvertAbilityRealLevelField    takes integer i returns abilityreallevelfield
constant native ConvertAbilityIntegerLevelField takes integer i returns abilityintegerlevelfield
constant native ConvertAbilityBooleanLevelField takes integer i returns abilitybooleanlevelfield
constant native ConvertAbilityStringLevelField  takes integer i returns abilitystringlevelfield

native BlzGetUnitRealField    takes unit whichUnit, unitrealfield whichField returns real
native BlzGetUnitIntegerField takes unit whichUnit, unitintegerfield whichField returns integer
native BlzGetUnitBooleanField takes unit whichUnit, unitbooleanfield whichField returns boolean
native BlzGetUnitStringField  takes unit whichUnit, unitstringfield whichField returns string
native BlzSetUnitRealField    takes unit whichUnit, unitrealfield whichField, real value returns boolean
native BlzSetUnitIntegerField takes unit whichUnit, unitintegerfield whichField, integer value returns boolean
native BlzSetUnitBooleanField takes unit whichUnit, unitbooleanfield whichField, boolean value returns boolean
native BlzSetUnitStringField  takes unit whichUnit, unitstringfield whichField, string value returns boolean

native BlzGetUnitWeaponRealField    takes unit whichUnit, unitweaponrealfield whichField, integer index returns real
native BlzGetUnitWeaponIntegerField takes unit whichUnit, unitweaponintegerfield whichField, integer index returns integer
native BlzGetUnitWeaponBooleanField takes unit whichUnit, unitweaponbooleanfield whichField, integer index returns boolean
native BlzGetUnitWeaponStringField  takes unit whichUnit, unitweaponstringfield whichField, integer index returns string
native BlzSetUnitWeaponRealField    takes unit whichUnit, unitweaponrealfield whichField, integer index, real value returns boolean
native BlzSetUnitWeaponIntegerField takes unit whichUnit, unitweaponintegerfield whichField, integer index, integer value returns boolean
native BlzSetUnitWeaponBooleanField takes unit whichUnit, unitweaponbooleanfield whichField, integer index, boolean value returns boolean
native BlzSetUnitWeaponStringField  takes unit whichUnit, unitweaponstringfield whichField, integer index, string value returns boolean

native BlzGetItemRealField    takes item whichItem, itemrealfield whichField returns real
native BlzGetItemIntegerField takes item whichItem, itemintegerfield whichField returns integer
native BlzGetItemBooleanField takes item whichItem, itembooleanfield whichField returns boolean
native BlzGetItemStringField  takes item whichItem, itemstringfield whichField returns string
native BlzSetItemRealField    takes item whichItem, itemrealfield whichField, real value returns boolean
native BlzSetItemIntegerField takes item whichItem, itemintegerfield whichField, integer value returns boolean
native BlzSetItemBooleanField takes item whichItem, itembooleanfield whichField, boolean value returns boolean
native BlzSetItemStringField  takes item whichItem, itemstringfield whichField, string value returns boolean

native BlzGetUnitAbility        takes unit whichUnit, integer abilId returns ability
native BlzGetUnitAbilityByIndex takes unit whichUnit, integer index returns ability
native BlzGetItemAbility        takes item whichItem, integer abilCode returns ability
native BlzGetItemAbilityByIndex takes item whichItem, integer index returns ability
native BlzGetAbilityId          takes ability whichAbility returns integer
native BlzGetAbilityRealField           takes ability whichAbility, abilityrealfield whichField returns real
native BlzGetAbilityIntegerField        takes ability whichAbility, abilityintegerfield whichField returns integer
native BlzGetAbilityBooleanField        takes ability whichAbility, abilitybooleanfield whichField returns boolean
native BlzGetAbilityStringField         takes ability whichAbility, abilitystringfield whichField returns string
native BlzGetAbilityRealLevelField      takes ability whichAbility, abilityreallevelfield whichField, integer level returns real
native BlzGetAbilityIntegerLevelField   takes ability whichAbility, abilityintegerlevelfield whichField, integer level returns integer
native BlzGetAbilityBooleanLevelField   takes ability whichAbility, abilitybooleanlevelfield whichField, integer level returns boolean
native BlzGetAbilityStringLevelField    takes ability whichAbility, abilitystringlevelfield whichField, integer level returns string
native BlzSetAbilityRealField           takes ability whichAbility, abilityrealfield whichField, real value returns boolean
native BlzSetAbilityIntegerField        takes ability whichAbility, abilityintegerfield whichField, integer value returns boolean
native BlzSetAbilityBooleanField        takes ability whichAbility, abilitybooleanfield whichField, boolean value returns boolean
native BlzSetAbilityStringField         takes ability whichAbility, abilitystringfield whichField, string value returns boolean
native BlzSetAbilityRealLevelField      takes ability whichAbility, abilityreallevelfield whichField, integer level, real value returns boolean
native BlzSetAbilityIntegerLevelField   takes ability whichAbility, abilityintegerlevelfield whichField, integer level, integer value returns boolean
native BlzSetAbilityBooleanLevelField   takes ability whichAbility, abilitybooleanlevelfield whichField, integer level, boolean value returns boolean
native BlzSetAbilityStringLevelField    takes ability whichAbility, abilitystringlevelfield whichField, integer level, string value returns boolean
native BlzStartUnitAbilityCooldown      takes unit whichUnit, integer abilCode, real cooldown returns nothing
native BlzEndUnitAbilityCooldown        takes unit whichUnit, integer abilCode returns nothing

// --- the damage event's other half (1.31) -----------------------------------
native BlzGetEventDamageTarget takes nothing returns unit
native BlzGetEventAttackType   takes nothing returns attacktype
native BlzGetEventDamageType   takes nothing returns damagetype
native BlzGetEventWeaponType   takes nothing returns weapontype
native BlzSetEventAttackType   takes attacktype whichAttackType returns boolean
native BlzSetEventDamageType   takes damagetype whichDamageType returns boolean
native BlzSetEventWeaponType   takes weapontype whichWeaponType returns boolean

// --- groups by INDEX (1.31) -------------------------------------------------
// The fast half of the group API: a map that wants member 3 no longer has to drain
// the group into another one. Implemented, not defaulted — see natives/groups.ts.
native BlzGroupGetSize      takes group whichGroup returns integer
native BlzGroupUnitAt       takes group whichGroup, integer index returns unit
native BlzGroupAddGroupFast takes group whichGroup, group addGroup returns integer
native BlzGroupRemoveGroupFast takes group whichGroup, group removeGroup returns integer

// --- the rest of the "WithSkin" family (1.31) --------------------------------
// Each is its skinless twin with a Reforged HD art id on the end, which an SD client
// drops. "BlzCreateUnitWithSkin" is declared with the units above.
native BlzCreateDestructableWithSkin      takes integer objectid, real x, real y, real face, real scale, integer variation, integer skinId returns destructable
native BlzCreateDestructableZWithSkin     takes integer objectid, real x, real y, real z, real face, real scale, integer variation, integer skinId returns destructable
native BlzCreateDeadDestructableWithSkin  takes integer objectid, real x, real y, real face, real scale, integer variation, integer skinId returns destructable
native BlzCreateDeadDestructableZWithSkin takes integer objectid, real x, real y, real z, real face, real scale, integer variation, integer skinId returns destructable
native BlzCreateItemWithSkin              takes integer itemid, real x, real y, integer skinId returns item
native BlzSetUnitSkin                     takes unit whichUnit, integer skinId returns nothing
native BlzGetUnitSkin                     takes unit whichUnit returns integer

// --- odds and ends a later blizzard.j grew -----------------------------------
native SetThematicMusicVolumeBJ takes integer volume returns nothing

// --- the minimap terrain texture (1.31) -------------------------------------
native BlzChangeMinimapTerrainTex takes string texFile returns boolean
`;
