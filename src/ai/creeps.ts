import type { AbilityRegistry } from "../data/abilities";
import type { Command } from "../game/commands";
import type { SimUnit, SimWorld } from "../sim/world";
import { AiCaster, CAST_PERIOD, type CasterView } from "./casting";

/**
 * When the map's OWN creeps press their buttons.
 *
 * Neutral Hostile has no script either — `Scripts\*.ai` are the four races' — and its casting
 * is the same `heroAbility`-object behaviour in `Game.dll` that the computer players' is (see
 * src/ai/casting.ts for where the rules come from). What the creeps add is not a different
 * chooser but a different GATE, and it is the one every player has felt: a creep camp does
 * nothing at all until it is in a fight. A Harpy Queen at rest does not Cyclone the Peasant
 * walking past her at 700 range, a Satyr Trickster does not Purge the Footman skirting his camp,
 * the Ogre Magi does not stand at home Bloodlusting his Ogres for something to do. Once the camp
 * is roused (SimWorld.creepInFight — it or a camp-mate is on somebody), the caster fights with
 * everything on its card exactly as a computer's would.
 *
 * Two halves, both the sim's machinery and neither a second copy of it:
 *
 *  * AUTOCASTS are armed and left to `SimWorld.tickAutocast`, which is also the creep's own
 *    "Heal the camp-mate who is hurt" out of combat. The `auto` column of `UnitAbilities.slk`
 *    already arms the Ogre Magi's Bloodlust, the Geomancer's Slow and the Troll Priest's Heal
 *    at birth (now that it is read as the base code it names — see `autoArmed`); arming the
 *    rest here is the thread's "their autocast doesn't have to be enabled for AIs", and it is
 *    what puts the frost on a Skeletal Marksman's arrows and the fire on a Burning Archer's.
 *  * DELIBERATE casts — Cyclone, Shockwave, War Stomp, Chain Lightning, Frost Nova, Ensnare
 *    (an autocast to the sim, so it goes the first way), Raise Dead — are `AiCaster.tryCast`
 *    with the creep view, once the fight is on.
 *
 * Everything leaves through the sim's own `issueCast`, gated by `castUseError`/`castError` as
 * a click is, so a creep can no more cast through magic immunity than a player can. It runs on
 * the authority's machine only (RtsController.tick's authority branch), like the melee AI.
 */
export class CreepCaster {
  private readonly caster: AiCaster;
  private readonly view: CreepView;
  private clock = 0;

  constructor(world: SimWorld, abilities: AbilityRegistry) {
    this.view = new CreepView(world, abilities);
    this.caster = new AiCaster(this.view);
  }

  tick(dt: number): void {
    this.clock += dt;
    if (this.clock < CAST_PERIOD) return;
    this.clock -= CAST_PERIOD;
    // Somebody to speak for the camps: `hostile` is a per-pair question in the sim and the
    // view answers it for the whole neutral side through one live creep. No creep, no pass.
    this.view.rep = null;
    for (const u of this.view.world.units.values()) {
      if (u.isCreep && u.hp > 0) {
        this.view.rep = u;
        break;
      }
    }
    if (!this.view.rep) return;
    this.caster.pass();
  }
}

/** The neutral side, as `AiCaster` wants to see a player. */
class CreepView implements CasterView {
  /** Every map-placed creep is owner -1 (see jassOwnerOf), which is the "player" the caster
   *  groups its own units by. Neutral PASSIVE units share the slot and pass through `pass()`
   *  as "own" too, harmlessly: a shop is a building (`canAct` refuses it) and a critter has no
   *  card, and neither is `isCreep` so `engaged` never lets one press anything. */
  readonly player = -1;
  rep: SimUnit | null = null;

  constructor(readonly world: SimWorld, private readonly abilities: AbilityRegistry) {}

  def(abilityId: string) {
    return this.abilities.get(abilityId);
  }

  /** A foe of the creeps: the sim's own directed `hostile`, asked from a live creep — so a
   *  player a map has set NEUTRAL toward Neutral Hostile (Rise of the Naga does, for its
   *  villagers) is not one, and a Goblin Merchant never is. */
  hostile(u: SimUnit): boolean {
    return this.rep !== null && u.owner !== -1 && this.world.hostile(this.rep, u);
  }

  /** A creep's mana is spent in a fight and nowhere else — and a creep's alone. A neutral
   *  unit the map made under a script is nobody's soldier either, but it is not a creep, and
   *  what it does with its buttons is the map's business. */
  engaged(u: SimUnit): boolean {
    return u.isCreep && !u.asleep && !u.returning && this.world.creepInFight(u);
  }

  order(cmd: Command): boolean {
    switch (cmd.c) {
      case "cast":
        return this.world.issueCast(cmd.unitId, cmd.code, cmd.targetId, cmd.x, cmd.y);
      case "autocast":
        return this.world.toggleAutocast(cmd.unitId, cmd.code);
      default:
        return false;
    }
  }
}
