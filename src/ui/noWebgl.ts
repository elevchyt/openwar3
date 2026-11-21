import { isDesktopApp, relaunchNative, reportGpu, setNativeSoftwareGl } from "../assets/nativeInstall";
import { describeProbe, type WebglProbe } from "../render/webglSupport";
import { bindHotkeys, createGlueButton, createPanel } from "@openwar3/ui/dom";

// The screen a machine that cannot draw the game gets INSTEAD of the load gate
// (render/webglSupport.ts says what it checks and why). Before it existed that machine got a menu
// with no 3D behind its buttons and a black screen at the start of a match, with nothing to say
// why — the report that found it came from a 2008 ThinkPad.
//
// Like the gate, it runs before any FrameDef can be read, so it wears the shared UI kit and the
// gate's own layout classes; and like the gate's, every word on it is OURS — the game has no
// string for this, because the game's renderer is Direct3D and either starts or does not.
//
// The desktop app can do something about it: the shell can let Chromium fall back to software
// rendering (electron/main.mjs SOFTWARE_GL), and this screen is where the player turns that on.
// It is the player's call rather than automatic because it is SLOW — a match on a Core 2 Duo runs
// at a few frames a second — and a player should know that before they meet it. Either way a
// report is written to `.logs/` (`ow3:gpu-report`), which is what gets the driver looked at.

export function mountNoWebgl(root: HTMLElement, probe: WebglProbe): void {
  const desktop = isDesktopApp();
  const screen = document.createElement("div");
  screen.className = "load-gate no-webgl";

  const panel = createPanel("div", "load-gate-panel");

  const title = document.createElement("h1");
  title.className = "ow3-heading load-gate-title";
  title.textContent = "No 3D Graphics";

  const sub = document.createElement("p");
  sub.className = "load-gate-sub";
  sub.textContent = probe.missing.includes("WebGL")
    ? "OpenWar3 draws the game with WebGL, and this computer's graphics driver did not provide it — so the menus and the matches cannot be drawn."
    : "OpenWar3 draws the game with WebGL, and this computer's graphics driver provides it without a feature the game cannot do without — so the menus and the matches cannot be drawn.";

  const detail = document.createElement("p");
  detail.className = "load-gate-status error";
  detail.textContent = `Missing: ${probe.missing.join(", ")}${probe.renderer ? ` (${probe.renderer})` : ""}`;

  const advice = document.createElement("p");
  advice.className = "load-gate-sub no-webgl-advice";

  const action = document.createElement("div");
  action.className = "load-gate-action";

  const report = document.createElement("p");
  report.className = "load-gate-status";
  report.setAttribute("role", "status");

  if (desktop) {
    advice.textContent = "Software rendering draws the game on the processor instead of the graphics card. It works on any computer, but it is slow — expect the menus to be usable and a match to run at only a few frames a second.";
    const btn = createGlueButton({ label: "Restart with Software Rendering", hotkey: "R", size: "lg", bordered: true });
    btn.button.onclick = async (): Promise<void> => {
      btn.setDisabled(true);
      await setNativeSoftwareGl(true);
      relaunchNative();
    };
    action.append(btn.root);
    // The report also says whether THIS launch already had software rendering on — and if it did,
    // there is nothing left to offer: Chromium could not start even SwiftShader.
    void reportGpu(describeProbe(probe)).then((r) => {
      if (!r) return;
      if (r.softwareGl) {
        advice.textContent = "Software rendering is already on, and it could not start either. Updating the graphics driver is the remaining fix.";
        action.hidden = true;
      }
      if (r.file) report.textContent = `A report was written to ${r.file} — please include it if you report this.`;
    });
  } else {
    advice.textContent = "Turn on hardware acceleration in the browser's settings and restart it, or open chrome://gpu (about:support in Firefox) to see why WebGL is unavailable. The OpenWar3 desktop app can also draw the game in software.";
    action.hidden = true;
  }

  panel.append(title, sub, detail, advice, action, report);
  screen.appendChild(panel);
  root.appendChild(screen);
  bindHotkeys(screen); // nothing else is on the page, so it is never unbound
  console.warn(`[OpenWar3] cannot draw: ${describeProbe(probe)}`);
}
