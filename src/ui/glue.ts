import type { FdfScreen } from "./fdf/render";
import type { GlueChrome, MenuScene } from "../render/menuScene";

// The glue-screen manager (issue #61): one screen on the menu at a time, and the
// transition between them.
//
// The reference's transition, in order:
//   1. a menu button is clicked → EVERY button on the screen goes disabled (greyed, and
//      answering nothing), so a second click can't land while the screen is leaving;
//   2. the panel's CONTENTS (its buttons, labels, lists) fade out where they stand, and the
//      empty panel slides up and off the screen — that slide is the 3D chrome playing its
//      own "<Screen> Death" clip (render/menuScene.ts), not anything we author;
//   3. a short beat with nothing on screen;
//   4. the next screen's panel drops back in on its "<Screen> Birth", and its contents fade
//      up on it once it has landed.
//
// Steps 2 and 4 are timed from the CHROME's own sequence lengths, so the DOM and the model
// that carries it are never out of step — no hand-picked durations to drift apart.

/** The beat between one screen leaving and the next arriving. */
const GAP_MS = 120;

/** A screen that can be built on demand — the manager mounts it only when navigated to. */
export interface GlueScreenDef {
  /** Which of the panel model's chrome sets this screen wears. */
  chrome: GlueChrome;
  /** Build the FDF screen. Fading it in is the manager's job, not the screen's. */
  mount(): Promise<FdfScreen>;
}

export class GlueManager {
  private current: FdfScreen | null = null;
  private busy = false;

  constructor(private scene: MenuScene | null) {}

  /** The scene may be built after the manager (it needs the VFS); re-point it here. */
  setScene(scene: MenuScene | null): void { this.scene = scene; }

  /**
   * Put the first screen up. It ARRIVES like any other — the chrome plays its "<Screen> Birth"
   * (and with it the whoosh keyed into that clip's first frame), and the screen's contents fade
   * up on the panel as it lands. Only the LEAVING half is skipped, because there is nothing to
   * leave. Booting straight onto the Stand clip instead meant the game's very first menu was
   * the one menu that never animated in.
   */
  async show(def: GlueScreenDef): Promise<FdfScreen> {
    this.current?.dispose();
    const next = await def.mount();
    this.current = next;
    const birth = this.scene?.playChromeBirth(def.chrome) ?? 0;
    await next.animatePanels("in", birth || 700);
    return next;
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
    // Every button on the screen goes dead the moment one of them is clicked — BEFORE the
    // next screen is built below, which is an await and can take a moment (the Custom Game
    // screen loads four more .fdf files). Wait until after it and the buttons stay live for
    // that whole window, which is exactly when a second click must not land.
    leaving?.setAllDisabled(true);
    try {
      // Build the next screen BEFORE tearing the current one down. If its FDF is missing or
      // malformed this throws, and the player keeps the menu they were on instead of being
      // left staring at a blank 3D background with no way back.
      const next = await def.mount();
      next.setInteractive(false); // not clickable until it has landed — but not greyed either
      next.element.style.visibility = "hidden"; // …and unseen until the old screen has left

      if (leaving) {
        // The chrome leaves at the same moment, and tells us how long it takes.
        const death = this.scene?.playChromeDeath() ?? 0;
        await leaving.animatePanels("out", death || 500);
        leaving.dispose();
        await wait(GAP_MS);
      }

      this.current = next;
      next.element.style.visibility = "";
      const birth = this.scene?.playChromeBirth(def.chrome) ?? 0;
      // animatePanels("in") drops the contents to transparent in this same task, so they
      // never paint at full opacity for a frame before the panel that carries them arrives.
      await next.animatePanels("in", birth || 700);
      next.setInteractive(true);
      return next;
    } catch (err) {
      console.error("[OpenWar3] couldn't open that menu:", err);
      leaving?.setAllDisabled(false); // give the player their screen back
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
