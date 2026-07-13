import type { FdfScreen } from "./fdf/render";
import type { GlueChrome, MenuScene } from "../render/menuScene";

// The glue-screen manager (issue #61): one screen on the menu at a time, and the
// transition between them.
//
// The reference's transition, in order:
//   1. a menu button is clicked → EVERY control on every panel goes dead, so a second
//      click can't land while the screen is leaving;
//   2. the panels slide up and off the top of the screen (and the panel CHROME plays its
//      own "<Screen> Death" clip in the 3D layer — the two leave together);
//   3. a short beat with nothing on screen;
//   4. the new screen's panels come back DOWN into place, over its "<Screen> Birth".
//
// Steps 2 and 4 are timed from the CHROME's own sequence lengths (menuScene.chromeTiming),
// so the DOM panels and the model that frames them are never out of step — no hand-picked
// durations to drift apart.

/** The beat between one screen leaving and the next arriving. */
const GAP_MS = 120;

/** A screen that can be built on demand — the manager mounts it only when navigated to. */
export interface GlueScreenDef {
  /** Which of the panel model's chrome sets this screen wears. */
  chrome: GlueChrome;
  /** Build the FDF screen. Its panels must be parked off-screen by the caller, not here. */
  mount(): Promise<FdfScreen>;
}

export class GlueManager {
  private current: FdfScreen | null = null;
  private busy = false;

  constructor(private scene: MenuScene | null) {}

  /** The scene may be built after the manager (it needs the VFS); re-point it here. */
  setScene(scene: MenuScene | null): void { this.scene = scene; }

  /** Put the first screen up with no transition (boot: the main menu is simply there). */
  async show(def: GlueScreenDef): Promise<FdfScreen> {
    this.current?.dispose();
    this.current = await def.mount();
    return this.current;
  }

  /**
   * Leave the current screen and arrive at `def`. Resolves once the new screen is in
   * place. Re-entrant calls are dropped: while the panels are moving the screen is dead
   * anyway, and a queued second transition would land the player somewhere they never
   * chose.
   */
  async goTo(def: GlueScreenDef): Promise<FdfScreen | null> {
    if (this.busy) return null;
    this.busy = true;
    const leaving = this.current;
    try {
      // Build the next screen BEFORE tearing the current one down. If its FDF is missing or
      // malformed this throws, and the player keeps the menu they were on instead of being
      // left staring at a blank 3D background with no way back.
      const next = await def.mount();
      next.setInteractive(false); // dead until it has actually landed
      next.element.style.visibility = "hidden"; // …and unseen until the old screen has left

      if (leaving) {
        leaving.setInteractive(false);
        // The chrome leaves at the same moment, and tells us how long it takes.
        const death = this.scene?.playChromeDeath() ?? 0;
        await leaving.animatePanels("out", death || 500);
        leaving.dispose();
        await wait(GAP_MS);
      }

      this.current = next;
      next.element.style.visibility = "";
      const birth = this.scene?.playChromeBirth(def.chrome) ?? 0;
      // animatePanels("in") parks the panels above the screen in this same task, so they
      // never paint in place first — the entrance always starts from off-screen.
      await next.animatePanels("in", birth || 700);
      next.setInteractive(true);
      return next;
    } catch (err) {
      console.error("[OpenWar3] couldn't open that menu:", err);
      leaving?.setInteractive(true); // give the player their screen back
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** The screen currently on the menu (null while nothing is mounted). */
  get screen(): FdfScreen | null { return this.current; }

  dispose(): void {
    this.current?.dispose();
    this.current = null;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
