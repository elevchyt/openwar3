// AZEROTH GRAND PRIX — what Computer+ knows about Blizzard's kart-racing map
// (`Maps\FrozenThrone\Scenario\(8)AzerothGrandPrix.w3x`). Read docs/grand-prix-ai.md first.
//
// Everything here is the MAP's: an id, a number or a rule read off its `war3map.j`, `war3map.w3u`
// and `war3map.w3a`, named beside the trigger or object it came from. Nothing here is a tuning
// value — those are profile.ts's, and they are ours. tools/ai-plus-grandprix-test.cjs reads the
// running script's own globals back and compares them against this file, so a table that drifted
// from the map fails there rather than in a race.

/** The script globals that say "this is Azeroth Grand Prix" — four of the map's own triggers, so
 *  a renamed copy is still recognised and a different map named the same is not. */
export const GRAND_PRIX_SCRIPT_MARKERS = [
  "gg_trg_Move_Cart", "gg_trg_Pick_Cart", "gg_trg_Init_Place_Check_Points", "gg_trg_Throw_Turtle_Timer",
] as const;

export function isGrandPrixScript(globals: { has(name: string): boolean }): boolean {
  return GRAND_PRIX_SCRIPT_MARKERS.every((name) => globals.has(name));
}

/** The racers: `udg_PLAYER_MAXNUM` = 8, Player(0)…Player(7). Every loop in the script walks them. */
export const RACER_SEATS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6, 7]);

/**
 * The four keys the whole map is driven by, as common.j numbers them: `EVENT_PLAYER_ARROW_LEFT_DOWN`
 * = 261, its `_UP` = 262, then RIGHT, DOWN and UP the same way. The script registers all eight for
 * every racer through `TriggerRegisterPlayerKeyEventBJ` (`Turning_Left`, `Turning_Left_Released`,
 * … `Deceleration_Stop`) and listens to nothing else for the driving.
 */
export const ARROW = { left: 261, right: 263, down: 265, up: 267 } as const;
export type ArrowKey = keyof typeof ARROW;

/** `udg_GameGoingStatus[player]` (InitGlobals): where a racer is in the match. */
export const STATUS = { picking: 0, preparing: 1, driving: 2, repairing: 3, finishing: 4, over: 5, left: 6 } as const;

/**
 * THE PICKER. `PreparePickingCartPlayer` stands one cart in front of each racer; its card is
 * Previous (`A002`), Next (`A00S`) and a Select of its own, and `Trig_Pick_Cart` takes the cart
 * the pressed Select is ON. `udg_PickCartTimer` (30 s) takes whatever is showing for anybody who
 * has not chosen. The four carts (war3map.w3u `uabi`):
 */
export const PICK_SELECT: Readonly<Record<string, string>> = {
  h00B: "A00W", // Diablo's
  h001: "A00V", // the Orc's
  h007: "A00U", // the Undead's
  h009: "A00Z", // the Dwarf's
};
export const PICK_NEXT = "A00S";

/** The racing bodies those become (`udg_Models`, `GetModelUnitType`). */
export const CART_TYPES: ReadonlySet<string> = new Set(["h000", "h002", "h004", "h008"]);

/**
 * THE CART'S PHYSICS (`Trig_Move_Cart_Actions`, every `udg_DrivingTimer` = 0.05 s):
 *
 *   speed += ±accel (twice that against the way it is rolling), − drag, capped at the model's top;
 *   angle  = facing ± 3° while a turn key is held and the cart is moving at all (`CalcDirection`:
 *            `GetModelTurnRate` is 1 for every model, × 3);
 *   the cart is SET `speed / 3` further along that angle (`RealSpeed`), if the ground there is
 *   cliff level 4 (`IsValidLocForVehicle`) — else it stops dead (`StopCart`).
 *
 * So the number on the speedometer is three times the distance a tick covers, a cart turns 60° a
 * second whatever its speed, and its turning CIRCLE therefore grows with its speed: flat out
 * (205 → 1367 world units a second) it is 1300 across the radius, which is wider than the track.
 * Braking for a corner is not style here, it is the only way round one.
 */
export const TICK = 0.05;
export const TURN_DEG_PER_TICK = 3;
/** World units a second per point of speedometer: `/ 3` a tick, 20 ticks a second. */
export const UNITS_PER_SPEED = 1 / 3 / TICK;
/** Radians a second a held turn key is worth. */
export const TURN_RATE = (TURN_DEG_PER_TICK * Math.PI) / 180 / TICK;
/** `IsValidLocForVehicle`: the track is the ground at this cliff level and nothing else. */
export const TRACK_CLIFF_LEVEL = 4;
/** `udg_ModelAttributes[model * 4 + …]`: top speed, turn rate, acceleration, drag. */
export const MODEL_ATTR = { top: 0, turn: 1, accel: 2, drag: 3 } as const;
/** The slowest and the fastest top speed a model has (Dwarf 195 … Undead 210) — what a route's
 *  speed limits are computed against before a seat's own model is known. */
export const TOP_SPEED_MAX = 220;

/**
 * THE POWER-UPS (`Trig_Init_PowerUps`). A gift box (`n00C`) rolls one into the cart's first free
 * SLOT of four, and each power-up is FOUR abilities — one per slot — because a slot is a button
 * (A, S, D, F). `udg_CartPowerUps[player * 4 + slot]` holds the ability in each slot, 0 when empty;
 * pressing it is `Trig_Cart_Cast_Spell` → `CartUseSpell`. In the script's own order:
 */
export type PowerUp =
  | "repair" | "blaze" | "cloak" | "mine" | "sheepedo" | "trap"
  | "boost" | "rocket" | "blessing" | "lightning" | "blizzard" | "swarm";

export const POWER_UPS: ReadonlyArray<{ kind: PowerUp; name: string; abilities: readonly [string, string, string, string] }> = [
  { kind: "repair", name: "Repair Kit", abilities: ["A01Q", "A01R", "A01S", "A00B"] }, // +150 life, +25 ammo
  { kind: "blaze", name: "Blaze", abilities: ["A00E", "A01E", "A01F", "A01G"] }, // 4 s of fire laid behind the cart
  { kind: "cloak", name: "Ethereal Cloak", abilities: ["A00F", "A01L", "A01K", "A01M"] }, // invisible: nothing can aim at it
  { kind: "mine", name: "Mine", abilities: ["A01C", "A01B", "A00I", "A01D"] }, // dropped 100 behind
  { kind: "sheepedo", name: "Sheepedo", abilities: ["A01P", "A00J", "A01N", "A01O"] }, // thrown ahead, homes within ±90°
  { kind: "trap", name: "Web Trap", abilities: ["A01I", "A01H", "A01J", "A00K"] }, // dropped 100 behind
  { kind: "boost", name: "Engine Boost", abilities: ["A00C", "A016", "A015", "A017"] }, // top speed × 1.5 (`Bspe`)
  { kind: "rocket", name: "Specklefrogg's Rocket", abilities: ["A019", "A00G", "A01A", "A018"] }, // at whoever leads
  { kind: "blessing", name: "Uther's Blessing", abilities: ["A014", "A00N", "A013", "A012"] }, // 6 s invulnerable, × 1.3, spins what it touches
  { kind: "lightning", name: "Electric Justice", abilities: ["A00D", "A010", "A00X", "A011"] }, // every other visible cart
  { kind: "blizzard", name: "Blizzard", abilities: ["A024", "A025", "A026", "A027"] }, // 8 s, 500 wide, speed × 5 ahead
  { kind: "swarm", name: "Carrion Swarm", abilities: ["A022", "A021", "A023", "A020"] }, // a wave straight ahead
];

const POWER_UP_OF = new Map<string, PowerUp>(POWER_UPS.flatMap((p) => p.abilities.map((a) => [a, p.kind] as const)));

/** Which power-up an ability id is, or null for anything else on the card. */
export function powerUpOf(abilityId: string): PowerUp | null {
  return POWER_UP_OF.get(abilityId) ?? null;
}

/** The machine gun (`A01U`, on W): given to every cart 15 s after the picker closes
 *  (`ChargeBigGun`) with `udg_AMMO_MAX` = 50 rounds, 25 life a hit on the first cart inside a
 *  200-wide, 1500-long lane straight ahead (`BigGun`, `UnitCatchGunFire`). */
export const GUN = "A01U";
export const GUN_REACH = 1500;
export const GUN_HALF_WIDTH = 100;

/** A JASS rawcode integer as its four characters (`'A01Q'`), "" for 0. */
export function rawcode(n: number): string {
  if (!n) return "";
  return String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}
