import "./style.css";
import { PlaceholderRenderer } from "./render/placeholder";
import { AssetResolver } from "./assets/resolver";
import { mountMainMenu } from "./ui/mainMenu";

// Phase 0 entry point (plan §6). Boots the placeholder renderer behind the menu
// shell — proving the engine runs, renders, and shows a menu with zero assets.
const canvas = document.getElementById("bg") as HTMLCanvasElement;
const ui = document.getElementById("ui") as HTMLElement;

// No install imported yet → resolver falls back to primitives (plan §2).
const resolver = new AssetResolver(null);

const renderer = new PlaceholderRenderer(canvas);
renderer.start();

mountMainMenu(ui, resolver);
