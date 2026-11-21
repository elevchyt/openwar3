// Can this machine draw the game at all? Asked ONCE, before the load gate, because the answer
// otherwise arrives as a black screen: mdx-m3-viewer throws from its constructor when it gets no
// context, the menu's 3D scene swallows that (main.ts `showMenuBackground`), and a match has no
// such fallback. Found on a 2008 ThinkPad T500 (Intel GM45, Mesa crocus, OpenGL 2.1), whose
// Chromium gave the page no WebGL at all — see electron/main.mjs SOFTWARE_GL for why that is
// now the browser's behaviour rather than a slow software fallback.
//
// WebGL 2 is NOT asked for: the renderer is mdx-m3-viewer, which is WebGL 1 throughout, and a
// match was played through with WebGL 2 switched off (`--disable-webgl2`) to be sure. What IS
// required is the viewer's own list, each of which it throws on rather than degrades:
//  - OES_texture_float — "MDX: No float texture support!" / "War3MapViewer: …" (bone and
//    height-map data textures);
//  - ANGLE_instanced_arrays — "MDX: No instanced rendering support!";
//  - a vertex shader that can READ a texture (MAX_VERTEX_TEXTURE_IMAGE_UNITS ≥ 1), which WebGL 1
//    allows to be zero — the skinning reads the bone texture there, and the terrain's
//    `ground.vert` reads its height map, so a GPU without it fails at the first shader link.

export interface WebglProbe {
  /** Everything the renderer needs is there. */
  ok: boolean;
  /** What is not, in words a player could search for (empty when `ok`). */
  missing: string[];
  /** The GPU's own name for itself, when the context would say (null without a context). */
  renderer: string | null;
}

export function probeWebgl(): WebglProbe {
  const canvas = document.createElement("canvas");
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl") ?? (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
  } catch {
    gl = null;
  }
  if (!gl) return { ok: false, missing: ["WebGL"], renderer: null };
  const missing: string[] = [];
  if (!gl.getExtension("OES_texture_float")) missing.push("float textures (OES_texture_float)");
  if (!gl.getExtension("ANGLE_instanced_arrays")) missing.push("instanced drawing (ANGLE_instanced_arrays)");
  if (!((gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) as number) >= 1)) missing.push("vertex texture fetch");
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "") || null;
  // Give the context back now: a page holds only so many (Chromium: 16) and the oldest is the
  // one taken when it runs out, and this one has done its job.
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { ok: missing.length === 0, missing, renderer };
}

/** One line for a report: what was found, or what was missing. */
export function describeProbe(p: WebglProbe): string {
  const gpu = p.renderer ? ` on ${p.renderer}` : "";
  return p.ok ? `WebGL${gpu}` : `missing ${p.missing.join(", ")}${gpu}`;
}
