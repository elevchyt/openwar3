import type { DataSource } from "../vfs/types";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { arg, num, setProp, str } from "./mapBrowser";

// The main menu, constructed from the game's own UI\FrameDef\Glue\MainMenu.fdf
// (issue #54) rather than hand-authored DOM. This is the payoff of the FDF engine:
// the layout, button set, ornate chrome, hotkeys and strings all come straight from
// the mounted install, matching the original.

/**
 * THE VERSION LINE, bottom-right under the button chain — the corner where the reference
 * prints its build ("Version 1.30.4.10141") on the FIRST menu screen, the one that wears the
 * logo. It is the one thing on that screen MainMenu.fdf does not declare: the file has no
 * frame for it anywhere (its only *NetVersion frames belong to the replay-confirm dialog),
 * because the engine's own CGameUI stamps the build number in. So we compose it here out of
 * the game's own `StandardSmallTitleTextTemplate` — the WHITE twin of the small glue label
 * (StandardTemplates.fdf gives the pair identical metrics, `MasterFont` at 0.011, and differs
 * only in FontColor: 1 1 1 against the gold 0.99 0.827 0.0705). White is the colour the
 * reference prints its build in, so it is the one this line takes.
 *
 * Ours names the project instead of a patch number, and — unlike the reference's, which is
 * inert text — it OPENS THE REPO in a new tab (see `linkRepo`).
 */
const VERSION_FRAME = "OpenWar3VersionText";
const REPO_URL = "https://github.com/elevchyt/openwar3";
const REPO_TEXT = "github.com/elevchyt/openwar3";

/**
 * Where the line sits: hard into the bottom-right corner, UNDER the panel rather than on it.
 *
 * x is the right edge the whole button chain is anchored to (MainMenu.fdf's backdrops all take
 * -0.015 off MainMenuFrame's right). y is small on purpose — the reference's build line sits
 * below the button panel in the corner of the SCREEN, and our panel is a 3D model stretched to
 * a widescreen frame, so it reaches lower than the 4:3 one this file was authored for and the
 * band left beneath it is thin. Anything taller than this puts the line back on the panel's
 * rivet strip, which is exactly what it must not sit on.
 */
const VERSION_POINT = { x: -0.015, y: 0.003, w: 0.3, h: 0.016 };

/** The line's type size. `StandardSmallTitleTextTemplate` sets 0.011 — the size of a caption
 *  inside a panel, which is smaller than it needs to be out here in the open with nothing
 *  around it — so it takes the ordinary glue text size instead, 0.013, the one
 *  StandardTemplates.fdf gives StandardTextTemplate and StandardInfoTextTemplate. */
const VERSION_FONT = 0.013;

export interface MainMenuHandlers {
  onSinglePlayer: () => void;
  onOnline?: () => void;
  onLan?: () => void;
  onOptions?: () => void;
  onCredits?: () => void;
  onQuit?: () => void;
}

export function mountFdfMainMenu(
  container: HTMLElement,
  vfs: DataSource,
  h: MainMenuHandlers,
): Promise<FdfScreen> {
  const log = (name: string) => () => console.log(`[OpenWar3] menu: ${name}`);
  return mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\MainMenu.fdf",
    rootFrame: "MainMenuFrame",
    buildRoot: (lib) => buildMainMenuRoot(lib),
    // The realm-select sub-panel is hidden until you enter Battle.net (as the engine's
    // glue script hides it), but the little search-region button (magnifying glass)
    // next to Online is kept — the developer wants it shown even without region logic.
    hidden: ["RealmSelect"],
    // Wider buttons than the 4:3-authored FDF, to fill the widescreen chain panel
    // (text stays its FDF size — only the widget widens).
    buttonWidthScale: 1.35,
    // "Battle.net" is intentionally "Online": OpenWar3 multiplayer targets our own
    // server, not Blizzard's (matches the flat-menu note in mainMenu.ts / plan §10.1).
    textOverrides: { BattleNetButtonText: "Online" },
    handlers: {
      SinglePlayerButton: h.onSinglePlayer,
      BattleNetButton: h.onOnline ?? log("Online"),
      LocalAreaNetworkButton: h.onLan ?? log("Local Area Network"),
      OptionsButton: h.onOptions ?? log("Options"),
      CreditsButton: h.onCredits ?? log("Credits"),
      ExitButton: h.onQuit ?? (() => window.close()),
    },
    // Re-run on every build: a resize throws the DOM away and rebuilds it, taking the
    // anchor with it (ui/fdf/render.ts).
    onBuild: (s) => linkRepo(s),
  });
}

/** MainMenuFrame with the version line added as a direct child — which also makes it one of
 *  the screen's PANELS, so it fades in and out with everything else on it. */
function buildMainMenuRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("MainMenuFrame");
  if (!root) throw new Error("MainMenu.fdf: no MainMenuFrame frame");

  const line = lib.resolveRoot("StandardSmallTitleTextTemplate");
  if (line) {
    line.name = VERSION_FRAME;
    setProp(line, "Width", [num(VERSION_POINT.w)]);
    setProp(line, "Height", [num(VERSION_POINT.h)]);
    setProp(line, "SetPoint", [
      arg("BOTTOMRIGHT"), str("MainMenuFrame"), arg("BOTTOMRIGHT"),
      num(VERSION_POINT.x), num(VERSION_POINT.y),
    ]);
    // The template justifies left; this line is hung off the RIGHT edge, so it reads from
    // there — the same edge every button above it is anchored to.
    setProp(line, "FontJustificationH", [arg("JUSTIFYRIGHT")]);
    setProp(line, "FrameFont", [str("MasterFont"), num(VERSION_FONT), str("")]);
    setProp(line, "Text", [str(REPO_TEXT)]);
    root.children.push(line);
  }
  return root;
}

/**
 * Make the version line a link to the repo, opening in a new tab.
 *
 * A TEXT frame is a div with one span in it (ui/fdf/render.ts `paintText`), and every FDF
 * frame is `pointer-events: none` — so the span is wrapped in an anchor that takes the
 * pointer back.
 *
 * The COLOUR has to move with it, and it has to move as a CUSTOM PROPERTY. `paintText` writes
 * FontColor as an INLINE colour on the span, and an inline colour beats any stylesheet rule
 * trying to change it — including the `:hover`. Handed over as a variable the anchor's own
 * rules read, both states are stylesheet rules again and the hover wins on order.
 *
 * The hover goes to GOLD, which is the one place this line reads its own template backwards.
 * A colour change is how the glue says "this responds", and everywhere else that means gold
 * text going white — but this line starts white (the reference's build colour), and white has
 * nowhere brighter to go. So it lights to the gold of its sibling template instead.
 */
function linkRepo(s: FdfScreen): void {
  const el = s.frame(VERSION_FRAME);
  const span = el?.querySelector("span");
  if (!span || span.parentElement?.tagName === "A") return;

  const a = document.createElement("a");
  a.className = "fdf-version-link";
  a.href = REPO_URL;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.style.setProperty("--fdf-link-color", span.style.color);
  span.style.color = ""; // inherited from the anchor now — see above
  span.replaceWith(a);
  a.appendChild(span);
}
