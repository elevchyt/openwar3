import { BlpImage } from "mdx-m3-viewer/dist/cjs/parsers/blp/image";

// Decode BLP1 bytes into DOM-usable images (plan §10: HUD chrome/icons come
// from the real game files when an install is mounted).

export function blpToCanvas(bytes: Uint8Array): HTMLCanvasElement | null {
  try {
    const image = new BlpImage();
    image.load(bytes);
    const data = image.getMipmap(0);
    const canvas = document.createElement("canvas");
    canvas.width = data.width;
    canvas.height = data.height;
    canvas.getContext("2d")!.putImageData(data, 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

export function blpToDataUrl(bytes: Uint8Array): string | null {
  return blpToCanvas(bytes)?.toDataURL() ?? null;
}
