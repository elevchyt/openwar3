// The GL pipeline state our overlay passes save and restore, shadowed in JS.
//
// Every overlay (shadows, ubersplats, fog, weather) draws INTO mdx-m3-viewer's context and
// has to hand the state back exactly as it found it, because the viewer caches its own GL
// state in JS and will not re-set what it believes is already set. The obvious way to do that
// is to ask the driver — `gl.getParameter(gl.DEPTH_FUNC)` and friends — and that is what these
// passes used to do.
//
// Asking is not free, and it is not uniformly expensive either. Measured in Chrome on this
// engine's own frame (a 400-call loop against the live context):
//
//     DEPTH_FUNC, DEPTH_WRITEMASK, BLEND_SRC_RGB/DST_RGB/SRC_ALPHA/DST_ALPHA,
//     POLYGON_OFFSET_FACTOR/UNITS                                    ~38 µs each
//     CURRENT_PROGRAM, ARRAY_BUFFER_BINDING, ACTIVE_TEXTURE,
//     TEXTURE_BINDING_2D, isEnabled(...), getVertexAttrib(...)       ~0 µs
//
// A 400× gap, and it is not arbitrary: Chrome's WebGL implementation mirrors object bindings,
// capability flags and attribute enables on the renderer side, so those answer from memory —
// but the scalar pipeline state is not mirrored, so each read flushes the command queue and
// blocks on a round-trip to the GPU process. Four overlays querying eight of them apiece cost
// about 1.1 ms of a 16.7 ms frame doing nothing at all.
//
// So we mirror those eight ourselves. This patches the setters on the context INSTANCE, which
// means every caller sharing that context — mdx-m3-viewer very much included — keeps the
// shadow current just by drawing normally. Only the cheap queries are left to the driver.

/** The scalar state Chrome does not mirror. Everything else is free to ask for. */
export interface PipelineState {
  depthFunc: number;
  depthMask: boolean;
  blendSrcRGB: number;
  blendDstRGB: number;
  blendSrcAlpha: number;
  blendDstAlpha: number;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
}

export interface PipelineTracker {
  /** The state right now, read from the shadow — no driver round-trip. */
  save(): PipelineState;
  /** Put it back, issuing only the calls that actually change something. */
  restore(state: PipelineState): void;
}

type GL = WebGLRenderingContext;

const trackers = new WeakMap<GL, PipelineTracker>();

/**
 * The tracker for `gl`, installing it on first use. Safe to call from anywhere and in any
 * order: the shadow is seeded from the driver once, and from then on every setter updates it.
 */
export function pipelineState(gl: GL): PipelineTracker {
  const existing = trackers.get(gl);
  if (existing) return existing;

  // The one and only time we pay for these reads.
  const s: PipelineState = {
    depthFunc: gl.getParameter(gl.DEPTH_FUNC) as number,
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
    blendSrcRGB: gl.getParameter(gl.BLEND_SRC_RGB) as number,
    blendDstRGB: gl.getParameter(gl.BLEND_DST_RGB) as number,
    blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA) as number,
    blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA) as number,
    polygonOffsetFactor: gl.getParameter(gl.POLYGON_OFFSET_FACTOR) as number,
    polygonOffsetUnits: gl.getParameter(gl.POLYGON_OFFSET_UNITS) as number,
  };

  // Own properties shadowing the prototype's, so `gl.depthFunc(...)` from ANY caller lands
  // here first. The originals are kept per-context rather than off the prototype so a patched
  // context can never recurse into itself.
  const rawDepthFunc = gl.depthFunc.bind(gl);
  const rawDepthMask = gl.depthMask.bind(gl);
  const rawBlendFunc = gl.blendFunc.bind(gl);
  const rawBlendFuncSeparate = gl.blendFuncSeparate.bind(gl);
  const rawPolygonOffset = gl.polygonOffset.bind(gl);

  gl.depthFunc = (func: number): void => {
    s.depthFunc = func;
    rawDepthFunc(func);
  };
  gl.depthMask = (flag: boolean): void => {
    s.depthMask = flag;
    rawDepthMask(flag);
  };
  gl.blendFunc = (src: number, dst: number): void => {
    s.blendSrcRGB = s.blendSrcAlpha = src;
    s.blendDstRGB = s.blendDstAlpha = dst;
    rawBlendFunc(src, dst);
  };
  gl.blendFuncSeparate = (srcRGB: number, dstRGB: number, srcA: number, dstA: number): void => {
    s.blendSrcRGB = srcRGB;
    s.blendDstRGB = dstRGB;
    s.blendSrcAlpha = srcA;
    s.blendDstAlpha = dstA;
    rawBlendFuncSeparate(srcRGB, dstRGB, srcA, dstA);
  };
  gl.polygonOffset = (factor: number, units: number): void => {
    s.polygonOffsetFactor = factor;
    s.polygonOffsetUnits = units;
    rawPolygonOffset(factor, units);
  };

  const tracker: PipelineTracker = {
    save: () => ({ ...s }),
    restore: (prev) => {
      // Only what changed: an overlay that left the state alone should cost nothing, and a
      // redundant GL call is still a command in the queue.
      if (prev.depthFunc !== s.depthFunc) gl.depthFunc(prev.depthFunc);
      if (prev.depthMask !== s.depthMask) gl.depthMask(prev.depthMask);
      if (
        prev.blendSrcRGB !== s.blendSrcRGB || prev.blendDstRGB !== s.blendDstRGB ||
        prev.blendSrcAlpha !== s.blendSrcAlpha || prev.blendDstAlpha !== s.blendDstAlpha
      ) {
        gl.blendFuncSeparate(prev.blendSrcRGB, prev.blendDstRGB, prev.blendSrcAlpha, prev.blendDstAlpha);
      }
      if (prev.polygonOffsetFactor !== s.polygonOffsetFactor || prev.polygonOffsetUnits !== s.polygonOffsetUnits) {
        gl.polygonOffset(prev.polygonOffsetFactor, prev.polygonOffsetUnits);
      }
    },
  };
  trackers.set(gl, tracker);
  return tracker;
}
