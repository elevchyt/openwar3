import { BlpImage } from "mdx-m3-viewer/dist/cjs/parsers/blp/image";

// Decode BLP1 bytes into DOM-usable images (plan §10: HUD chrome/icons come
// from the real game files when an install is mounted).

export interface BlpOptions {
  /** Draw a PAINTED texture whose alpha channel is entirely zero as opaque — the night elf
   *  and undead menu button faces. Opt-in, and only the UI chrome opts in: see reviveDeadAlpha. */
  reviveDeadAlpha?: boolean;
}

export function blpToCanvas(bytes: Uint8Array, opts: BlpOptions = {}): HTMLCanvasElement | null {
  try {
    const image = new BlpImage();
    image.load(bytes);
    const data = image.getMipmap(0);
    if (opts.reviveDeadAlpha) reviveDeadAlpha(data);
    const canvas = document.createElement("canvas");
    canvas.width = data.width;
    canvas.height = data.height;
    canvas.getContext("2d")!.putImageData(data, 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

/**
 * A PAINTED image whose alpha channel is entirely zero, made opaque — **before it ever
 * touches a canvas**, which is the whole point of doing it here.
 *
 * Six BLPs in the 1.27a install decode to nothing but transparent pixels, and four of them
 * are the button faces the night elf and undead menus are made of
 * (`nightelf-options-button-background.blp` + its `-down` twin, and the undead pair). They
 * are fully painted 256×256 images — the night elf one is a green marble in 200+ distinct
 * colours — carrying a dead alpha channel, and the game plainly draws them: an EscMenu
 * button under the night elf skin is a green carved face, not the bare gold border that
 * honouring the alpha leaves behind. (The human and orc sections point the same key at art
 * with a live alpha — 191 flat, the translucent slate — so the channel is read wherever it
 * says anything. This is only the case where it says nothing at all.)
 *
 * **Why the decoder and not the drawing code.** A canvas stores its pixels PREMULTIPLIED, so
 * `putImageData` of (0, 30, 9, α=0) reads back as (0, 0, 0, 0): the colour is destroyed on
 * the way in, and any repair attempted downstream is working on black. That is exactly how
 * the first fix for this failed — it lived in the FDF backdrop compositor, looked at the
 * finished canvas, saw one flat colour, concluded "blank" and left the faces invisible, so
 * the night elf menus rendered with the panel's grey showing through where the green belongs.
 *
 * **A blank is not art, and this must not touch one.** The other two dead-alpha files exist
 * to be invisible — `blank-background.blp` is what `QuestDialogCompletedMouseOverHighlight`
 * names to say "this row does not highlight" (and it IS used as a backdrop background,
 * including by the cinematic panel's `CinematicPortraitCover`, where forcing it opaque puts
 * a black plate over the 3D bust), and `ShadowBuildingNull.blp` is a null shadow. What tells
 * them apart is the picture: the button faces are painted, a blank is ONE flat colour end to
 * end — so a single-colour texture is left exactly as it is. `blank-background` is 32×32 of
 * pure black and passes that test.
 *
 * `ShadowBuildingNull` does NOT (it is 4×4 of black with three stray red pixels of encoder
 * ringing), which is why this is opt-in rather than applied to every BLP the game decodes:
 * only the UI chrome asks for it, and the shadow pass — the one caller that would be
 * ruined by a black plate — shares the same decoder. Scope, not cleverness, keeps them apart.
 */
function reviveDeadAlpha(data: ImageData): void {
  const d = data.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return; // a live alpha: honour it
  for (let i = 4; i < d.length; i += 4) {
    if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) {
      for (let a = 3; a < d.length; a += 4) d[a] = 255;
      return;
    }
  }
  // …one flat colour end to end: a blank, and it is meant to be invisible.
}

export function blpToDataUrl(bytes: Uint8Array): string | null {
  return blpToCanvas(bytes)?.toDataURL() ?? null;
}
