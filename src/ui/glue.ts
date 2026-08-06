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

/**
 * How long the screen takes to go to black, and to come back off it, when the 3D scene behind
 * it CHANGES — arriving on a campaign screen from the menu's own Icecrown, or crossing from one
 * campaign's set to another.
 *
 * Every other glue transition is carried by the panel chrome: the old screen's frames slide off
 * on their Death clip and the new one's drop in on its Birth, and the 3D background behind them
 * never moves. A campaign screen has no chrome at all (see GlueScreenDef.backdrop), so a swap
 * there is one whole world cutting to another with nothing covering the join. Black is what
 * covers it.
 */
const FADE_MS = 260;

/** A screen that can be built on demand — the manager mounts it only when navigated to. */
export interface GlueScreenDef {
  /** Which of the panel model's chrome sets this screen wears. Ignored when `backdrop` is
   *  set: such a screen has none (see below). */
  chrome: GlueChrome;
  /**
   * A CAMPAIGN screen (issue #101): a full-screen 3D backdrop instead of panel chrome.
   *
   * The panel models carry a Birth/Stand/Death triple for every glue screen in the game
   * except this one — the reference hides the screen edges entirely and lets the campaign's
   * own scene fill the frame. So a screen with a backdrop skips the chrome clips: the model
   * named here plays its own Birth/Stand instead, under its own fog (render/menuScene.ts).
   */
  backdrop?: { path: string; fog: { r: number; g: number; b: number; start: number; end: number } };
  /** Build the FDF screen. Fading it in is the manager's job, not the screen's. */
  mount(): Promise<FdfScreen>;
  /**
   * Run once the screen's BACKGROUND is in place — which on a scene change is under the black,
   * before any of it is revealed.
   *
   * Anything the player would SEE change belongs here rather than in `mount`. `mount` runs while
   * the outgoing screen is still on display (it is built first so a failure leaves the player
   * where they were), so a cursor swapped there changes under the pointer on the screen being
   * left, seconds before the screen it belongs to appears.
   */
  onArrived?(): void;
}

/** How long a screen with no chrome takes to leave / arrive. The chrome's own clips time
 *  every other transition; a backdrop screen has none, so its contents cross-fade on the
 *  same beat the panel clips run to (≈0.7 s in, ≈0.5 s out — see the fallbacks below). */
const NO_CHROME_OUT_MS = 500;
const NO_CHROME_IN_MS = 700;

export class GlueManager {
  private current: FdfScreen | null = null;
  /** Whether the screen on screen is a backdrop one — it decides what leaving it does. */
  private backdropUp = false;
  private busy = false;
  /** The black the screen crosses through on a scene swap; built on first use. */
  private fade: HTMLElement | null = null;

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
    // Putting a first screen up re-opens the stack, which is the one thing that lifts the gate
    // `leave` deliberately left closed behind it (see there).
    this.busy = false;
    this.current?.dispose();
    const next = await def.mount();
    this.current = next;
    const birth = await this.arrive(def);
    await next.animatePanels("in", birth || NO_CHROME_IN_MS);
    return next;
  }

  /** Bring `def`'s background in — a campaign backdrop, or the panel chrome's Birth — and
   *  say how long it takes. Restoring the menu's own background when a backdrop screen is
   *  what we are LEAVING happens here too, so the two can never get out of step. */
  private async arrive(def: GlueScreenDef): Promise<number> {
    if (def.backdrop) {
      await this.scene?.showBackdrop(def.backdrop.path, def.backdrop.fog);
      this.backdropUp = true;
      def.onArrived?.();
      return 0; // the backdrop's own Birth runs behind the screen; the DOM doesn't wait on it
    }
    if (this.backdropUp) this.scene?.restoreMenuBackground();
    this.backdropUp = false;
    const birth = this.scene?.playChromeBirth(def.chrome) ?? 0;
    def.onArrived?.();
    return birth;
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
    // A change of the 3D scene itself goes through black (see FADE_MS) — in EITHER direction:
    // onto a campaign backdrop, from one campaign's set to another, and back off a backdrop to
    // the menu's own Icecrown, which is the same cut in reverse. Re-entering the SAME backdrop
    // is not a change — the scene stays exactly where it is (MenuScene.showBackdrop) — so there
    // is nothing to cover and the screen must not blink.
    const swappingScene = (def.backdrop?.path ?? null) !== (this.scene?.backdropPath ?? null);
    let wentBlack = false;
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
        // The chrome leaves at the same moment, and tells us how long it takes. A backdrop
        // screen has no chrome to send away — only its contents fade.
        const death = this.backdropUp ? 0 : this.scene?.playChromeDeath() ?? 0;
        await leaving.animatePanels("out", death || NO_CHROME_OUT_MS);
        leaving.dispose();
      }

      // Black comes down only ONCE THE OLD SCREEN HAS GONE. The panel chrome's Death and the
      // fading of its buttons are the game's own animation and belong in view; fading first
      // threw them away and made clicking Campaign look like an instant cut to black. The
      // black then stands in for the usual beat between screens.
      if (swappingScene) {
        await this.toBlack(true);
        wentBlack = true;
      } else if (leaving) {
        await wait(GAP_MS);
      }

      this.current = next;
      next.element.style.visibility = "";
      const birth = await this.arrive(def);
      // Lift the black the MOMENT the new scene exists, and let the screen's contents fade up
      // over it rather than after it. A backdrop's Birth is a camera move — NightElf_Exp sweeps
      // its eye ~220 units and rolls it while Maiev turns to meet it — and holding black until
      // the DOM had finished (another 0.7 s) spent most of that shot behind the cover.
      const reveal = wentBlack ? this.toBlack(false) : null;
      // animatePanels("in") drops the contents to transparent in this same task, so they
      // never paint at full opacity for a frame before the panel that carries them arrives.
      await next.animatePanels("in", birth || NO_CHROME_IN_MS);
      await reveal;
      next.setInteractive(true);
      return next;
    } catch (err) {
      console.error("[OpenWar3] couldn't open that menu:", err);
      leaving?.setAllDisabled(false); // give the player their screen back
      if (wentBlack) await this.toBlack(false); // never leave the player staring at black
      return null;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Send the current screen away and put nothing in its place — the menus are over.
   *
   * This is the LEAVING half of `goTo`, on its own, and it is what starting a match runs
   * (issue #78): the reference does not cut from the Custom Game screen to the loading screen,
   * it plays the same departure as any other transition — every button goes dead, the panel's
   * contents fade out where they stand, and the empty panel slides up and off on the chrome's
   * own "<Screen> Death" clip, whooshes and all. Only once that has finished does the loading
   * screen appear.
   *
   * Stays `busy` afterwards on purpose: there is no screen left to navigate away from, and a
   * click that landed on the way out must not open a menu over the match.
   */
  async leave(): Promise<void> {
    const leaving = this.current;
    if (this.busy || !leaving) return;
    this.busy = true;
    leaving.setAllDisabled(true);
    const death = this.backdropUp ? 0 : this.scene?.playChromeDeath() ?? 0;
    await leaving.animatePanels("out", death || NO_CHROME_OUT_MS);
    leaving.dispose();
    this.current = null;
  }

  /** Cover the screen in black (or take the cover away), and resolve once it has finished.
   *  The overlay swallows clicks while it is up, so the dead beat mid-swap cannot be clicked
   *  through to whichever screen happens to be mounted underneath. */
  private async toBlack(on: boolean): Promise<void> {
    if (!this.fade) {
      this.fade = document.createElement("div");
      this.fade.className = "glue-fade";
      document.body.appendChild(this.fade);
    }
    const el = this.fade;
    el.style.transitionDuration = `${FADE_MS}ms`;
    el.classList.toggle("glue-fade-on", on);
    await wait(FADE_MS);
  }

  /** The screen currently on the menu (null while nothing is mounted). */
  get screen(): FdfScreen | null { return this.current; }

  dispose(): void {
    this.current?.dispose();
    this.current = null;
    this.fade?.remove();
    this.fade = null;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
