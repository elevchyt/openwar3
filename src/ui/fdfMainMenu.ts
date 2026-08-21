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
 * the game's own `StandardSmallTextTemplate`, the small gold face every glue label uses,
 * rather than inventing a look for it.
 *
 * Ours names the project instead of a patch number, and — unlike the reference's, which is
 * inert text — it OPENS THE REPO in a new tab (see `linkRepo`).
 */
const VERSION_FRAME = "OpenWar3VersionText";
const REPO_URL = "https://github.com/elevchyt/openwar3";
const REPO_TEXT = "github.com/elevchyt/openwar3";

/** Where the line sits: the right edge the whole button chain is anchored to
 *  (MainMenu.fdf's backdrops all take -0.015 off MainMenuFrame's right), and low enough to
 *  clear the Exit backdrop, whose own BOTTOMRIGHT anchor stands it 0.05 off the bottom. */
const VERSION_POINT = { x: -0.015, y: 0.035, w: 0.3, h: 0.014 };

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

  const line = lib.resolveRoot("StandardSmallTextTemplate");
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
 * trying to change it — including the `:hover` that lights the line up to the template's own
 * FontHighlightColor (1 1 1 1 — white; a colour change is how the game says "this responds").
 * Handed over as a variable the anchor's own rules read, both states are stylesheet rules
 * again and the hover wins on order, exactly as it should.
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
