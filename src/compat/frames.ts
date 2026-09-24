import type { NativeCtx, Runtime } from "../jass/runtime";
import { asInt, asNum, asStr, jBool, jHandle, jInt, jStr, JNULL, truthy, type JassValue } from "../jass/values";
import { FdfLibrary } from "../ui/fdf/library";
import type { FdfFrame } from "../ui/fdf/parser";
import type { DataSource } from "../vfs/types";

// The 1.31 custom-UI FRAME API (docs/map-compatibility.md, step 5b).
//
// `BlzGetFrameByName` is the single most-called missing native in the corpus — 258 times in
// one map — and the family around it (`BlzCreateFrame`, `BlzFrameSetText`, `BlzFrameSetPoint`,
// `BlzGetOriginFrame`, `BlzLoadTOCFile`) is how a map built after 2019 puts its own panels,
// bars and buttons on the screen. None of it is declared by a 1.30.4 `common.j`; our own
// prelude declares it (src/compat/prelude.ts) and this file answers it.
//
// This is the MODEL: frames exist, they have names, parents, points, text, textures,
// visibility and enabled-ness, and the handles are stable, so a script that builds a panel,
// stores its frames in an array, compares two of them, hides one and reads
// `BlzFrameIsVisible` back behaves as it would in the real client. The DRAWING is
// `ui/scriptFrames.ts`, which reads `frameModel(rt)` every frame and lays it out with the same
// FDF solver and renderer the game's own panels use.
//
// Three shapes from the API decide the model:
//
//  * A frame is found by NAME plus a **create context** — `BlzGetFrameByName("MyBar", 3)` —
//    because one FDF template is instantiated many times over, once per row of whatever the
//    map is listing. So the key is the PAIR, never the name alone.
//  * `BlzCreateFrame("BoxedText", …)` stamps out an FDF TEMPLATE, and every NAMED frame inside
//    it becomes a frame of its own that the script then finds by name: Test of Balance creates
//    its tooltip box and fetches the title with `BlzGetFrameByName("BoxedTextTitle", 0)` on the
//    very next line. The templates come from the files the map's `.toc` lists
//    (`BlzLoadTOCFile`), read out of the map archive when the script asks.
//  * An ORIGIN frame is the game's own console furniture (the command card, the portrait, the
//    minimap, `ConsoleUIBackdrop`), asked for by `originframetype` + index or by name and never
//    created. They are interned, so the same frame asked for twice is the same handle — a
//    script does compare them.

/** One frame. Everything a script can set is on it, because everything a script can set it
 *  can also read back. */
export interface FrameObj {
  handleId: number;
  /** The FDF name — the template's for a stamped frame, the script's for a typed one (often
   *  ""), the origin frame's own name. */
  name: string;
  /** The instance index a map passes to tell one copy of a template from another. */
  createContext: number;
  /** An engine frame (`BlzGetOriginFrame`, or a name from an FDF we have not read) rather
   *  than one the map built. */
  origin: boolean;
  /** The frame TYPE ("BACKDROP", "TEXT", "FRAME", "BUTTON", …); "" for an origin frame. */
  type: string;
  /** The template a `BlzCreateFrame` root was stamped from; "" for everything else. */
  template: string;
  /** The template INSTANCE this frame is part of: its root's handle (the root's own for the
   *  root), 0 for a frame the script made by type. The drawing stamps an instance as a whole. */
  instance: number;
  /** `BlzCreateFrameByType`'s `inherits` — a template whose PROPERTIES the frame starts with. */
  inherits: string;
  parent: number; // handle id, 0 for the game UI root
  visible: boolean;
  enabled: boolean;
  alpha: number;
  scale: number;
  text: string;
  textSet: boolean;
  texture: string;
  textureSet: boolean;
  value: number;
  width: number;
  height: number;
  sized: boolean;
  /** Anchors, in the order they were set; at most one per FRAMEPOINT (a second SetPoint of the
   *  same point moves it). `relative` 0 with `relativePoint` -1 is an ABSOLUTE point. */
  points: Array<{ point: number; relative: number; relativePoint: number; x: number; y: number }>;
  /** `BlzFrameClearAllPoints` / `BlzFrameSetAllPoints` ran: a stamped frame's own FDF anchors
   *  are gone, not merely added to. */
  cleared: boolean;
  tooltip: number; // handle id of the frame shown as this one's tooltip, 0 for none
  /** This frame IS a tooltip — the engine shows it only while its owner is hovered. */
  tooltipOf: number;
}

/** What the drawing reads: every frame, the map's templates, and two counters that say
 *  whether anything moved since it last looked. */
export interface FrameModel {
  frames: Map<number, FrameObj>;
  /** The templates of every FDF a `.toc` brought in. Built with no file access at all — the
   *  sources arrive as text (`loadOverride`) — so it is safe to hold on the runtime. */
  lib: FdfLibrary;
  /** Those same FDF files as text, for the renderer's own library. */
  sources: Array<{ id: string; text: string }>;
  /** Bumped by everything that changes what is drawn or where. */
  revision: number;
  /** Bumped by a text change alone — the drawing patches those in place. */
  textRevision: number;
  /** Which frames' text changed since the drawing last took the set. */
  textChanged: Set<number>;
  /** frame → the FRAMEEVENT indices a trigger is registered for on it. */
  events: Map<number, Set<number>>;
}

const models = new WeakMap<Runtime, FrameModel>();

/** This runtime's frames (created on first use). */
export function frameModel(rt: Runtime): FrameModel {
  let m = models.get(rt);
  if (!m) {
    m = {
      frames: new Map(), lib: new FdfLibrary(NO_FILES), sources: [], revision: 0, textRevision: 0,
      textChanged: new Set(), events: new Map(),
    };
    models.set(rt, m);
  }
  return m;
}

/** The model's library never reads a file: its sources are handed over as text. */
const NO_FILES = {
  exists: () => false,
  read: () => Promise.reject(new Error("no files")),
  rawBytes: () => null,
  list: () => [],
} as unknown as DataSource;

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

const frame = (c: NativeCtx, v: JassValue): FrameObj | undefined => c.rt.data<FrameObj>(v);
const handleOf = (v: JassValue): number => (v.k === "handle" ? v.h : 0);

/** The key a frame is remembered under — the (createContext, name) pair the API itself keys
 *  on. The context leads so the number cannot run into the name. */
const registryKey = (name: string, createContext: number): string => `${createContext}:${name}`;

/** FRAMEPOINT_TOPLEFT (0) and FRAMEPOINT_BOTTOMRIGHT (8) — the two a SetAllPoints pins. */
const TOPLEFT = 0;
const BOTTOMRIGHT = 8;

function blankFrame(name: string, createContext: number, origin: boolean, parent: number, type: string): FrameObj {
  return {
    handleId: 0, name, createContext, origin, type, template: "", instance: 0, inherits: "", parent,
    visible: true, enabled: true, alpha: 255, scale: 1, text: "", textSet: false, texture: "",
    textureSet: false, value: 0, width: 0, height: 0, sized: false, points: [], cleared: false,
    tooltip: 0, tooltipOf: 0,
  };
}

export function registerFrameNatives(rt: Runtime): void {
  const byName = new Map<string, FrameObj>();
  const model = (c: NativeCtx): FrameModel => frameModel(c.rt);
  const bump = (c: NativeCtx): void => void model(c).revision++;
  const make = (c: NativeCtx, name: string, createContext: number, origin: boolean, parent: number, type: string): FrameObj => {
    const f = blankFrame(name, createContext, origin, parent, type);
    f.handleId = c.rt.handles.alloc(f);
    model(c).frames.set(f.handleId, f);
    byName.set(registryKey(name, createContext), f);
    bump(c);
    return f;
  };
  const out = (f: FrameObj | undefined): JassValue => (f ? jHandle(f.handleId, "framehandle") : JNULL);

  // --- the TOC ----------------------------------------------------------------------
  // A .toc lists the .fdf files a map wants loaded, one path per line, relative to the archive
  // root (Test of Balance: "BoxedText.fdf", "HeroIcon.fdf"). Each is read here, while the
  // script waits, and its frames join the template library — so the `BlzCreateFrame` on the
  // next line can stamp one out. With no file access at all (the headless tests) the answer is
  // TRUE, which is the question the script is really asking ("did my UI load?"): a map that
  // gets FALSE usually abandons its UI entirely.
  def(rt, "BlzLoadTOCFile", (c, a) => {
    const path = asStr(a[0]);
    const read = c.rt.hooks?.readMapFile;
    if (!read) return jBool(!!path);
    const toc = read(path);
    if (!toc) return jBool(false);
    const m = model(c);
    for (const line of new TextDecoder("latin1").decode(toc).split(/\r?\n/)) {
      const fdf = line.trim();
      if (!fdf || m.sources.some((s) => s.id === fdf)) continue;
      const bytes = read(fdf);
      if (!bytes) continue;
      const text = new TextDecoder("latin1").decode(bytes);
      m.lib.loadOverride(fdf, text);
      m.sources.push({ id: fdf, text });
    }
    bump(c);
    return jBool(true);
  });

  // --- creating ---------------------------------------------------------------------
  // Stamp a template: the root, and every NAMED frame inside it as a frame of its own, parented
  // the way the file nests them and registered under the same create context. A name no loaded
  // file defines still gets a frame — typed FRAME, and said once — because a null here would
  // silently end the script's UI function.
  const stamp = (c: NativeCtx, name: string, parent: number, ctx: number): FrameObj => {
    const tmpl = model(c).lib.resolveRoot(name);
    const root = make(c, name, ctx, false, parent, tmpl?.type ?? "FRAME");
    root.template = name;
    root.instance = root.handleId;
    if (!tmpl) {
      c.rt.warnOnce(`frame template ${name}`, "no loaded .fdf defines it — drawn as an empty FRAME");
      return root;
    }
    const walk = (node: FdfFrame, parentHandle: number): void => {
      for (const child of node.children) {
        let under = parentHandle;
        if (child.name) {
          const f = make(c, child.name, ctx, false, parentHandle, child.type);
          f.instance = root.handleId;
          under = f.handleId;
        }
        walk(child, under);
      }
    };
    walk(tmpl, root.handleId);
    return root;
  };
  def(rt, "BlzCreateFrame", (c, a) => out(stamp(c, asStr(a[0]), handleOf(a[1] ?? JNULL), asInt(a[3]))));
  def(rt, "BlzCreateSimpleFrame", (c, a) => out(stamp(c, asStr(a[0]), handleOf(a[1] ?? JNULL), asInt(a[2]))));
  // BlzCreateFrameByType(typeName, name, owner, inherits, createContext) — the one that needs
  // no FDF at all, which is why a map shipping no .fdf still builds a whole panel with it.
  def(rt, "BlzCreateFrameByType", (c, a) => {
    const f = make(c, asStr(a[1]), asInt(a[4]), false, handleOf(a[2] ?? JNULL), asStr(a[0]).toUpperCase() || "FRAME");
    f.inherits = asStr(a[3]);
    return out(f);
  });
  def(rt, "BlzDestroyFrame", (c, a) => {
    const f = frame(c, a[0]);
    if (!f || f.origin) return JNULL;
    const m = model(c);
    // A frame takes its children with it — and a stamped root its whole instance.
    const gone = (x: FrameObj): void => {
      for (const child of [...m.frames.values()]) if (child.parent === x.handleId) gone(child);
      m.frames.delete(x.handleId);
      m.events.delete(x.handleId);
      if (byName.get(registryKey(x.name, x.createContext)) === x) byName.delete(registryKey(x.name, x.createContext));
      c.rt.handles.free(x.handleId);
    };
    gone(f);
    bump(c);
    return JNULL;
  });

  // --- finding ----------------------------------------------------------------------
  def(rt, "BlzGetFrameByName", (c, a) => {
    const found = byName.get(registryKey(asStr(a[0]), asInt(a[1])));
    if (found) return out(found);
    // A name the script did not create is one of the game's own frames (`ConsoleUIBackdrop`)
    // or a frame from an FDF we have not read. Mint it rather than answering null: the script
    // is about to set something on it, and a null here silently kills the rest of its UI
    // function. It is an ORIGIN frame to the drawing — the parent a map hangs its panel on.
    return out(make(c, asStr(a[0]), asInt(a[1]), true, 0, ""));
  });
  def(rt, "BlzFrameGetName", (c, a) => jStr(frame(c, a[0])?.name ?? ""));

  def(rt, "BlzGetOriginFrame", (c, a) => {
    const type = c.rt.enumIndex(a[0] ?? JNULL);
    const index = asInt(a[1]);
    const id = c.rt.handles.intern(`originframe:${type}:${index}`, () => blankFrame(`OriginFrame${type}_${index}`, index, true, 0, ""));
    const f = c.rt.handles.get(id) as FrameObj;
    if (!f.handleId) {
      f.handleId = id;
      model(c).frames.set(id, f);
    }
    return jHandle(id, "framehandle");
  });
  // "Hide the whole 2003 console" — a full-screen custom UI's first call. It takes the ORIGIN
  // frames away (command card, hero bar, inventory, minimap and its buttons, portrait, the
  // system buttons, the tooltips) and leaves the console art, the resource bar and the black
  // `ConsoleUIBackdrop`, which a map hides by name (Tasyen, "UI: OriginFrames", hiveworkshop
  // 316034). The scene owns all of that (MapViewerScene.originHidden).
  def(rt, "BlzHideOriginFrames", (c, a) => {
    c.rt.hooks?.hideOriginFrames?.(truthy(a[0] ?? JNULL));
    return JNULL;
  });

  // --- setting ----------------------------------------------------------------------
  const set = (name: string, apply: (f: FrameObj, a: JassValue[], c: NativeCtx) => void): void => {
    def(rt, name, (c, a) => {
      const f = frame(c, a[0]);
      if (f) {
        apply(f, a, c);
        bump(c);
      }
      return JNULL;
    });
  };
  set("BlzFrameSetVisible", (f, a, c) => {
    f.visible = truthy(a[1]);
    // The one game frame whose visibility is ours to draw: the black behind the bottom console.
    if (f.origin && f.name === "ConsoleUIBackdrop") c.rt.hooks?.setConsoleBackdropVisible?.(f.visible);
  });
  set("BlzFrameSetEnable", (f, a) => { f.enabled = truthy(a[1]); });
  set("BlzFrameSetAlpha", (f, a) => { f.alpha = asInt(a[1]); });
  set("BlzFrameSetScale", (f, a) => { f.scale = asNum(a[1]); });
  set("BlzFrameSetTexture", (f, a) => { f.texture = asStr(a[1]); f.textureSet = true; });
  set("BlzFrameSetValue", (f, a) => { f.value = asNum(a[1]); });
  set("BlzFrameSetSize", (f, a) => { f.width = asNum(a[1]); f.height = asNum(a[2]); f.sized = true; });
  // The tooltip frame is the ENGINE's to show from then on: hidden until its owner is hovered.
  set("BlzFrameSetTooltip", (f, a, c) => {
    const tip = frame(c, a[1] ?? JNULL);
    f.tooltip = tip?.handleId ?? 0;
    if (tip) tip.tooltipOf = f.handleId;
  });
  set("BlzFrameClearAllPoints", (f) => { f.points = []; f.cleared = true; });
  // "Sets all points of frame to relative" — the frame covers `relative`, which stays whatever
  // it was in the hierarchy; it is NOT reparented. Two opposite corners say the same thing to
  // the solver and are what the game's own FDFs write for it.
  set("BlzFrameSetAllPoints", (f, a) => {
    const rel = handleOf(a[1] ?? JNULL);
    f.cleared = true;
    f.points = [
      { point: TOPLEFT, relative: rel, relativePoint: TOPLEFT, x: 0, y: 0 },
      { point: BOTTOMRIGHT, relative: rel, relativePoint: BOTTOMRIGHT, x: 0, y: 0 },
    ];
  });
  const anchor = (f: FrameObj, p: FrameObj["points"][number]): void => {
    f.points = f.points.filter((q) => q.point !== p.point);
    f.points.push(p);
  };
  set("BlzFrameSetPoint", (f, a, c) => {
    anchor(f, {
      point: c.rt.enumIndex(a[1] ?? JNULL), relative: handleOf(a[2] ?? JNULL),
      relativePoint: c.rt.enumIndex(a[3] ?? JNULL), x: asNum(a[4]), y: asNum(a[5]),
    });
  });
  // An ABSOLUTE point is anchored to the screen, which the model says with `relative` 0 and
  // no relative point rather than with a second list.
  set("BlzFrameSetAbsPoint", (f, a, c) => {
    anchor(f, { point: c.rt.enumIndex(a[1] ?? JNULL), relative: 0, relativePoint: -1, x: asNum(a[2]), y: asNum(a[3]) });
  });
  // Text is the one thing a map changes CONSTANTLY (Test of Balance rewrites every player's
  // damage total on every blow), so it bumps its own counter and names the frame: the drawing
  // patches those in place instead of rebuilding the panel. A map's frame text is authored text
  // like any other, so it carries TRIGSTR keys.
  def(rt, "BlzFrameSetText", (c, a) => {
    const f = frame(c, a[0]);
    if (f) {
      const text = c.rt.resolveTrigStr(asStr(a[1]));
      const first = !f.textSet;
      f.text = text;
      f.textSet = true;
      const m = model(c);
      if (first) m.revision++; // a frame that had no text of its own may not be in the tree
      m.textRevision++;
      m.textChanged.add(f.handleId);
    }
    return JNULL;
  });

  // --- reading ----------------------------------------------------------------------
  def(rt, "BlzFrameIsVisible", (c, a) => jBool(frame(c, a[0])?.visible ?? false));
  def(rt, "BlzFrameGetText", (c, a) => jStr(frame(c, a[0])?.text ?? ""));
  def(rt, "BlzFrameGetValue", (c, a) => jInt(Math.round(frame(c, a[0])?.value ?? 0)));
  def(rt, "BlzFrameGetParent", (c, a) => {
    const p = frame(c, a[0])?.parent ?? 0;
    return p ? jHandle(p, "framehandle") : JNULL;
  });

  // --- events -----------------------------------------------------------------------
  // BlzTriggerRegisterFrameEvent(trigger, frame, frameeventtype). The drawing raises them
  // (Interpreter.fireFrameEvent) and reads `events` to know which frames to listen on;
  // BlzGetTriggerFrame / BlzGetTriggerFrameEvent read the event that fired. `BlzFrameClick` is
  // the SCRIPT pressing its own button — a map driving its UI from a keyboard shortcut — and it
  // leaves the frame as the trigger frame.
  def(rt, "BlzTriggerRegisterFrameEvent", (c, a) => {
    const t = c.rt.data<{ handleId: number }>(a[0]);
    const f = frame(c, a[1] ?? JNULL);
    if (!t || !f) return JNULL;
    const eventIndex = c.rt.enumIndex(a[2] ?? JNULL);
    c.rt.triggerRegs.push({ kind: "frameEvent", trigId: t.handleId, params: [a[1], a[2] ?? JNULL] });
    const m = model(c);
    let set = m.events.get(f.handleId);
    if (!set) m.events.set(f.handleId, (set = new Set()));
    set.add(eventIndex);
    bump(c);
    return JNULL;
  });
  let clicked: JassValue = JNULL;
  def(rt, "BlzGetTriggerFrame", (c) => {
    const v = c.rt.eventResponse("TriggerFrame");
    return v.k === "handle" ? v : clicked;
  });
  def(rt, "BlzGetTriggerFrameEvent", (c) => c.rt.eventResponse("TriggerFrameEvent"));
  def(rt, "BlzFrameClick", (_c, a) => {
    clicked = a[0] ?? JNULL;
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
