import type { BackdropTuning, MenuScene } from "../render/menuScene";

// On-screen tuning controls for the glue screens' 3D scenes (issues #54, #105).
// Opt-in via the `?menudebug` query param. Drag the sliders to reframe the camera, the fog
// and the sprite panel live, then hit "Log values" to print the numbers to the console —
// paste those back and they get baked in as the new defaults.
//
// The panel drives whichever scene is on screen, and says which that is in its title:
//   * the MAIN MENU's Icecrown scene + its two sprite-layer panels → MenuScene.tuning;
//   * a CAMPAIGN screen's 3D backdrop → that backdrop's own BackdropTuning block, one per
//     model, since the four campaign scenes are four different sets. It carries no sprite
//     panels at all (the campaign screen is the one glue screen with no chrome), so its
//     slider set is camera + fog only, and its fog ranges reach the 16000 the Alliance
//     campaign's own BackgroundFogEnd asks for.
// Switching campaigns re-binds the sliders (MenuScene.onBackdropChange), so each backdrop
// keeps what you left on it and can be logged separately.

interface Slider<K extends string> {
  key: K;
  label: string;
  min: number;
  max: number;
  step: number;
}

type MenuKey = keyof MenuScene["tuning"];

const MENU_SLIDERS: Slider<MenuKey>[] = [
  { key: "camZoom", label: "Cam zoom (dolly)", min: 0.4, max: 1.6, step: 0.01 },
  { key: "camPanX", label: "Cam pan X", min: -3000, max: 3000, step: 10 },
  { key: "camPanY", label: "Cam pan Y", min: -3000, max: 3000, step: 10 },
  { key: "camFov", label: "Cam FOV ×", min: 0.4, max: 1.6, step: 0.01 },
  { key: "panelCx", label: "Panel centre X", min: -0.6, max: 0.6, step: 0.005 },
  { key: "panelCy", label: "Panel centre Y", min: -0.6, max: 0.6, step: 0.005 },
  { key: "panelHalfX", label: "Panel width (½, smaller=wider)", min: 0.15, max: 0.9, step: 0.005 },
  { key: "panelHalfY", label: "Panel height (½, smaller=taller)", min: 0.15, max: 0.9, step: 0.005 },
  { key: "panelStretchX", label: "Panel stretch X", min: 0.7, max: 1.8, step: 0.01 },
  { key: "leftCx", label: "Left centre X", min: -0.6, max: 1.2, step: 0.005 },
  { key: "leftCy", label: "Left centre Y", min: -0.6, max: 0.6, step: 0.005 },
  { key: "leftHalfX", label: "Left width (½)", min: 0.15, max: 0.9, step: 0.005 },
  { key: "leftHalfY", label: "Left height (½)", min: 0.15, max: 0.9, step: 0.005 },
  { key: "leftStretchX", label: "Left stretch X", min: 0.7, max: 1.8, step: 0.01 },
  { key: "fogStart", label: "Fog start (world)", min: 0, max: 12000, step: 100 },
  { key: "fogEnd", label: "Fog end (world)", min: 0, max: 18000, step: 100 },
  { key: "fogR", label: "Fog R", min: 0, max: 1, step: 0.01 },
  { key: "fogG", label: "Fog G", min: 0, max: 1, step: 0.01 },
  { key: "fogB", label: "Fog B", min: 0, max: 1, step: 0.01 },
];

const BACKDROP_SLIDERS: Slider<keyof BackdropTuning>[] = [
  { key: "camZoom", label: "Cam zoom (dolly)", min: 0.2, max: 2, step: 0.01 },
  { key: "camPanX", label: "Cam pan X", min: -3000, max: 3000, step: 10 },
  { key: "camPanY", label: "Cam pan Y", min: -3000, max: 3000, step: 10 },
  { key: "camFov", label: "Cam FOV ×", min: 0.4, max: 1.6, step: 0.01 },
  // BackgroundFogEnd runs 1700 (Sentinels) → 16000 (Alliance) in CampaignStrings_exp.txt.
  { key: "fogStart", label: "Fog start (world)", min: 0, max: 20000, step: 100 },
  { key: "fogEnd", label: "Fog end (world)", min: 0, max: 20000, step: 100 },
  { key: "fogR", label: "Fog R", min: 0, max: 1, step: 0.01 },
  { key: "fogG", label: "Fog G", min: 0, max: 1, step: 0.01 },
  { key: "fogB", label: "Fog B", min: 0, max: 1, step: 0.01 },
];

export function mountMenuDebug(root: HTMLElement, scene: MenuScene): { dispose(): void } {
  const box = document.createElement("div");
  box.className = "menu-debug";

  const title = document.createElement("div");
  title.className = "menu-debug-title";
  const body = document.createElement("div");
  const actions = document.createElement("div");
  actions.className = "menu-debug-actions";
  box.append(title, body, actions);

  /** Build the rows for one tuning object. Generic over its keys so the two slider tables
   *  stay type-checked against the block they drive. */
  function buildRows<K extends string>(sliders: Slider<K>[], values: Record<K, number>): void {
    body.textContent = "";
    for (const s of sliders) {
      const row = document.createElement("label");
      row.className = "menu-debug-row";

      const name = document.createElement("span");
      name.className = "menu-debug-label";
      name.textContent = s.label;
      const val = document.createElement("span");
      val.className = "menu-debug-val";
      const sync = (): void => { val.textContent = values[s.key].toFixed(s.step < 1 ? 3 : 0); };
      sync();

      const input = document.createElement("input");
      input.type = "range";
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step);
      input.value = String(values[s.key]);
      input.oninput = (): void => {
        values[s.key] = Number(input.value);
        scene.applyTuning();
        sync();
      };

      const head = document.createElement("div");
      head.className = "menu-debug-head";
      head.append(name, val);
      row.append(head, input);
      body.appendChild(row);
    }
  }

  /** Point the controls at whatever scene is up now. */
  function rebind(): void {
    const backdrop = scene.backdropTuning;
    if (backdrop) {
      title.textContent = `Campaign backdrop — ${modelName(scene.backdropPath)}`;
      buildRows(BACKDROP_SLIDERS, backdrop);
    } else {
      title.textContent = "Menu tuning";
      buildRows(MENU_SLIDERS, scene.tuning);
    }
  }
  rebind();
  scene.onBackdropChange = rebind;

  const log = document.createElement("button");
  log.className = "menu-debug-btn";
  log.textContent = "Log values";
  log.onclick = (): void => {
    const backdrop = scene.backdropTuning;
    if (backdrop) {
      // Every backdrop touched this session, so a pass over all four campaigns logs once.
      for (const [path, t] of scene.tunedBackdrops) {
        const line = BACKDROP_SLIDERS.map((s) => `${s.key}: ${Number(t[s.key].toFixed(4))}`).join(", ");
        // eslint-disable-next-line no-console
        console.log(`[OpenWar3 backdrop tuning] ${path} { ${line} }`);
      }
      return;
    }
    const t = scene.tuning;
    const line = MENU_SLIDERS.map((s) => `${s.key}: ${Number(t[s.key].toFixed(4))}`).join(", ");
    // eslint-disable-next-line no-console
    console.log(`[OpenWar3 menu tuning] { ${line} }`);
  };

  const hide = document.createElement("button");
  hide.className = "menu-debug-btn";
  hide.textContent = "Hide";
  hide.onclick = (): void => { box.classList.toggle("collapsed"); hide.textContent = box.classList.contains("collapsed") ? "Show" : "Hide"; };

  actions.append(log, hide);
  root.appendChild(box);

  return {
    dispose: () => {
      if (scene.onBackdropChange === rebind) scene.onBackdropChange = null;
      box.remove();
    },
  };
}

/** "UI\Glues\SinglePlayer\NightElf_Exp\NightElf_Exp.mdx" → "NightElf_Exp" — enough to tell
 *  which campaign's scene the sliders are driving. */
function modelName(path: string | null): string {
  if (!path) return "?";
  return path.split(/[\\/]/).pop()?.replace(/\.(mdx|mdl)$/i, "") ?? path;
}
