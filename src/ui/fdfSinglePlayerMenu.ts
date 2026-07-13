import type { DataSource } from "../vfs/types";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";

// The Single Player menu (issue #61), built from the game's own
// UI\FrameDef\Glue\SinglePlayerMenu.fdf: Campaign / Load Saved Game / View Replay /
// Custom Campaign / Custom Game, over the Cancel panel.
//
// That FDF holds TWO screens in one file, as the original does: the ProfilePanel (the
// "Single Player Profiles" create/select screen) and the MainPanel (the button list you
// land on once a profile is chosen). WC3's glue script shows one or the other. We hide
// the profile half — profiles carry campaign progress and saved-game lists, neither of
// which exists yet, so the menu goes straight to the button list, which is where the
// Custom Game flow this issue is about actually starts.
const PROFILE_FRAMES = ["ProfilePanel", "ProfileButtonBackdrop", "ProfileNameText"];

export interface SinglePlayerHandlers {
  onCampaign?: () => void;
  onLoadSaved?: () => void;
  onViewReplay?: () => void;
  onCustomCampaign?: () => void;
  onCustomGame: () => void;
  onCancel: () => void;
}

export function mountSinglePlayerMenu(
  container: HTMLElement,
  vfs: DataSource,
  h: SinglePlayerHandlers,
): Promise<FdfScreen> {
  const log = (name: string) => () => console.log(`[OpenWar3] single player: ${name}`);
  return mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\SinglePlayerMenu.fdf",
    rootFrame: "SinglePlayerMenu",
    hidden: PROFILE_FRAMES,
    // The chain panel is a widescreen-wide slot; the 4:3-authored buttons are widened to
    // fill it, exactly as the main menu does.
    buttonWidthScale: 1.35,
    // The two panels that slide: the button column, and the Cancel panel under it. They
    // are separate frames in the FDF and separate panels in the chrome model, so they
    // travel separately — each only as far as it needs to clear the top of the screen.
    panels: ["MainPanel", "CancelPanel"],
    handlers: {
      CampaignButton: h.onCampaign ?? log("Campaign"),
      LoadSavedButton: h.onLoadSaved ?? log("Load Saved Game"),
      ViewReplayButton: h.onViewReplay ?? log("View Replay"),
      CustomCampaignButton: h.onCustomCampaign ?? log("Custom Campaign"),
      SkirmishButton: h.onCustomGame,
      CancelButton: h.onCancel,
    },
  });
}
