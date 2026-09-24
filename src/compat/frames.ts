import type { NativeCtx, Runtime } from "../jass/runtime";
import { asInt, asNum, asStr, jBool, jHandle, jInt, jStr, JNULL, truthy, type JassValue } from "../jass/values";

// The 1.31 custom-UI FRAME API, as an object model (docs/map-compatibility.md, step 5b).
//
// `BlzGetFrameByName` is the single most-called missing native in the corpus — 258 times in
// one map — and the family around it (`BlzCreateFrame`, `BlzFrameSetText`, `BlzFrameSetPoint`,
// `BlzGetOriginFrame`, `BlzLoadTOCFile`) is how a map built after 2019 puts its own panels,
// bars and buttons on the screen. None of it is declared by a 1.30.4 `common.j`; our own
// prelude declares it (src/compat/prelude.ts) and this file answers it.
//
// **What this is and is not.** It is the MODEL — frames exist, they have names, parents,
// points, text, textures, visibility and enabled-ness, and the handles are stable, so a script
// that builds a panel, stores its frames in an array, compares two of them, hides one and
// reads `BlzFrameIsVisible` back behaves as it would in the real client. It is not yet the
// RENDERING: nothing here draws, so a map's extra UI is ABSENT rather than wrong.
//
// That split is deliberate, and it is the difference between a map that runs and a map that
// crashes quietly. Before this, `BlzGetFrameByName` returned the typed default — null — and
// every following call in the map's UI code was a null dereference dressed up as a no-op,
// which is how a script skips the rest of the function it was in. A frame that exists and
// remembers is the smallest thing that keeps the SCRIPT correct, and it is the object the
// renderer will hang off when the drawing lands.
//
// Two shapes from the API decide the model:
//
//  * A frame is found by NAME plus a **create context** — `BlzGetFrameByName("MyBar", 3)` —
//    because one FDF template is instantiated many times over, once per row of whatever the
//    map is listing. So the key is the PAIR, never the name alone.
//  * An ORIGIN frame is the game's own console furniture (the command card, the portrait, the
//    minimap, the hero bar), asked for by `originframetype` + index and never created. They
//    are interned, so the same button asked for twice is the same handle — a script does
//    compare them.

/** One frame. Everything a script can set is on it, because everything a script can set it
 *  can also read back. */
export interface FrameObj {
  handleId: number;
  /** The FDF template name, or the origin frame's own name. */
  name: string;
  /** The instance index a map passes to tell one copy of a template from another. */
  createContext: number;
  /** An engine frame (`BlzGetOriginFrame`, or a name from an FDF we have not read) rather
   *  than one the map built. */
  origin: boolean;
  parent: number; // handle id, 0 for the game UI root
  visible: boolean;
  enabled: boolean;
  alpha: number;
  scale: number;
  text: string;
  texture: string;
  value: number;
  width: number;
  height: number;
  /** Anchors, in the order they were set. An empty list is `BlzFrameSetAllPoints`'s "fill the
   *  parent", which is what most of a map's frames do. */
  points: Array<{ point: number; relative: number; relativePoint: number; x: number; y: number }>;
  tooltip: number; // handle id of the frame shown as this one's tooltip, 0 for none
}

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const frame = (c: NativeCtx, v: JassValue): FrameObj | undefined => c.rt.data<FrameObj>(v);
const handleOf = (v: JassValue): number => (v.k === "handle" ? v.h : 0);

/** The key a frame is remembered under — the (createContext, name) pair the API itself keys
 *  on. The context leads so the number cannot run into the name. */
const registryKey = (name: string, createContext: number): string => `${createContext}:${name}`;

function makeFrame(rt: Runtime, name: string, createContext: number, origin: boolean, parent: number): FrameObj {
  const f: FrameObj = {
    handleId: 0, name, createContext, origin, parent,
    visible: true, enabled: true, alpha: 255, scale: 1, text: "", texture: "", value: 0,
    width: 0, height: 0, points: [], tooltip: 0,
  };
  f.handleId = rt.handles.alloc(f);
  return f;
}

export function registerFrameNatives(rt: Runtime): void {
  const byName = new Map<string, FrameObj>();
  const remember = (f: FrameObj): FrameObj => {
    byName.set(registryKey(f.name, f.createContext), f);
    return f;
  };
  /** The frame currently firing a frame event — `BlzGetTriggerFrame`'s answer. */
  let triggerFrame: JassValue = JNULL;

  // --- the TOC ----------------------------------------------------------------------
  // A .toc lists the .fdf files a map wants loaded. We answer TRUE for any named file, which
  // is the question the script is really asking ("did my UI load?") and the only half of it
  // we can answer without the templates: a map that gets FALSE here usually abandons its UI
  // entirely, over a file that is sitting in its own archive.
  def(rt, "BlzLoadTOCFile", (_c, a) => jBool(!!asStr(a[0])));

  // --- creating ---------------------------------------------------------------------
  def(rt, "BlzCreateFrame", (c, a) =>
    jHandle(remember(makeFrame(c.rt, asStr(a[0]), asInt(a[3]), false, handleOf(a[1] ?? JNULL))).handleId, "framehandle"));
  def(rt, "BlzCreateSimpleFrame", (c, a) =>
    jHandle(remember(makeFrame(c.rt, asStr(a[0]), asInt(a[2]), false, handleOf(a[1] ?? JNULL))).handleId, "framehandle"));
  // BlzCreateFrameByType(typeName, name, owner, inherits, createContext) — the one that needs
  // no FDF at all, which is why a map shipping no .fdf still builds a whole panel with it.
  def(rt, "BlzCreateFrameByType", (c, a) =>
    jHandle(remember(makeFrame(c.rt, asStr(a[1]), asInt(a[4]), false, handleOf(a[2] ?? JNULL))).handleId, "framehandle"));
  def(rt, "BlzDestroyFrame", (c, a) => {
    const f = frame(c, a[0]);
    if (f) {
      byName.delete(registryKey(f.name, f.createContext));
      c.rt.handles.free(f.handleId);
    }
    return JNULL;
  });

  // --- finding ----------------------------------------------------------------------
  def(rt, "BlzGetFrameByName", (c, a) => {
    const found = byName.get(registryKey(asStr(a[0]), asInt(a[1])));
    if (found) return jHandle(found.handleId, "framehandle");
    // A name the script did not create is a frame from an FDF we have not read. Mint it
    // rather than answering null: the script is about to set something on it, and a null
    // here silently kills the rest of its UI function.
    return jHandle(remember(makeFrame(c.rt, asStr(a[0]), asInt(a[1]), true, 0)).handleId, "framehandle");
  });
  def(rt, "BlzFrameGetName", (c, a) => jStr(frame(c, a[0])?.name ?? ""));

  def(rt, "BlzGetOriginFrame", (c, a) => {
    const type = c.rt.enumIndex(a[0] ?? JNULL);
    const index = asInt(a[1]);
    const id = c.rt.handles.intern(`originframe:${type}:${index}`, () => ({
      handleId: 0, name: `OriginFrame${type}_${index}`, createContext: index, origin: true, parent: 0,
      visible: true, enabled: true, alpha: 255, scale: 1, text: "", texture: "", value: 0,
      width: 0, height: 0, points: [], tooltip: 0,
    } as FrameObj));
    (c.rt.handles.get(id) as FrameObj).handleId = id;
    return jHandle(id, "framehandle");
  });
  // "Hide the whole 2003 console" — a full-screen custom UI's first call. Recorded and not
  // obeyed: taking the real console down is a HUD change and belongs with the drawing, and
  // obeying it now would leave the player with no console and no replacement.
  def(rt, "BlzHideOriginFrames", (c) => {
    c.rt.warnOnce("BlzHideOriginFrames", "the map's own UI is not drawn yet — the console stays up");
    return JNULL;
  });

  // --- setting ----------------------------------------------------------------------
  const set = (name: string, apply: (f: FrameObj, a: JassValue[], c: NativeCtx) => void): void => {
    def(rt, name, (c, a) => {
      const f = frame(c, a[0]);
      if (f) apply(f, a, c);
      return JNULL;
    });
  };
  set("BlzFrameSetVisible", (f, a) => { f.visible = truthy(a[1]); });
  set("BlzFrameSetEnable", (f, a) => { f.enabled = truthy(a[1]); });
  set("BlzFrameSetAlpha", (f, a) => { f.alpha = asInt(a[1]); });
  set("BlzFrameSetScale", (f, a) => { f.scale = asNum(a[1]); });
  // A map's frame text is authored text like any other, so it carries TRIGSTR keys.
  set("BlzFrameSetText", (f, a, c) => { f.text = c.rt.resolveTrigStr(asStr(a[1])); });
  set("BlzFrameSetTexture", (f, a) => { f.texture = asStr(a[1]); });
  set("BlzFrameSetValue", (f, a) => { f.value = asNum(a[1]); });
  set("BlzFrameSetSize", (f, a) => { f.width = asNum(a[1]); f.height = asNum(a[2]); });
  set("BlzFrameSetTooltip", (f, a) => { f.tooltip = handleOf(a[1] ?? JNULL); });
  set("BlzFrameClearAllPoints", (f) => { f.points = []; });
  set("BlzFrameSetAllPoints", (f, a) => { f.points = []; f.parent = handleOf(a[1] ?? JNULL) || f.parent; });
  set("BlzFrameSetPoint", (f, a, c) => {
    f.points.push({
      point: c.rt.enumIndex(a[1] ?? JNULL), relative: handleOf(a[2] ?? JNULL),
      relativePoint: c.rt.enumIndex(a[3] ?? JNULL), x: asNum(a[4]), y: asNum(a[5]),
    });
  });
  // An ABSOLUTE point is anchored to the screen, which the model says with `relative` 0 and
  // no relative point rather than with a second list.
  set("BlzFrameSetAbsPoint", (f, a, c) => {
    f.points.push({ point: c.rt.enumIndex(a[1] ?? JNULL), relative: 0, relativePoint: -1, x: asNum(a[2]), y: asNum(a[3]) });
  });

  // --- reading ----------------------------------------------------------------------
  def(rt, "BlzFrameIsVisible", (c, a) => jBool(frame(c, a[0])?.visible ?? false));
  def(rt, "BlzFrameGetText", (c, a) => jStr(frame(c, a[0])?.text ?? ""));
  def(rt, "BlzFrameGetValue", (c, a) => jInt(Math.round(frame(c, a[0])?.value ?? 0)));

  // --- events -----------------------------------------------------------------------
  // Nothing raises them: a frame nobody draws is a frame nobody can click. The registration
  // says so once instead of silently accepting a trigger that will never run. `BlzFrameClick`
  // is the SCRIPT pressing its own button — a real thing a map does to drive its UI from a
  // keyboard shortcut — so it at least leaves the frame as the trigger frame.
  def(rt, "BlzTriggerRegisterFrameEvent", (c) => {
    c.rt.warnOnce("BlzTriggerRegisterFrameEvent", "frame events are not raised — the map's own UI is not drawn yet");
    return JNULL;
  });
  def(rt, "BlzGetTriggerFrame", () => triggerFrame);
  def(rt, "BlzGetTriggerFrameEvent", () => JNULL);
  def(rt, "BlzFrameClick", (_c, a) => {
    triggerFrame = a[0] ?? JNULL;
    return JNULL;
  });

  // --- the minimap's terrain picture ------------------------------------------------
  // A map swaps the minimap image for its own art. The standard reason is a Reforged editor
  // habit: saving a map OVERWRITES war3mapMap.blp with a generated minimap, so a map that wants
  // its own preview picture on the lobby screen puts that picture in war3mapMap.blp and hands
  // the real minimap back at init — "call BlzChangeMinimapTerrainTex(\"war3mapMap_ingame.blp\")"
  // is exactly what the ReforgedMapPreviewReplacer tool writes (github.com/inwc3). Test of
  // Balance does it by hand with `war3mapImported\miniMap.blp`, and without this its minimap was
  // its lobby splash — five heroes posing — for the whole match.
  def(rt, "BlzChangeMinimapTerrainTex", (c, a) => jBool(c.rt.hooks?.changeMinimapTerrainTex?.(asStr(a[0])) ?? false));
}
