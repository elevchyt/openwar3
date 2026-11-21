import { showGlueDialog } from "./glueDialog";
import { loadOptions, saveOptions } from "../data/options";
import { applyVideoOptions } from "../render/videoQuality";
import type { DataSource } from "../vfs/types";

// "Your GPU may struggle" — asked ONCE, at the main menu, of a machine whose GPU the game
// already knows will be short of what a match costs.
//
// Found on a friend's laptop: an i5-6300U on Intel HD Graphics 520 played whole games at ~25 fps
// at the start of a 1v1 and 5–10 with an army out, on the default settings — 1920×1080,
// multisampled, every rung High — while Low Performance Mode and a smaller Resolution sat two
// clicks away on a screen nobody opens before they play. Nothing in 1.30.4 looks at the machine
// it runs on (its rungs were the player's to find), so this question is OURS, and so are the
// list and the answer below.
//
// It is ASKED, never applied. The player may like the picture as it is, and both settings live
// on the Video panel where they can be put back; what this changes is that the first player on
// such a machine hears about them before their first match rather than after it. Asked in the
// menus' own message box (ui/glueDialog.ts) once the main menu is up — the moment the update
// prompt also waits for (ui/updatePrompt.ts), for the same reason: a player looking at the main
// menu is the person to ask.

/** localStorage: the GPU name the question was last answered on. A different GPU — a new
 *  machine, a dock with a real graphics card — asks again; the same one never does. */
const ASKED_KEY = "openwar3.weakGpuAsked";

/** The rung "Yes" draws the world at: 2.25× fewer pixels than the default, and the rung the
 *  Video doc measured as a third off a GPU-bound frame (docs/video-options.md). */
const PROMPT_RESOLUTION = "1280x720";

/**
 * The player-facing name of a GPU the game will struggle on, or null for one it will not.
 *
 * `renderer` is the WebGL renderer string (render/webglSupport.ts `probeWebgl`), which Chromium
 * wraps in its ANGLE backend: "ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0,
 * D3D11)" on Windows, "ANGLE (Intel, Mesa Intel(R) HD Graphics 520 (SKL GT2), OpenGL 4.6)" on
 * Linux. The list is OURS and deliberately short — only what is weak on every count:
 *
 *   · **Intel HD / UHD Graphics and the pre-Xe Iris** — the integrated graphics of 2010–2020
 *     laptops and office desktops. A tenth or less of an entry-level discrete card's fill rate,
 *     with no memory of their own (the frame's bandwidth comes out of system RAM). Iris Xe and
 *     Arc are a generation on and are left alone.
 *   · **The phone-class GPUs** a Chromebook or an ARM laptop carries (Mali, Adreno, PowerVR).
 *   · **A software renderer** (SwiftShader, llvmpipe, Microsoft's Basic Render Driver): no GPU
 *     at all — the one the shell's software-GL relaunch (ui/noWebgl.ts) lands on.
 */
export function weakGpuName(renderer: string | null): string | null {
  if (!renderer) return null;
  const r = renderer;
  if (/swiftshader|llvmpipe|softpipe|basic render/i.test(r)) return "a software renderer"; // "Your GPU, a software renderer, …"
  if (/iris\(r\)? xe|\barc\b/i.test(r)) return null;
  const intel = /Intel\(R\)\s+((?:U?HD|Iris(?:\(R\))?(?:\s+(?:Plus|Pro))?)\s+Graphics(?:\s+P?\d{3,4})?)/i.exec(r);
  if (intel) return `Intel ${intel[1].replace(/\(R\)/gi, "").replace(/\s+/g, " ").trim()}`;
  const mobile = /\b(Mali-[\w-]+|Adreno(?:\s*\(TM\))?\s*\d{3}|PowerVR[^,()]*)/i.exec(r);
  if (mobile) return mobile[1].replace(/\s*\(TM\)/i, "").trim();
  return null;
}

/**
 * Ask the question if this machine wants it and has not answered it yet. Called once the main
 * menu is up (main.ts `showMenu`). Either answer is remembered against the GPU's name; "Yes"
 * ticks Low Performance Mode and lowers Resolution to 1280 × 720 (never RAISES it — a player
 * who already picked a smaller rung keeps theirs), saves both and applies them on the spot.
 */
export async function maybeAskWeakGpu(container: HTMLElement, vfs: DataSource, renderer: string | null): Promise<void> {
  const name = weakGpuName(renderer);
  if (!name || !renderer) return;
  const opts = loadOptions();
  if (opts.lowPerf === true) return; // already where the question would put it
  try {
    if (localStorage.getItem(ASKED_KEY) === renderer) return;
  } catch {
    // no storage: ask every launch rather than never — the answer is one click
  }
  const remember = (): void => {
    try {
      localStorage.setItem(ASKED_KEY, renderer);
    } catch {
      /* see above */
    }
  };
  await showGlueDialog({
    container,
    vfs,
    // The chip's name in gold, as the update prompt names its version: it is the one fact in the
    // message the player can check against their own machine. Two sentences and no more: the
    // box is DialogWar3.fdf's 0.35 x 0.2, and a third line ("you can change this later in
    // Options > Video") ran under the Yes/No pair — the two rows it names are on that screen.
    text:
      `Your GPU, |cffffcc00${name}|r, may struggle to run OpenWar3 smoothly.|n|n` +
      `Turn on Low Performance Mode and draw the world at 1280 x 720?`,
    buttons: "yesno",
    // Ours, not the game's: a question about the machine, not about the menu behind it — the
    // update prompt's rule.
    dimmed: true,
    onConfirm: () => {
      remember();
      const next = loadOptions();
      next.lowPerf = true;
      const height = (v: unknown): number => Number(/x(\d+)$/.exec(String(v))?.[1] ?? 1080);
      if (height(next.resolution) > height(PROMPT_RESOLUTION)) next.resolution = PROMPT_RESOLUTION;
      saveOptions(next);
      applyVideoOptions(next);
    },
    onCancel: remember,
  });
}

/** The renderer string to judge, with a DEV-ONLY stand-in: `?dev&weakgpu=<renderer>` pretends
 *  to be that GPU, so the prompt can be seen on a machine that would never be asked. Folded out
 *  of a production build with the rest of `import.meta.env.DEV`. */
export function gpuToJudge(real: string | null): string | null {
  if (import.meta.env.DEV && typeof location !== "undefined") {
    const fake = new URLSearchParams(location.search).get("weakgpu");
    if (fake) return fake;
  }
  return real;
}
