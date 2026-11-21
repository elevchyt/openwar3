import { showGlueDialog } from "./glueDialog";
import { loadOptions, saveOptions, withLowestVideo, type Options } from "../data/options";
import { applyVideoOptions } from "../render/videoQuality";
import type { DataSource } from "../vfs/types";

// "Your GPU may struggle" — asked ONCE, at the main menu, of a machine whose GPU the game
// already knows will be short of what a match costs.
//
// Found on a friend's laptop: an i5-6300U on Intel HD Graphics 520 played whole games at ~25 fps
// at the start of a 1v1 and 5–10 with an army out, on the default settings — 1920×1080,
// multisampled, every rung High — while the Video panel's lower rungs and a smaller Resolution
// sat on a screen nobody opens before they play. Nothing in 1.30.4 looks at the machine
// it runs on (its rungs were the player's to find), so this question is OURS, and so are the
// list and the answer below.
//
// It is ASKED, never applied. The player may like the picture as it is, and every value it
// writes is an ordinary row of the Video panel that can be raised again one at a time; what this changes is that the first player on
// such a machine hears about them before their first match rather than after it. Asked in the
// menus' own message box (ui/glueDialog.ts) once the main menu is up — the moment the update
// prompt also waits for (ui/updatePrompt.ts), for the same reason: a player looking at the main
// menu is the person to ask.

/**
 * localStorage: the GPU the question was last answered on — by its NAME (`weakGpuName`), never
 * the raw renderer string. ASKED ONCE, NOT EVERY LAUNCH: on Windows Chromium's renderer string
 * can carry the device id and the DRIVER VERSION ("…Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.101…"),
 * so keyed on the whole string every driver update would have asked again. Keyed on the chip, a
 * different machine asks and the same one never does — whichever way it was answered, Escape
 * (No) included.
 */
const ASKED_KEY = "openwar3.weakGpuAsked";


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
 * writes `withLowestVideo` (data/options.ts) — every Video row that costs something at its
 * cheapest, Animation Quality: Low's shared animation and Antialiasing off among them, and
 * Resolution LOWERED to 1280 × 720 (never raised: a smaller rung the player picked stays) —
 * saves it and applies it on the spot. A player already there is not asked.
 */
export async function maybeAskWeakGpu(container: HTMLElement, vfs: DataSource, renderer: string | null): Promise<void> {
  const name = weakGpuName(renderer);
  if (!name || !renderer) return;
  if (atLowest(loadOptions())) return; // already where the question would put it
  try {
    if (localStorage.getItem(ASKED_KEY) === name) return;
  } catch {
    // No storage to remember the answer in, so NOT asked at all: a question that cannot be
    // remembered is a question asked every launch, and that is the one thing this must not be.
    return;
  }
  const remember = (): void => {
    try {
      localStorage.setItem(ASKED_KEY, name);
    } catch {
      /* the read above worked, so this one will; nothing to do if it does not */
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
      `Set every video option to its lowest and draw the world at 1280 x 720?`,
    buttons: "yesno",
    // Ours, not the game's: a question about the machine, not about the menu behind it — the
    // update prompt's rule.
    dimmed: true,
    onConfirm: () => {
      remember();
      const next = withLowestVideo(loadOptions());
      saveOptions(next);
      applyVideoOptions(next);
    },
    onCancel: remember,
  });
}

/** Whether `o` is already everything Yes would write — nothing left to offer. */
function atLowest(o: Options): boolean {
  const lowest = withLowestVideo(o);
  return Object.keys(lowest).every((k) => lowest[k] === o[k]);
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
