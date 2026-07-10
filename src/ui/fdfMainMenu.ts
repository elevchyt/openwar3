import type { DataSource } from "../vfs/types";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";

// The main menu, constructed from the game's own UI\FrameDef\Glue\MainMenu.fdf
// (issue #54) rather than hand-authored DOM. This is the payoff of the FDF engine:
// the layout, button set, ornate chrome, hotkeys and strings all come straight from
// the mounted install, matching the original.

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
  });
}
