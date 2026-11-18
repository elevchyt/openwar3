// The JASS a map built for 1.31, Reforged (1.32–2.0) or the 3.0 "Forsaken Kingdom" update refers to
// and 1.30.4's own `common.j` does not declare — the second half of src/compat/prelude.ts, split
// off only because of its length.
//
// **This is OUR file, not Blizzard's**, under the same rule as the prelude it extends: it names
// the API a later map calls (a native's name, its parameters, the constants of the types those
// parameters take) so that such a map compiles and runs, and it carries no Blizzard code — there
// is none to carry, a native has no body. What each one DOES is src/jass/natives/later.ts; a
// native declared here and answered there with "nothing, because this engine has no such system"
// says so at its registration.
//
// The indices are the ones the later game uses where a number MEANS something outside our own
// dispatch (an `oskeytype` is the Windows virtual-key code the keyboard reports; an event id is
// what `GetTriggerEventId` compares), and ours where it does not.
//
// Deliberately NOT declared:
//   * `RACE_PREF_FORSAKEN` and anything else of the Forsaken race — docs/patches.md, DENIED_IDS.
//   * `ITEM_TYPE_EQUIPMENT`, whose index (7) is 1.30.4's own ITEM_TYPE_UNKNOWN.
//   * the ~900 object-FIELD constants a 2.0 common.j adds (ABILITY_RLF_…, UNIT_WEAPON_RF_…):
//     those are rows of src/compat/blzFields.ts, the one place that list lives.

export const LATER_PRELUDE = `
// --- handle types -----------------------------------------------------------
type textaligntype extends handle
type oskeytype extends handle
type movetype extends handle
type targetflag extends handle
type armortype extends handle
type heroattribute extends handle
type defensetype extends handle
type regentype extends handle
type unitcategory extends handle
type pathingflag extends handle
type fogstyle extends handle
type equipmentType extends handle
type itemTag extends handle
type loadoutslot extends handle
type minimapicon extends handle
type commandbuttoneffect extends handle

// --- the Convert… constructors of those types ----------------------------------
constant native ConvertTextAlignType takes integer i returns textaligntype
constant native ConvertOsKeyType takes integer i returns oskeytype
constant native ConvertAbilityIntegerLevelArrayField takes integer i returns abilityintegerlevelarrayfield
constant native ConvertAbilityRealLevelArrayField takes integer i returns abilityreallevelarrayfield
constant native ConvertAbilityBooleanLevelArrayField takes integer i returns abilitybooleanlevelarrayfield
constant native ConvertAbilityStringLevelArrayField takes integer i returns abilitystringlevelarrayfield
constant native ConvertMoveType takes integer i returns movetype
constant native ConvertTargetFlag takes integer i returns targetflag
constant native ConvertArmorType takes integer i returns armortype
constant native ConvertHeroAttribute takes integer i returns heroattribute
constant native ConvertDefenseType takes integer i returns defensetype
constant native ConvertRegenType takes integer i returns regentype
constant native ConvertUnitCategory takes integer i returns unitcategory
constant native ConvertPathingFlag takes integer i returns pathingflag
constant native ConvertFogStyle takes integer i returns fogstyle
constant native ConvertEquipmentType takes integer i returns equipmentType
constant native ConvertItemTag takes integer i returns itemTag
constant native ConvertLoadoutSlot takes integer i returns loadoutslot

globals
    constant fogstyle FOG_STYLE_LINEAR = ConvertFogStyle(0)
    constant fogstyle FOG_STYLE_EXP = ConvertFogStyle(1)
    constant fogstyle FOG_STYLE_EXP2 = ConvertFogStyle(2)
    constant fogstyle FOG_STYLE_HEIGHT = ConvertFogStyle(3)
    constant fogstyle FOG_STYLE_NEW_EXP = ConvertFogStyle(4)
    constant fogstyle FOG_STYLE_NEW_EXP_2 = ConvertFogStyle(5)
    constant gameevent EVENT_GAME_CUSTOM_UI_FRAME = ConvertGameEvent(310)
    constant playerevent EVENT_PLAYER_SYNC_DATA = ConvertPlayerEvent(309)
    constant playerevent EVENT_PLAYER_KEY = ConvertPlayerEvent(311)
    constant playerevent EVENT_PLAYER_KEY_DOWN = ConvertPlayerEvent(312)
    constant playerevent EVENT_PLAYER_KEY_UP = ConvertPlayerEvent(313)
    constant playerunitevent EVENT_PLAYER_UNIT_STACK_ITEM = ConvertPlayerUnitEvent(319)
    constant playerunitevent EVENT_PLAYER_UNIT_EQUIP_ITEM = ConvertPlayerUnitEvent(321)
    constant playerunitevent EVENT_PLAYER_UNIT_UNEQUIP_ITEM = ConvertPlayerUnitEvent(323)
    constant unitevent EVENT_UNIT_STACK_ITEM = ConvertUnitEvent(318)
    constant unitevent EVENT_UNIT_EQUIP_ITEM = ConvertUnitEvent(320)
    constant unitevent EVENT_UNIT_UNEQUIP_ITEM = ConvertUnitEvent(322)
    constant equipmentType EQUIPMENT_TYPE_NONE = ConvertEquipmentType(0)
    constant equipmentType EQUIPMENT_TYPE_HEAD = ConvertEquipmentType(1)
    constant equipmentType EQUIPMENT_TYPE_CHEST = ConvertEquipmentType(2)
    constant equipmentType EQUIPMENT_TYPE_GLOVES = ConvertEquipmentType(3)
    constant equipmentType EQUIPMENT_TYPE_BOOTS = ConvertEquipmentType(4)
    constant equipmentType EQUIPMENT_TYPE_RING = ConvertEquipmentType(5)
    constant equipmentType EQUIPMENT_TYPE_PRIMARY = ConvertEquipmentType(6)
    constant equipmentType EQUIPMENT_TYPE_OFFHAND = ConvertEquipmentType(7)
    constant equipmentType EQUIPMENT_TYPE_TRINKET = ConvertEquipmentType(8)
    constant equipmentType EQUIPMENT_TYPE_ANY = ConvertEquipmentType(9)
    constant itemTag ITEMTAG_TYPE_UNDEFINED = ConvertItemTag(0)
    constant itemTag ITEMTAG_TYPE_DROPPABLE = ConvertItemTag(1)
    constant itemTag ITEMTAG_TYPE_QUESTREWARD = ConvertItemTag(2)
    constant itemTag ITEMTAG_TYPE_BOSSDROP = ConvertItemTag(3)
    constant itemTag ITEMTAG_TYPE_SECRET = ConvertItemTag(4)
    constant itemTag ITEMTAG_TYPE_PUZZLE = ConvertItemTag(5)
    constant itemTag ITEMTAG_TYPE_WORLD = ConvertItemTag(6)
    constant itemTag ITEMTAG_TYPE_SHOP = ConvertItemTag(7)
    constant itemTag ITEMTAG_TYPE_ANY = ConvertItemTag(8)
    constant loadoutslot EQUIPMENT_LOADOUT_SLOT_HEAD = ConvertLoadoutSlot(0)
    constant loadoutslot EQUIPMENT_LOADOUT_SLOT_CHEST = ConvertLoadoutSlot(1)
    constant loadoutslot EQUIPMENT_LOADOUT_SLOT_GLOVES = ConvertLoadoutSlot(2)
    constant loadoutslot EQUIPMENT_LOADOUT_SLOT_BOOTS = ConvertLoadoutSlot(3)
    constant loadoutslot EQUIPMENT_LOADOUT_SLOT_RING = ConvertLoadoutSlot(4)
    constant loadoutslot EQUIPMENT_LOADOUT_SLOT_RINGALT = ConvertLoadoutSlot(5)
    constant loadoutslot EQUIPMENT_LOADOUT_SLOT_PRIMARY = ConvertLoadoutSlot(6)
    constant loadoutslot EQUIPMENT_LOADOUT_SLOT_OFFHAND = ConvertLoadoutSlot(7)
    constant loadoutslot EQUIPMENT_LOADOUT_SLOT_TRINKET = ConvertLoadoutSlot(8)
    constant camerafield CAMERA_FIELD_DEPTH_OF_FIELD_DISTANCE = ConvertCameraField(11)
    constant camerafield CAMERA_FIELD_DEPTH_OF_FIELD_SCALE = ConvertCameraField(12)
    constant camerafield CAMERA_FIELD_ZABSOLUTE = ConvertCameraField(13)
    constant originframetype ORIGIN_FRAME_SIMPLE_UI_PARENT = ConvertOriginFrameType(18)
    constant originframetype ORIGIN_FRAME_PORTRAIT_HP_TEXT = ConvertOriginFrameType(19)
    constant originframetype ORIGIN_FRAME_PORTRAIT_MANA_TEXT = ConvertOriginFrameType(20)
    constant originframetype ORIGIN_FRAME_UNIT_PANEL_BUFF_BAR = ConvertOriginFrameType(21)
    constant originframetype ORIGIN_FRAME_UNIT_PANEL_BUFF_BAR_LABEL = ConvertOriginFrameType(22)
    constant textaligntype TEXT_JUSTIFY_TOP = ConvertTextAlignType(0)
    constant textaligntype TEXT_JUSTIFY_MIDDLE = ConvertTextAlignType(1)
    constant textaligntype TEXT_JUSTIFY_BOTTOM = ConvertTextAlignType(2)
    constant textaligntype TEXT_JUSTIFY_LEFT = ConvertTextAlignType(3)
    constant textaligntype TEXT_JUSTIFY_CENTER = ConvertTextAlignType(4)
    constant textaligntype TEXT_JUSTIFY_RIGHT = ConvertTextAlignType(5)
    constant frameeventtype FRAMEEVENT_SLIDER_VALUE_CHANGED = ConvertFrameEventType(13)
    constant frameeventtype FRAMEEVENT_DIALOG_CANCEL = ConvertFrameEventType(14)
    constant frameeventtype FRAMEEVENT_DIALOG_ACCEPT = ConvertFrameEventType(15)
    constant frameeventtype FRAMEEVENT_EDITBOX_ENTER = ConvertFrameEventType(16)
    constant oskeytype OSKEY_BACKSPACE = ConvertOsKeyType(8)
    constant oskeytype OSKEY_TAB = ConvertOsKeyType(9)
    constant oskeytype OSKEY_CLEAR = ConvertOsKeyType(12)
    constant oskeytype OSKEY_RETURN = ConvertOsKeyType(13)
    constant oskeytype OSKEY_SHIFT = ConvertOsKeyType(16)
    constant oskeytype OSKEY_CONTROL = ConvertOsKeyType(17)
    constant oskeytype OSKEY_ALT = ConvertOsKeyType(18)
    constant oskeytype OSKEY_PAUSE = ConvertOsKeyType(19)
    constant oskeytype OSKEY_CAPSLOCK = ConvertOsKeyType(20)
    constant oskeytype OSKEY_KANA = ConvertOsKeyType(21)
    constant oskeytype OSKEY_HANGUL = ConvertOsKeyType(21)
    constant oskeytype OSKEY_JUNJA = ConvertOsKeyType(23)
    constant oskeytype OSKEY_FINAL = ConvertOsKeyType(24)
    constant oskeytype OSKEY_HANJA = ConvertOsKeyType(25)
    constant oskeytype OSKEY_KANJI = ConvertOsKeyType(25)
    constant oskeytype OSKEY_ESCAPE = ConvertOsKeyType(27)
    constant oskeytype OSKEY_CONVERT = ConvertOsKeyType(28)
    constant oskeytype OSKEY_NONCONVERT = ConvertOsKeyType(29)
    constant oskeytype OSKEY_ACCEPT = ConvertOsKeyType(30)
    constant oskeytype OSKEY_MODECHANGE = ConvertOsKeyType(31)
    constant oskeytype OSKEY_SPACE = ConvertOsKeyType(32)
    constant oskeytype OSKEY_PAGEUP = ConvertOsKeyType(33)
    constant oskeytype OSKEY_PAGEDOWN = ConvertOsKeyType(34)
    constant oskeytype OSKEY_END = ConvertOsKeyType(35)
    constant oskeytype OSKEY_HOME = ConvertOsKeyType(36)
    constant oskeytype OSKEY_LEFT = ConvertOsKeyType(37)
    constant oskeytype OSKEY_UP = ConvertOsKeyType(38)
    constant oskeytype OSKEY_RIGHT = ConvertOsKeyType(39)
    constant oskeytype OSKEY_DOWN = ConvertOsKeyType(40)
    constant oskeytype OSKEY_SELECT = ConvertOsKeyType(41)
    constant oskeytype OSKEY_PRINT = ConvertOsKeyType(42)
    constant oskeytype OSKEY_EXECUTE = ConvertOsKeyType(43)
    constant oskeytype OSKEY_PRINTSCREEN = ConvertOsKeyType(44)
    constant oskeytype OSKEY_INSERT = ConvertOsKeyType(45)
    constant oskeytype OSKEY_DELETE = ConvertOsKeyType(46)
    constant oskeytype OSKEY_HELP = ConvertOsKeyType(47)
    constant oskeytype OSKEY_0 = ConvertOsKeyType(48)
    constant oskeytype OSKEY_1 = ConvertOsKeyType(49)
    constant oskeytype OSKEY_2 = ConvertOsKeyType(50)
    constant oskeytype OSKEY_3 = ConvertOsKeyType(51)
    constant oskeytype OSKEY_4 = ConvertOsKeyType(52)
    constant oskeytype OSKEY_5 = ConvertOsKeyType(53)
    constant oskeytype OSKEY_6 = ConvertOsKeyType(54)
    constant oskeytype OSKEY_7 = ConvertOsKeyType(55)
    constant oskeytype OSKEY_8 = ConvertOsKeyType(56)
    constant oskeytype OSKEY_9 = ConvertOsKeyType(57)
    constant oskeytype OSKEY_A = ConvertOsKeyType(65)
    constant oskeytype OSKEY_B = ConvertOsKeyType(66)
    constant oskeytype OSKEY_C = ConvertOsKeyType(67)
    constant oskeytype OSKEY_D = ConvertOsKeyType(68)
    constant oskeytype OSKEY_E = ConvertOsKeyType(69)
    constant oskeytype OSKEY_F = ConvertOsKeyType(70)
    constant oskeytype OSKEY_G = ConvertOsKeyType(71)
    constant oskeytype OSKEY_H = ConvertOsKeyType(72)
    constant oskeytype OSKEY_I = ConvertOsKeyType(73)
    constant oskeytype OSKEY_J = ConvertOsKeyType(74)
    constant oskeytype OSKEY_K = ConvertOsKeyType(75)
    constant oskeytype OSKEY_L = ConvertOsKeyType(76)
    constant oskeytype OSKEY_M = ConvertOsKeyType(77)
    constant oskeytype OSKEY_N = ConvertOsKeyType(78)
    constant oskeytype OSKEY_O = ConvertOsKeyType(79)
    constant oskeytype OSKEY_P = ConvertOsKeyType(80)
    constant oskeytype OSKEY_Q = ConvertOsKeyType(81)
    constant oskeytype OSKEY_R = ConvertOsKeyType(82)
    constant oskeytype OSKEY_S = ConvertOsKeyType(83)
    constant oskeytype OSKEY_T = ConvertOsKeyType(84)
    constant oskeytype OSKEY_U = ConvertOsKeyType(85)
    constant oskeytype OSKEY_V = ConvertOsKeyType(86)
    constant oskeytype OSKEY_W = ConvertOsKeyType(87)
    constant oskeytype OSKEY_X = ConvertOsKeyType(88)
    constant oskeytype OSKEY_Y = ConvertOsKeyType(89)
    constant oskeytype OSKEY_Z = ConvertOsKeyType(90)
    constant oskeytype OSKEY_LMETA = ConvertOsKeyType(91)
    constant oskeytype OSKEY_RMETA = ConvertOsKeyType(92)
    constant oskeytype OSKEY_APPS = ConvertOsKeyType(93)
    constant oskeytype OSKEY_SLEEP = ConvertOsKeyType(95)
    constant oskeytype OSKEY_NUMPAD0 = ConvertOsKeyType(96)
    constant oskeytype OSKEY_NUMPAD1 = ConvertOsKeyType(97)
    constant oskeytype OSKEY_NUMPAD2 = ConvertOsKeyType(98)
    constant oskeytype OSKEY_NUMPAD3 = ConvertOsKeyType(99)
    constant oskeytype OSKEY_NUMPAD4 = ConvertOsKeyType(100)
    constant oskeytype OSKEY_NUMPAD5 = ConvertOsKeyType(101)
    constant oskeytype OSKEY_NUMPAD6 = ConvertOsKeyType(102)
    constant oskeytype OSKEY_NUMPAD7 = ConvertOsKeyType(103)
    constant oskeytype OSKEY_NUMPAD8 = ConvertOsKeyType(104)
    constant oskeytype OSKEY_NUMPAD9 = ConvertOsKeyType(105)
    constant oskeytype OSKEY_MULTIPLY = ConvertOsKeyType(106)
    constant oskeytype OSKEY_ADD = ConvertOsKeyType(107)
    constant oskeytype OSKEY_SEPARATOR = ConvertOsKeyType(108)
    constant oskeytype OSKEY_SUBTRACT = ConvertOsKeyType(109)
    constant oskeytype OSKEY_DECIMAL = ConvertOsKeyType(110)
    constant oskeytype OSKEY_DIVIDE = ConvertOsKeyType(111)
    constant oskeytype OSKEY_F1 = ConvertOsKeyType(112)
    constant oskeytype OSKEY_F2 = ConvertOsKeyType(113)
    constant oskeytype OSKEY_F3 = ConvertOsKeyType(114)
    constant oskeytype OSKEY_F4 = ConvertOsKeyType(115)
    constant oskeytype OSKEY_F5 = ConvertOsKeyType(116)
    constant oskeytype OSKEY_F6 = ConvertOsKeyType(117)
    constant oskeytype OSKEY_F7 = ConvertOsKeyType(118)
    constant oskeytype OSKEY_F8 = ConvertOsKeyType(119)
    constant oskeytype OSKEY_F9 = ConvertOsKeyType(120)
    constant oskeytype OSKEY_F10 = ConvertOsKeyType(121)
    constant oskeytype OSKEY_F11 = ConvertOsKeyType(122)
    constant oskeytype OSKEY_F12 = ConvertOsKeyType(123)
    constant oskeytype OSKEY_F13 = ConvertOsKeyType(124)
    constant oskeytype OSKEY_F14 = ConvertOsKeyType(125)
    constant oskeytype OSKEY_F15 = ConvertOsKeyType(126)
    constant oskeytype OSKEY_F16 = ConvertOsKeyType(127)
    constant oskeytype OSKEY_F17 = ConvertOsKeyType(128)
    constant oskeytype OSKEY_F18 = ConvertOsKeyType(129)
    constant oskeytype OSKEY_F19 = ConvertOsKeyType(130)
    constant oskeytype OSKEY_F20 = ConvertOsKeyType(131)
    constant oskeytype OSKEY_F21 = ConvertOsKeyType(132)
    constant oskeytype OSKEY_F22 = ConvertOsKeyType(133)
    constant oskeytype OSKEY_F23 = ConvertOsKeyType(134)
    constant oskeytype OSKEY_F24 = ConvertOsKeyType(135)
    constant oskeytype OSKEY_NUMLOCK = ConvertOsKeyType(144)
    constant oskeytype OSKEY_SCROLLLOCK = ConvertOsKeyType(145)
    constant oskeytype OSKEY_OEM_NEC_EQUAL = ConvertOsKeyType(146)
    constant oskeytype OSKEY_OEM_FJ_JISHO = ConvertOsKeyType(146)
    constant oskeytype OSKEY_OEM_FJ_MASSHOU = ConvertOsKeyType(147)
    constant oskeytype OSKEY_OEM_FJ_TOUROKU = ConvertOsKeyType(148)
    constant oskeytype OSKEY_OEM_FJ_LOYA = ConvertOsKeyType(149)
    constant oskeytype OSKEY_OEM_FJ_ROYA = ConvertOsKeyType(150)
    constant oskeytype OSKEY_LSHIFT = ConvertOsKeyType(160)
    constant oskeytype OSKEY_RSHIFT = ConvertOsKeyType(161)
    constant oskeytype OSKEY_LCONTROL = ConvertOsKeyType(162)
    constant oskeytype OSKEY_RCONTROL = ConvertOsKeyType(163)
    constant oskeytype OSKEY_LALT = ConvertOsKeyType(164)
    constant oskeytype OSKEY_RALT = ConvertOsKeyType(165)
    constant oskeytype OSKEY_BROWSER_BACK = ConvertOsKeyType(166)
    constant oskeytype OSKEY_BROWSER_FORWARD = ConvertOsKeyType(167)
    constant oskeytype OSKEY_BROWSER_REFRESH = ConvertOsKeyType(168)
    constant oskeytype OSKEY_BROWSER_STOP = ConvertOsKeyType(169)
    constant oskeytype OSKEY_BROWSER_SEARCH = ConvertOsKeyType(170)
    constant oskeytype OSKEY_BROWSER_FAVORITES = ConvertOsKeyType(171)
    constant oskeytype OSKEY_BROWSER_HOME = ConvertOsKeyType(172)
    constant oskeytype OSKEY_VOLUME_MUTE = ConvertOsKeyType(173)
    constant oskeytype OSKEY_VOLUME_DOWN = ConvertOsKeyType(174)
    constant oskeytype OSKEY_VOLUME_UP = ConvertOsKeyType(175)
    constant oskeytype OSKEY_MEDIA_NEXT_TRACK = ConvertOsKeyType(176)
    constant oskeytype OSKEY_MEDIA_PREV_TRACK = ConvertOsKeyType(177)
    constant oskeytype OSKEY_MEDIA_STOP = ConvertOsKeyType(178)
    constant oskeytype OSKEY_MEDIA_PLAY_PAUSE = ConvertOsKeyType(179)
    constant oskeytype OSKEY_LAUNCH_MAIL = ConvertOsKeyType(180)
    constant oskeytype OSKEY_LAUNCH_MEDIA_SELECT = ConvertOsKeyType(181)
    constant oskeytype OSKEY_LAUNCH_APP1 = ConvertOsKeyType(182)
    constant oskeytype OSKEY_LAUNCH_APP2 = ConvertOsKeyType(183)
    constant oskeytype OSKEY_OEM_1 = ConvertOsKeyType(186)
    constant oskeytype OSKEY_OEM_PLUS = ConvertOsKeyType(187)
    constant oskeytype OSKEY_OEM_COMMA = ConvertOsKeyType(188)
    constant oskeytype OSKEY_OEM_MINUS = ConvertOsKeyType(189)
    constant oskeytype OSKEY_OEM_PERIOD = ConvertOsKeyType(190)
    constant oskeytype OSKEY_OEM_2 = ConvertOsKeyType(191)
    constant oskeytype OSKEY_OEM_3 = ConvertOsKeyType(192)
    constant oskeytype OSKEY_OEM_4 = ConvertOsKeyType(219)
    constant oskeytype OSKEY_OEM_5 = ConvertOsKeyType(220)
    constant oskeytype OSKEY_OEM_6 = ConvertOsKeyType(221)
    constant oskeytype OSKEY_OEM_7 = ConvertOsKeyType(222)
    constant oskeytype OSKEY_OEM_8 = ConvertOsKeyType(223)
    constant oskeytype OSKEY_OEM_AX = ConvertOsKeyType(225)
    constant oskeytype OSKEY_OEM_102 = ConvertOsKeyType(226)
    constant oskeytype OSKEY_ICO_HELP = ConvertOsKeyType(227)
    constant oskeytype OSKEY_ICO_00 = ConvertOsKeyType(228)
    constant oskeytype OSKEY_PROCESSKEY = ConvertOsKeyType(229)
    constant oskeytype OSKEY_ICO_CLEAR = ConvertOsKeyType(230)
    constant oskeytype OSKEY_PACKET = ConvertOsKeyType(231)
    constant oskeytype OSKEY_OEM_RESET = ConvertOsKeyType(233)
    constant oskeytype OSKEY_OEM_JUMP = ConvertOsKeyType(234)
    constant oskeytype OSKEY_OEM_PA1 = ConvertOsKeyType(235)
    constant oskeytype OSKEY_OEM_PA2 = ConvertOsKeyType(236)
    constant oskeytype OSKEY_OEM_PA3 = ConvertOsKeyType(237)
    constant oskeytype OSKEY_OEM_WSCTRL = ConvertOsKeyType(238)
    constant oskeytype OSKEY_OEM_CUSEL = ConvertOsKeyType(239)
    constant oskeytype OSKEY_OEM_ATTN = ConvertOsKeyType(240)
    constant oskeytype OSKEY_OEM_FINISH = ConvertOsKeyType(241)
    constant oskeytype OSKEY_OEM_COPY = ConvertOsKeyType(242)
    constant oskeytype OSKEY_OEM_AUTO = ConvertOsKeyType(243)
    constant oskeytype OSKEY_OEM_ENLW = ConvertOsKeyType(244)
    constant oskeytype OSKEY_OEM_BACKTAB = ConvertOsKeyType(245)
    constant oskeytype OSKEY_ATTN = ConvertOsKeyType(246)
    constant oskeytype OSKEY_CRSEL = ConvertOsKeyType(247)
    constant oskeytype OSKEY_EXSEL = ConvertOsKeyType(248)
    constant oskeytype OSKEY_EREOF = ConvertOsKeyType(249)
    constant oskeytype OSKEY_PLAY = ConvertOsKeyType(250)
    constant oskeytype OSKEY_ZOOM = ConvertOsKeyType(251)
    constant oskeytype OSKEY_NONAME = ConvertOsKeyType(252)
    constant oskeytype OSKEY_PA1 = ConvertOsKeyType(253)
    constant oskeytype OSKEY_OEM_CLEAR = ConvertOsKeyType(254)
    constant integer METAKEY_NONE = 0
    constant integer METAKEY_SHIFT = 1
    constant integer METAKEY_CTRL = 2
    constant integer METAKEY_ALT = 4
    constant integer METAKEY_WINKEYS = 8
    constant movetype MOVE_TYPE_UNKNOWN = ConvertMoveType(0)
    constant movetype MOVE_TYPE_FOOT = ConvertMoveType(1)
    constant movetype MOVE_TYPE_FLY = ConvertMoveType(2)
    constant movetype MOVE_TYPE_HORSE = ConvertMoveType(4)
    constant movetype MOVE_TYPE_HOVER = ConvertMoveType(8)
    constant movetype MOVE_TYPE_FLOAT = ConvertMoveType(16)
    constant movetype MOVE_TYPE_AMPHIBIOUS = ConvertMoveType(32)
    constant movetype MOVE_TYPE_UNBUILDABLE = ConvertMoveType(64)
    constant targetflag TARGET_FLAG_NONE = ConvertTargetFlag(1)
    constant targetflag TARGET_FLAG_GROUND = ConvertTargetFlag(2)
    constant targetflag TARGET_FLAG_AIR = ConvertTargetFlag(4)
    constant targetflag TARGET_FLAG_STRUCTURE = ConvertTargetFlag(8)
    constant targetflag TARGET_FLAG_WARD = ConvertTargetFlag(16)
    constant targetflag TARGET_FLAG_ITEM = ConvertTargetFlag(32)
    constant targetflag TARGET_FLAG_TREE = ConvertTargetFlag(64)
    constant targetflag TARGET_FLAG_WALL = ConvertTargetFlag(128)
    constant targetflag TARGET_FLAG_DEBRIS = ConvertTargetFlag(256)
    constant targetflag TARGET_FLAG_DECORATION = ConvertTargetFlag(512)
    constant targetflag TARGET_FLAG_BRIDGE = ConvertTargetFlag(1024)
    constant defensetype DEFENSE_TYPE_LIGHT = ConvertDefenseType(0)
    constant defensetype DEFENSE_TYPE_MEDIUM = ConvertDefenseType(1)
    constant defensetype DEFENSE_TYPE_LARGE = ConvertDefenseType(2)
    constant defensetype DEFENSE_TYPE_FORT = ConvertDefenseType(3)
    constant defensetype DEFENSE_TYPE_NORMAL = ConvertDefenseType(4)
    constant defensetype DEFENSE_TYPE_HERO = ConvertDefenseType(5)
    constant defensetype DEFENSE_TYPE_DIVINE = ConvertDefenseType(6)
    constant defensetype DEFENSE_TYPE_NONE = ConvertDefenseType(7)
    constant heroattribute HERO_ATTRIBUTE_STR = ConvertHeroAttribute(1)
    constant heroattribute HERO_ATTRIBUTE_INT = ConvertHeroAttribute(2)
    constant heroattribute HERO_ATTRIBUTE_AGI = ConvertHeroAttribute(3)
    constant armortype ARMOR_TYPE_WHOKNOWS = ConvertArmorType(0)
    constant armortype ARMOR_TYPE_FLESH = ConvertArmorType(1)
    constant armortype ARMOR_TYPE_METAL = ConvertArmorType(2)
    constant armortype ARMOR_TYPE_WOOD = ConvertArmorType(3)
    constant armortype ARMOR_TYPE_ETHREAL = ConvertArmorType(4)
    constant armortype ARMOR_TYPE_STONE = ConvertArmorType(5)
    constant regentype REGENERATION_TYPE_NONE = ConvertRegenType(0)
    constant regentype REGENERATION_TYPE_ALWAYS = ConvertRegenType(1)
    constant regentype REGENERATION_TYPE_BLIGHT = ConvertRegenType(2)
    constant regentype REGENERATION_TYPE_DAY = ConvertRegenType(3)
    constant regentype REGENERATION_TYPE_NIGHT = ConvertRegenType(4)
    constant unitcategory UNIT_CATEGORY_GIANT = ConvertUnitCategory(1)
    constant unitcategory UNIT_CATEGORY_UNDEAD = ConvertUnitCategory(2)
    constant unitcategory UNIT_CATEGORY_SUMMONED = ConvertUnitCategory(4)
    constant unitcategory UNIT_CATEGORY_MECHANICAL = ConvertUnitCategory(8)
    constant unitcategory UNIT_CATEGORY_PEON = ConvertUnitCategory(16)
    constant unitcategory UNIT_CATEGORY_SAPPER = ConvertUnitCategory(32)
    constant unitcategory UNIT_CATEGORY_TOWNHALL = ConvertUnitCategory(64)
    constant unitcategory UNIT_CATEGORY_ANCIENT = ConvertUnitCategory(128)
    constant unitcategory UNIT_CATEGORY_NEUTRAL = ConvertUnitCategory(256)
    constant unitcategory UNIT_CATEGORY_WARD = ConvertUnitCategory(512)
    constant unitcategory UNIT_CATEGORY_STANDON = ConvertUnitCategory(1024)
    constant unitcategory UNIT_CATEGORY_TAUREN = ConvertUnitCategory(2048)
    constant pathingflag PATHING_FLAG_UNWALKABLE = ConvertPathingFlag(2)
    constant pathingflag PATHING_FLAG_UNFLYABLE = ConvertPathingFlag(4)
    constant pathingflag PATHING_FLAG_UNBUILDABLE = ConvertPathingFlag(8)
    constant pathingflag PATHING_FLAG_UNPEONHARVEST = ConvertPathingFlag(16)
    constant pathingflag PATHING_FLAG_BLIGHTED = ConvertPathingFlag(32)
    constant pathingflag PATHING_FLAG_UNFLOATABLE = ConvertPathingFlag(64)
    constant pathingflag PATHING_FLAG_UNAMPHIBIOUS = ConvertPathingFlag(128)
    constant pathingflag PATHING_FLAG_UNITEMPLACABLE = ConvertPathingFlag(256)
endglobals

// --- natives added in 1.31 ----------------------------------------------
native BlzForceHasPlayer takes force whichForce, player whichPlayer returns boolean
native SaveFrameHandle takes hashtable table, integer parentKey, integer childKey, framehandle whichFrameHandle returns boolean
native LoadFrameHandle takes hashtable table, integer parentKey, integer childKey returns framehandle
native BlzEnableSelections takes boolean enableSelection, boolean enableSelectionCircle returns nothing
native BlzIsSelectionEnabled takes nothing returns boolean
native BlzIsSelectionCircleEnabled takes nothing returns boolean
native BlzCameraSetupApplyForceDurationSmooth takes camerasetup whichSetup, boolean doPan, real forcedDuration, real easeInDuration, real easeOutDuration, real smoothFactor returns nothing
native BlzEnableTargetIndicator takes boolean enable returns nothing
native BlzIsTargetIndicatorEnabled takes nothing returns boolean
native BlzEnableUIAutoPosition takes boolean enable returns nothing
native BlzConvertColor takes integer a, integer r, integer g, integer b returns integer
native BlzFrameAddText takes framehandle frame, string text returns nothing
native BlzFrameSetTextSizeLimit takes framehandle frame, integer size returns nothing
native BlzFrameGetTextSizeLimit takes framehandle frame returns integer
native BlzFrameSetTextColor takes framehandle frame, integer color returns nothing
native BlzFrameSetFocus takes framehandle frame, boolean flag returns nothing
native BlzFrameSetModel takes framehandle frame, string modelFile, integer cameraIndex returns nothing
native BlzFrameGetEnable takes framehandle frame returns boolean
native BlzFrameGetAlpha takes framehandle frame returns integer
native BlzFrameSetSpriteAnimate takes framehandle frame, integer primaryProp, integer flags returns nothing
native BlzFrameCageMouse takes framehandle frame, boolean enable returns nothing
native BlzFrameSetMinMaxValue takes framehandle frame, real minValue, real maxValue returns nothing
native BlzFrameSetStepSize takes framehandle frame, real stepSize returns nothing
native BlzFrameSetVertexColor takes framehandle frame, integer color returns nothing
native BlzFrameSetLevel takes framehandle frame, integer level returns nothing
native BlzFrameSetParent takes framehandle frame, framehandle parent returns nothing
native BlzFrameGetHeight takes framehandle frame returns real
native BlzFrameGetWidth takes framehandle frame returns real
native BlzFrameSetFont takes framehandle frame, string fileName, real height, integer flags returns nothing
native BlzFrameSetTextAlignment takes framehandle frame, textaligntype vert, textaligntype horz returns nothing
native BlzGetTriggerFrameValue takes nothing returns real
native BlzGetTriggerFrameText takes nothing returns string
native BlzTriggerRegisterPlayerSyncEvent takes trigger whichTrigger, player whichPlayer, string prefix, boolean fromServer returns event
native BlzSendSyncData takes string prefix, string data returns boolean
native BlzGetTriggerSyncPrefix takes nothing returns string
native BlzGetTriggerSyncData takes nothing returns string
native BlzTriggerRegisterPlayerKeyEvent takes trigger whichTrigger, player whichPlayer, oskeytype key, integer metaKey, boolean keyDown returns event
native BlzGetTriggerPlayerKey takes nothing returns oskeytype
native BlzGetTriggerPlayerMetaKey takes nothing returns integer
native BlzGetTriggerPlayerIsKeyDown takes nothing returns boolean
native BlzEnableCursor takes boolean enable returns nothing
native BlzSetMousePos takes integer x, integer y returns nothing
native BlzGetLocalClientWidth takes nothing returns integer
native BlzGetLocalClientHeight takes nothing returns integer
native BlzIsLocalClientActive takes nothing returns boolean
native BlzGetMouseFocusUnit takes nothing returns unit
native BlzGetLocale takes nothing returns string
native BlzGetSpecialEffectScale takes effect whichEffect returns real
native BlzSetSpecialEffectMatrixScale takes effect whichEffect, real x, real y, real z returns nothing
native BlzResetSpecialEffectMatrix takes effect whichEffect returns nothing
native BlzDisplayChatMessage takes player whichPlayer, integer recipient, string message returns nothing
native BlzPauseUnitEx takes unit whichUnit, boolean flag returns nothing
native BlzBitOr takes integer x, integer y returns integer
native BlzBitAnd takes integer x, integer y returns integer
native BlzBitXor takes integer x, integer y returns integer
native BlzGetAbilityBooleanLevelArrayField takes ability whichAbility, abilitybooleanlevelarrayfield whichField, integer level, integer index returns boolean
native BlzGetAbilityIntegerLevelArrayField takes ability whichAbility, abilityintegerlevelarrayfield whichField, integer level, integer index returns integer
native BlzGetAbilityRealLevelArrayField takes ability whichAbility, abilityreallevelarrayfield whichField, integer level, integer index returns real
native BlzGetAbilityStringLevelArrayField takes ability whichAbility, abilitystringlevelarrayfield whichField, integer level, integer index returns string
native BlzSetAbilityBooleanLevelArrayField takes ability whichAbility, abilitybooleanlevelarrayfield whichField, integer level, integer index, boolean value returns boolean
native BlzSetAbilityIntegerLevelArrayField takes ability whichAbility, abilityintegerlevelarrayfield whichField, integer level, integer index, integer value returns boolean
native BlzSetAbilityRealLevelArrayField takes ability whichAbility, abilityreallevelarrayfield whichField, integer level, integer index, real value returns boolean
native BlzSetAbilityStringLevelArrayField takes ability whichAbility, abilitystringlevelarrayfield whichField, integer level, integer index, string value returns boolean
native BlzAddAbilityBooleanLevelArrayField takes ability whichAbility, abilitybooleanlevelarrayfield whichField, integer level, boolean value returns boolean
native BlzAddAbilityIntegerLevelArrayField takes ability whichAbility, abilityintegerlevelarrayfield whichField, integer level, integer value returns boolean
native BlzAddAbilityRealLevelArrayField takes ability whichAbility, abilityreallevelarrayfield whichField, integer level, real value returns boolean
native BlzAddAbilityStringLevelArrayField takes ability whichAbility, abilitystringlevelarrayfield whichField, integer level, string value returns boolean
native BlzRemoveAbilityBooleanLevelArrayField takes ability whichAbility, abilitybooleanlevelarrayfield whichField, integer level, boolean value returns boolean
native BlzRemoveAbilityIntegerLevelArrayField takes ability whichAbility, abilityintegerlevelarrayfield whichField, integer level, integer value returns boolean
native BlzRemoveAbilityRealLevelArrayField takes ability whichAbility, abilityreallevelarrayfield whichField, integer level, real value returns boolean
native BlzRemoveAbilityStringLevelArrayField takes ability whichAbility, abilitystringlevelarrayfield whichField, integer level, string value returns boolean
native BlzItemAddAbility takes item whichItem, integer abilCode returns boolean
native BlzItemRemoveAbility takes item whichItem, integer abilCode returns boolean

// --- natives added in 1.32 (Reforged) -----------------------------------
native MathRound takes real r returns integer
native TriggerRegisterCommandEvent takes trigger whichTrigger, integer whichAbility, string order returns event
native TriggerRegisterUpgradeCommandEvent takes trigger whichTrigger, integer whichUpgrade returns event
native BlzGetAbsorbingItem takes nothing returns item
native BlzGetManipulatedItemWasAbsorbed takes nothing returns boolean
native BlzGetStackingItemSource takes nothing returns item
native BlzGetStackingItemTarget takes nothing returns item
native BlzGetStackingItemTargetPreviousCharges takes nothing returns integer
native GetPlayerHandicapReviveTime takes player whichPlayer returns real
native GetPlayerHandicapDamage takes player whichPlayer returns real
native SetPlayerHandicapReviveTime takes player whichPlayer, real handicap returns nothing
native SetPlayerHandicapDamage takes player whichPlayer, real handicap returns nothing
native SetMaxCheckpointSaves takes integer maxCheckpointSaves returns nothing
native SaveGameCheckpoint takes string saveFileName, boolean showWindow returns nothing
native SetPortraitLight takes string portraitDNCFile returns nothing
native CreateMinimapIconOnUnit takes unit whichUnit, integer red, integer green, integer blue, string pingPath, fogstate fogVisibility returns minimapicon
native CreateMinimapIconAtLoc takes location where, integer red, integer green, integer blue, string pingPath, fogstate fogVisibility returns minimapicon
native CreateMinimapIcon takes real x, real y, integer red, integer green, integer blue, string pingPath, fogstate fogVisibility returns minimapicon
native SkinManagerGetLocalPath takes string key returns string
native DestroyMinimapIcon takes minimapicon pingId returns nothing
native SetMinimapIconVisible takes minimapicon whichMinimapIcon, boolean visible returns nothing
native SetMinimapIconOrphanDestroy takes minimapicon whichMinimapIcon, boolean doDestroy returns nothing
native BlzCameraSetupSetLabel takes camerasetup whichSetup, string label returns nothing
native BlzCameraSetupGetLabel takes camerasetup whichSetup returns string
native CameraSetFocalDistance takes real distance returns nothing
native CameraSetDepthOfFieldScale takes real scale returns nothing
native SetCinematicAudio takes boolean cinematicAudio returns nothing
native StartSoundEx takes sound soundHandle, boolean fadeIn returns nothing
native SetThematicMusicVolume takes integer volume returns nothing
native SetSoundFacialAnimationLabel takes sound soundHandle, string animationLabel returns boolean
native SetSoundFacialAnimationGroupLabel takes sound soundHandle, string groupLabel returns boolean
native SetSoundFacialAnimationSetFilepath takes sound soundHandle, string animationSetFilepath returns boolean
native SetDialogueSpeakerNameKey takes sound soundHandle, string speakerName returns boolean
native GetDialogueSpeakerNameKey takes sound soundHandle returns string
native SetDialogueTextKey takes sound soundHandle, string dialogueText returns boolean
native GetDialogueTextKey takes sound soundHandle returns string
native BlzHideCinematicPanels takes boolean enable returns nothing
native BlzGetEventIsAttack takes nothing returns boolean
native BlzShowTerrain takes boolean show returns nothing
native BlzShowSkyBox takes boolean show returns nothing
native BlzStartRecording takes integer fps returns nothing
native BlzEndRecording takes nothing returns nothing
native BlzShowUnitTeamGlow takes unit whichUnit, boolean show returns nothing
native BlzFrameGetChildrenCount takes framehandle frame returns integer
native BlzFrameGetChild takes framehandle frame, integer index returns framehandle
native CreateCommandButtonEffect takes integer abilityId, string order returns commandbuttoneffect
native CreateUpgradeCommandButtonEffect takes integer whichUprgade returns commandbuttoneffect
native CreateLearnCommandButtonEffect takes integer abilityId returns commandbuttoneffect
native DestroyCommandButtonEffect takes commandbuttoneffect whichEffect returns nothing
native BlzGetItemSkin takes item whichItem returns integer
native BlzSetItemSkin takes item whichItem, integer skinId returns nothing
native BlzGetPlayerTownHallCount takes player whichPlayer returns integer
native BlzQueueImmediateOrderById takes unit whichUnit, integer order returns boolean
native BlzQueuePointOrderById takes unit whichUnit, integer order, real x, real y returns boolean
native BlzQueueTargetOrderById takes unit whichUnit, integer order, widget targetWidget returns boolean
native BlzQueueInstantPointOrderById takes unit whichUnit, integer order, real x, real y, widget instantTargetWidget returns boolean
native BlzQueueInstantTargetOrderById takes unit whichUnit, integer order, widget targetWidget, widget instantTargetWidget returns boolean
native BlzQueueBuildOrderById takes unit whichPeon, integer unitId, real x, real y returns boolean
native BlzQueueNeutralImmediateOrderById takes player forWhichPlayer, unit neutralStructure, integer unitId returns boolean
native BlzQueueNeutralPointOrderById takes player forWhichPlayer, unit neutralStructure, integer unitId, real x, real y returns boolean
native BlzQueueNeutralTargetOrderById takes player forWhichPlayer, unit neutralStructure, integer unitId, widget target returns boolean
native BlzGetUnitOrderCount takes unit whichUnit returns integer
native BlzUnitClearOrders takes unit whichUnit, boolean onlyQueued returns nothing
native BlzUnitForceStopOrder takes unit whichUnit, boolean clearQueue returns nothing

// --- natives added in 2.0 / 3.0 (the Forsaken Kingdom update) -----------
native SetPlayerRaceSkin takes player whichPlayer, racepreference whichRacePreference returns nothing
native GetEquippedItem takes nothing returns item
native BlzGetEquippedItem takes nothing returns item
native GetUnequippedItem takes nothing returns item
native BlzGetUnequippedItem takes nothing returns item
native BlzTriggerIsRunning takes trigger whichTrigger returns boolean
native BlzTriggerInterrupt takes trigger whichTrigger returns nothing
native SetDestructableColor takes destructable d, playercolor color returns nothing
native SetItemColor takes item whichItem, playercolor whichColor returns nothing
native BlzSetItemColor takes item whichItem, playercolor whichColor returns nothing
native IsItemEquipped takes item whichItem returns boolean
native BlzIsItemEquipped takes item whichItem returns boolean
native IsItemInBag takes item whichItem returns boolean
native BlzIsItemInBag takes item whichItem returns boolean
native GetItemEquipmentType takes item whichItem returns equipmentType
native BlzGetItemEquipmentType takes item whichItem returns equipmentType
native GetItemTag takes item whichItem returns itemTag
native BlzGetItemTag takes item whichItem returns itemTag
native AllowHeroGlowOnUnit takes unit whichUnit returns nothing
native DisallowHeroGlowOnUnit takes unit whichUnit returns nothing
native HeroGlowIsAllowedOnUnit takes unit whichUnit returns boolean
native BlzGetUnitAnimationDuration takes unit whichUnit, string whichAnimation returns real
native BlzGetUnitAnimationDurationByIndex takes unit whichUnit, integer index returns real
native UnitEquipItem takes unit whichUnit, item whichItem returns boolean
native BlzUnitEquipItem takes unit whichUnit, item whichItem returns boolean
native UnitUnequipItem takes unit whichUnit, item whichItem returns nothing
native BlzUnitUnequipItem takes unit whichUnit, item whichItem returns nothing
native UnitUnequipItemFromSlot takes unit whichUnit, loadoutslot slot returns item
native BlzUnitUnequipItemFromSlot takes unit whichUnit, loadoutslot slot returns item
native UnitHasItemBagged takes unit whichUnit, item whichItem returns boolean
native BlzUnitHasItemBagged takes unit whichUnit, item whichItem returns boolean
native UnitExtendedInventorySize takes unit whichUnit returns integer
native BlzUnitExtendedInventorySize takes unit whichUnit returns integer
native UnitItemInBagSlot takes unit whichUnit, integer itemSlot returns item
native BlzUnitItemInBagSlot takes unit whichUnit, integer itemSlot returns item
native UnitItemInEquipmentSlot takes unit whichUnit, loadoutslot itemSlot returns item
native BlzUnitItemInEquipmentSlot takes unit whichUnit, loadoutslot itemSlot returns item
native UnitHasItemEquipped takes unit whichUnit, item whichItem returns boolean
native BlzUnitHasItemEquipped takes unit whichUnit, item whichItem returns boolean
native UnitHasLoadoutSlotEmpty takes unit whichUnit, loadoutslot itemSlot returns boolean
native BlzUnitHasLoadoutSlotEmpty takes unit whichUnit, loadoutslot itemSlot returns boolean
native UnitHasAnyItemEquiped takes unit whichUnit returns boolean
native BlzUnitHasAnyItemEquipped takes unit whichUnit returns boolean
native UnitHasItemEquipmentOfType takes unit whichUnit, equipmentType equipmentId returns boolean
native BlzUnitHasItemEquipmentOfType takes unit whichUnit, equipmentType equipmentId returns boolean
native UnitCanEquipItemOfEquipmentType takes unit whichUnit, equipmentType equipmentId returns boolean
native BlzUnitCanEquipItemOfEquipmentType takes unit whichUnit, equipmentType equipmentId returns boolean
native BlzUnitIsAlive takes unit whichUnit returns boolean
native BlzUnitHeal takes unit whichUnit, unit source, real life, boolean isItem, boolean applyStatBonuses returns real
native BlzResetUnitTalents takes unit whichUnit returns nothing
native ChooseRandomItemExWithFilter takes itemtype whichType, integer level, equipmentType whichEquipmentType, itemTag whichTag returns integer
native ChooseRandomItemExWithFilterAndIncludes takes itemtype whichType, integer level, equipmentType whichEquipmentType, itemTag whichTag, boolean includeInvalidMorphs, boolean includeNonPickRandom returns integer
native SetTerrainFogExV takes integer style, real zstart, real zend, real density, real heightStart, real heightEnd, real linearStart, real linearEnd, real red, real green, real blue returns nothing
native BlzSetTerrainFogStyle takes fogstyle style returns nothing
native BlzSetTerrainFogZStart takes real zStart returns nothing
native BlzSetTerrainFogZEnd takes real ZEnd returns nothing
native BlzSetTerrainFogDensity takes real density returns nothing
native BlzSetTerrainFogHeightStart takes real heightStart returns nothing
native BlzSetTerrainFogHeightEnd takes real heightEnd returns nothing
native BlzSetTerrainFogLinearStart takes real linearStart returns nothing
native BlzSetTerrainFogLinearEnd takes real linearEnd returns nothing
native BlzSetTerrainFogMaxLinearDensity takes real maxLinearDensity returns nothing
native BlzSetTerrainFogDrawOverSky takes boolean drawOverSky returns nothing
native BlzSetTerrainFogColor takes real red, real green, real blue returns nothing
native BlzGetModelCinematicGameShotCount takes nothing returns integer
native BlzGetModelCinematicGameCurrentShot takes nothing returns integer
native BlzGetModelCinematicGameRemainingTime takes nothing returns real
native BlzPlayModelCinematicGameAtPosition takes string modelName, real posX, real posY, real posZ, real RotZ returns nothing
native BlzSetCinematicEnabledDE takes boolean enable returns nothing
native BlzSetMinShadowCastingPointLightCount takes integer count returns nothing
native BlzGetMinShadowCastingPointLightCount takes nothing returns integer
native BlzGetHUDScale takes nothing returns real
native BlzSetHUDScale takes integer percentage returns nothing
native BlzLockHUDScale takes nothing returns nothing
native BlzUnlockHUDScale takes nothing returns nothing
native SetCameraFieldControlledByInput takes camerafield whichField, boolean controlled returns nothing
native GetCameraFieldControlledByInput takes camerafield whichField returns boolean
native BlzGetCameraAllowsHotkeyTargetLock takes nothing returns boolean
native BlzSetCameraAllowsHotkeyTargetLock takes boolean allows returns nothing
native BlzCameraSetCameraType takes integer cameraType returns nothing
native BlzCameraGetCameraType takes nothing returns integer
native BlzCameraSetupSetCameraType takes camerasetup whichSetup, integer cameraType returns nothing
native BlzCameraSetupGetCameraType takes camerasetup whichSetup returns integer
native EnableCameraBlocker takes rect r, boolean flag returns nothing
native AddCameraBlocker takes rect where returns nothing
native BlzPauseThematicMusicOnFocusLost takes boolean pause returns nothing
native BlzSetThematicMusicAbsoluteVolume takes integer volume returns nothing
native BlzRemoveEffect takes effect whichEffect returns nothing
native SetHDWaterParams takes integer red, integer green, integer blue, boolean useColor, integer vertexDisplacement, integer minOpacity, integer maxOpacity, integer reflectivity, integer emissivity, integer edgeSoftness, integer waveStrength returns nothing
native SetHDWaterParamsEx takes integer red, integer green, integer blue, boolean override, integer vertexDisplacement, integer minOpacity, integer maxOpacity, integer reflectivity, integer emissivity, integer edgeSoftness, integer waveStrength, integer envMapStrength returns nothing
native BlzSetHDWaterColor takes integer red, integer green, integer blue returns nothing
native BlzSetHDWaterColorOverride takes boolean override returns nothing
native BlzSetHDWaterVertexDisplacement takes integer vertexDisplacement returns nothing
native BlzSetHDWaterMinOpacity takes integer minOpacity returns nothing
native BlzSetHDWaterMaxOpacity takes integer maxOpacity returns nothing
native BlzSetHDWaterReflectivity takes integer reflectivity returns nothing
native BlzSetHDWaterEmissivity takes integer emissivity returns nothing
native BlzSetHDWaterEdgeSoftness takes integer edgeSoftness returns nothing
native BlzSetHDWaterWaveStrength takes integer waveStrength returns nothing
native BlzSetHDWaterEnvMapStrength takes integer envMapStrengthy returns nothing
native BlzIsTerrainPathableEx takes real x, real y, pathingtype t returns boolean
native BlzSetSingleDoodadAnimation takes integer index, string animName, boolean animRandom returns nothing
native SetDoodadColor takes real x, real y, real radius, integer doodadID, boolean nearestOnly, playercolor whichColor returns nothing
native SetDoodadColorRect takes rect r, integer doodadID, playercolor whichColor returns nothing
native BlzSetSingleDoodadColor takes integer index, playercolor whichColor returns nothing
native BlzGetDoodadX takes integer index returns real
native BlzGetDoodadY takes integer index returns real
native BlzGetDoodadZ takes integer index returns real
native BlzGetDoodadScaleX takes integer index returns real
native BlzGetDoodadScaleY takes integer index returns real
native BlzGetDoodadScaleZ takes integer index returns real
native BlzGetDoodadIsUsingModelAxes takes integer index returns boolean
native BlzGetDoodadYaw takes integer index returns real
native BlzGetDoodadPitch takes integer index returns real
native BlzGetDoodadRoll takes integer index returns real
native BlzGetDoodadVariation takes integer index returns integer
native BlzGetDoodadId takes integer index returns integer
native BlzGetNumDoodads takes nothing returns integer
native BlzResetUnitAttack takes unit whichUnit, integer weaponIndex returns nothing
native BlzSetSpecialEffectAnimationBlendTime takes effect whichEffect, real blendTime returns nothing
native BlzQueueSpecialEffectAnimation takes effect whichEffect, string whichAnimation returns nothing
native BlzSetSpecialEffectAnimation takes effect whichEffect, string whichAnimation returns nothing
native BlzUnitEnableAuras takes unit whichUnit, boolean enable, boolean affectsUI returns nothing
native BlzGetUnitAbilityCooldownPercent takes unit whichUnit, integer abilId returns real
native BlzSetUnitAbilityCooldownRemaining takes unit whichUnit, integer abilId, real duration returns nothing
native BlzSetUnitAbilityCooldownPercent takes unit whichUnit, integer abilId, real percent returns nothing
native BlzAdjustUnitAbilityCooldownRemaining takes unit whichUnit, integer abilId, real duration returns nothing
native BlzAdjustUnitAbilityCooldownPercent takes unit whichUnit, integer abilId, real percent returns nothing
native BlzTextAreaFrameSetAutoScroll takes framehandle frame, boolean value returns nothing
native BlzIsMetaKeyPressed takes integer metakey returns boolean
native BlzIsKeyPressed takes oskeytype key returns boolean
native BlzIsMouseButtonPressed takes mousebuttontype mouseButtonType returns boolean
native BlzGetMouseScreenPosX takes nothing returns integer
native BlzGetMouseScreenPosY takes nothing returns integer
native BlzPixelToFrameX takes integer pixelX returns real
native BlzPixelToFrameY takes integer pixelY returns real
native BlzFrameToPixelX takes real frameX returns integer
native BlzFrameToPixelY takes real frameY returns integer
native BlzCreateDestructablePitchRoll takes integer objectid, real x, real y, real face, real roll, real pitch, real scale, integer variation returns destructable
native BlzCreateDestructableZPitchRoll takes integer objectid, real x, real y, real z, real face, real roll, real pitch, real scale, integer variation returns destructable
native BlzCreateDeadDestructablePitchRoll takes integer objectid, real x, real y, real face, real roll, real pitch, real scale, integer variation returns destructable
native BlzCreateDeadDestructableZPitchRoll takes integer objectid, real x, real y, real z, real face, real roll, real pitch, real scale, integer variation returns destructable
native BlzCreateDestructableWithSkinPitchRoll takes integer objectid, real x, real y, real face, real roll, real pitch, real scale, integer variation, integer skinId returns destructable
native BlzCreateDestructableZWithSkinPitchRoll takes integer objectid, real x, real y, real z, real face, real roll, real pitch, real scale, integer variation, integer skinId returns destructable
native BlzCreateDeadDestructableWithSkinPitchRoll takes integer objectid, real x, real y, real face, real roll, real pitch, real scale, integer variation, integer skinId returns destructable
native BlzCreateDeadDestructableZWithSkinPitchRoll takes integer objectid, real x, real y, real z, real face, real roll, real pitch, real scale, integer variation, integer skinId returns destructable
native BlzCreateDestructableWithColor takes integer objectid, real x, real y, real face, real scale, integer variation, playercolor color returns destructable
native BlzCreateDestructableZWithColor takes integer objectid, real x, real y, real z, real face, real scale, integer variation, playercolor color returns destructable
native BlzCreateDeadDestructableWithColor takes integer objectid, real x, real y, real face, real scale, integer variation, playercolor color returns destructable
native BlzCreateDeadDestructableZWithColor takes integer objectid, real x, real y, real z, real face, real scale, integer variation, playercolor color returns destructable
native BlzCreateDestructableWithSkinColor takes integer objectid, real x, real y, real face, real scale, integer variation, integer skinId, playercolor color returns destructable
native BlzCreateDestructableZWithSkinColor takes integer objectid, real x, real y, real z, real face, real scale, integer variation, integer skinId, playercolor color returns destructable
native BlzCreateDeadDestructableWithSkinColor takes integer objectid, real x, real y, real face, real scale, integer variation, integer skinId, playercolor color returns destructable
native BlzCreateDeadDestructableZWithSkinColor takes integer objectid, real x, real y, real z, real face, real scale, integer variation, integer skinId, playercolor color returns destructable
native BlzCreateDestructablePitchRollWithColor takes integer objectid, real x, real y, real face, real roll, real pitch, real scale, integer variation, playercolor color returns destructable
native BlzCreateDestructableZPitchRollWithColor takes integer objectid, real x, real y, real z, real face, real roll, real pitch, real scale, integer variation, playercolor color returns destructable
native BlzCreateDeadDestructablePitchRollWithColor takes integer objectid, real x, real y, real face, real roll, real pitch, real scale, integer variation, playercolor color returns destructable
native BlzCreateDeadDestructableZPitchRollWithColor takes integer objectid, real x, real y, real z, real face, real roll, real pitch, real scale, integer variation, playercolor color returns destructable
native BlzCreateDestructableWithSkinPitchRollColor takes integer objectid, real x, real y, real face, real roll, real pitch, real scale, integer variation, integer skinId, playercolor color returns destructable
native BlzCreateDestructableZWithSkinPitchRollColor takes integer objectid, real x, real y, real z, real face, real roll, real pitch, real scale, integer variation, integer skinId, playercolor color returns destructable
native BlzCreateDeadDestructableWithSkinPitchRollColor takes integer objectid, real x, real y, real face, real roll, real pitch, real scale, integer variation, integer skinId, playercolor color returns destructable
native BlzCreateDeadDestructableZWithSkinPitchRollColor takes integer objectid, real x, real y, real z, real face, real roll, real pitch, real scale, integer variation, integer skinId, playercolor color returns destructable
native SetDestructableVertexColor takes destructable whichDestructable, integer red, integer green, integer blue, integer alpha returns nothing
`;
