import type { MenuScene } from "../render/menuScene";

// On-screen tuning controls for the main-menu 3D scene + sprite panel (issue #54).
// Opt-in via the `?menudebug` query param. Drag the sliders to reframe the camera and
// the panel live, then hit "Log values" to print the numbers to the console — paste
// those back and they get baked into MenuScene.tuning as the new defaults.

interface Slider {
  key: keyof MenuScene["tuning"];
  label: string;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: Slider[] = [
  { key: "camZoom", label: "Cam zoom (dolly)", min: 0.4, max: 1.6, step: 0.01 },
  { key: "camPanX", label: "Cam pan X", min: -3000, max: 3000, step: 10 },
  { key: "camPanY", label: "Cam pan Y", min: -3000, max: 3000, step: 10 },
  { key: "camFov", label: "Cam FOV ×", min: 0.4, max: 1.6, step: 0.01 },
  { key: "panelCx", label: "Panel centre X", min: -0.6, max: 0.6, step: 0.005 },
  { key: "panelCy", label: "Panel centre Y", min: -0.6, max: 0.6, step: 0.005 },
  { key: "panelHalfX", label: "Panel width (½, smaller=wider)", min: 0.15, max: 0.9, step: 0.005 },
  { key: "panelHalfY", label: "Panel height (½, smaller=taller)", min: 0.15, max: 0.9, step: 0.005 },
  { key: "panelStretchX", label: "Panel stretch X", min: 0.7, max: 1.8, step: 0.01 },
];

export function mountMenuDebug(root: HTMLElement, scene: MenuScene): { dispose(): void } {
  const box = document.createElement("div");
  box.className = "menu-debug";

  const title = document.createElement("div");
  title.className = "menu-debug-title";
  title.textContent = "Menu tuning";
  box.appendChild(title);

  const readouts: Array<() => void> = [];
  for (const s of SLIDERS) {
    const row = document.createElement("label");
    row.className = "menu-debug-row";

    const name = document.createElement("span");
    name.className = "menu-debug-label";
    const val = document.createElement("span");
    val.className = "menu-debug-val";
    const sync = (): void => {
      name.textContent = s.label;
      val.textContent = scene.tuning[s.key].toFixed(s.step < 1 ? 3 : 0);
    };
    sync();
    readouts.push(sync);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String(s.step);
    input.value = String(scene.tuning[s.key]);
    input.oninput = (): void => {
      scene.tuning[s.key] = Number(input.value);
      scene.applyTuning();
      sync();
    };

    const head = document.createElement("div");
    head.className = "menu-debug-head";
    head.append(name, val);
    row.append(head, input);
    box.appendChild(row);
  }

  const actions = document.createElement("div");
  actions.className = "menu-debug-actions";

  const log = document.createElement("button");
  log.className = "menu-debug-btn";
  log.textContent = "Log values";
  log.onclick = (): void => {
    const t = scene.tuning;
    const line = SLIDERS.map((s) => `${s.key}: ${Number(t[s.key].toFixed(4))}`).join(", ");
    // eslint-disable-next-line no-console
    console.log(`[OpenWar3 menu tuning] { ${line} }`);
  };

  const hide = document.createElement("button");
  hide.className = "menu-debug-btn";
  hide.textContent = "Hide";
  hide.onclick = (): void => { box.classList.toggle("collapsed"); hide.textContent = box.classList.contains("collapsed") ? "Show" : "Hide"; };

  actions.append(log, hide);
  box.appendChild(actions);
  root.appendChild(box);

  return { dispose: () => box.remove() };
}
