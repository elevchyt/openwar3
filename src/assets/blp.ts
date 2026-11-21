import { BlpImage } from "mdx-m3-viewer/dist/cjs/parsers/blp/image";

// BLP1 → texture (plan §4, Phase 2). mdx-m3-viewer decodes both JPG-content and
// palettized BLP1 to RGBA. Ready for the ground-tile atlas + unit/icon textures;
// the Phase 2 terrain currently renders with tile-color placeholders (plan §2).

/** Decode BLP1 bytes to RGBA ImageData at the given mip level (0 = largest). */
export function decodeBlp(bytes: Uint8Array, level = 0): ImageData {
  const img = new BlpImage();
  img.load(bytes);
  return img.getMipmap(level);
}
