// Camera natives (7.24 — issue #33; see docs/triggers.md).
//
// The top of the coverage ranking, and the half of "cinematics" that actually moves:
// `CreateCameraSetup` / `CameraSetupSetField` / `CameraSetupSetDestPosition` are 10 maps
// each, and the wider move family (`CameraSetupApply*`, `SetCameraField`, `PanCameraTo*`,
// `SetCameraTargetController`, `CameraSetTargetNoise`, `ResetToGameCamera`) rides on top of
// them. Every one was an unimplemented native, so a map's intro shot never happened.
//
// A `camerasetup` is not a camera. It is a **bag of camera FIELDS** plus a destination
// point — a saved shot, which the World Editor writes out of its camera tool verbatim:
//
//     set gg_cam_Monolith_Intro_Shot = CreateCameraSetup()                        // (4)Monolith
//     call CameraSetupSetField( …, CAMERA_FIELD_ROTATION,        77.7,   0.0 )
//     call CameraSetupSetField( …, CAMERA_FIELD_ANGLE_OF_ATTACK, 320.8,  0.0 )
//     call CameraSetupSetField( …, CAMERA_FIELD_TARGET_DISTANCE, 1363.6, 0.0 )
//     call CameraSetupSetField( …, CAMERA_FIELD_FIELD_OF_VIEW,   70.0,   0.0 )
//     call CameraSetupSetDestPosition( …, 1002.0, 3640.6, 0.0 )
//
// and `CameraSetupApply*` then blends the ONE live camera to it. There is no second camera
// in WC3 and there is none here: an apply is a set of tweens over the game camera we already
// own (src/render/scriptCamera.ts drives mapViewer's target/distance/yaw/pitch/fov).
//
// **The units are asymmetric, and blizzard.j proves it.** Every SETTER takes degrees, while
// `GetCameraField` returns RADIANS — look at `GetCurrentCameraSetup`, which reads the live
// camera back into a setup and has to convert on the way:
//
//     call CameraSetupSetField(theCam, CAMERA_FIELD_ANGLE_OF_ATTACK,
//                              bj_RADTODEG * GetCameraField(CAMERA_FIELD_ANGLE_OF_ATTACK), duration)
//
// So the EngineHooks boundary speaks degrees (the setters' units) and only `GetCameraField`
// converts — which keeps the quirk in the one native that owns it.
//
// Also note ANGLE_OF_ATTACK's sign: WC3's default is **304**, i.e. -56° — the angle of the
// camera's VIEW direction, negative because it looks down. Our `pitch` is the mirror image
// (the eye's elevation ABOVE the target), so pitch = -aoa. Trig is periodic, so 304° works
// out to the same sin/cos as -56° with no normalisation needed.

import type { CameraMove, JassUnit, NativeCtx, Runtime } from "../runtime";
import { asNum, jHandle, jReal, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** common.j's camerafield indices (ConvertCameraField). */
export const CAMERA_FIELD = {
  TARGET_DISTANCE: 0,
  FARZ: 1,
  ANGLE_OF_ATTACK: 2,
  FIELD_OF_VIEW: 3,
  ROLL: 4,
  ROTATION: 5,
  ZOFFSET: 6,
} as const;

/** The fields whose value is an ANGLE — the ones GetCameraField hands back in radians. */
const ANGLE_FIELDS = new Set<number>([
  CAMERA_FIELD.ANGLE_OF_ATTACK,
  CAMERA_FIELD.FIELD_OF_VIEW,
  CAMERA_FIELD.ROLL,
  CAMERA_FIELD.ROTATION,
]);

/** A `camerasetup` handle: the fields the script actually SET (so a setup that names only
 *  two of them applies only those two, rather than snapping the rest to a zero it never
 *  asked for), plus the destination point. */
interface CameraSetupObj {
  handleId: number;
  fields: Map<number, { value: number; duration: number }>;
  dest: { x: number; y: number; duration: number } | null;
}

/** A location handle, as natives/region.ts stores it. */
interface LocObj {
  x: number;
  y: number;
}

/** Build the move a setup describes. `duration`: null → each field keeps its own stored
 *  duration (CameraSetupApply), a number → that duration overrides every one of them
 *  (CameraSetupApplyForceDuration — which is what the GUI's "Apply camera object over N
 *  seconds" compiles to, via CameraSetupApplyForPlayer). */
function moveFromSetup(s: CameraSetupObj, doPan: boolean, duration: number | null, panDuration: number): CameraMove {
  const fields = [...s.fields].map(([field, f]) => ({ field, value: f.value, duration: duration ?? f.duration }));
  const move: CameraMove = { fields };
  if (doPan && s.dest) move.dest = { x: s.dest.x, y: s.dest.y, duration: panDuration };
  return move;
}

export function registerCameraNatives(rt: Runtime): void {
  // --- camerasetup: build a saved shot ---------------------------------------------
  def(rt, "CreateCameraSetup", (c) => {
    const s: CameraSetupObj = { handleId: 0, fields: new Map(), dest: null };
    s.handleId = c.rt.handles.alloc(s);
    return jHandle(s.handleId, "camerasetup");
  });
  def(rt, "CameraSetupSetField", (c, a) => {
    const s = c.rt.data<CameraSetupObj>(a[0]);
    if (s) s.fields.set(c.rt.enumIndex(a[1]), { value: asNum(a[2]), duration: asNum(a[3]) });
    return JNULL;
  });
  def(rt, "CameraSetupGetField", (c, a) => {
    const s = c.rt.data<CameraSetupObj>(a[0]);
    return jReal(s?.fields.get(c.rt.enumIndex(a[1]))?.value ?? 0);
  });
  def(rt, "CameraSetupSetDestPosition", (c, a) => {
    const s = c.rt.data<CameraSetupObj>(a[0]);
    if (s) s.dest = { x: asNum(a[1]), y: asNum(a[2]), duration: asNum(a[3]) };
    return JNULL;
  });
  def(rt, "CameraSetupGetDestPositionX", (c, a) => jReal(c.rt.data<CameraSetupObj>(a[0])?.dest?.x ?? 0));
  def(rt, "CameraSetupGetDestPositionY", (c, a) => jReal(c.rt.data<CameraSetupObj>(a[0])?.dest?.y ?? 0));
  def(rt, "CameraSetupGetDestPositionLoc", (c, a) => {
    const d = c.rt.data<CameraSetupObj>(a[0])?.dest;
    const loc: LocObj = { x: d?.x ?? 0, y: d?.y ?? 0 };
    return jHandle(c.rt.handles.alloc(loc), "location");
  });

  // --- camerasetup: apply it to the live camera --------------------------------------
  // CameraSetupApply(setup, doPan, panTimed): every field blends over its OWN stored
  // duration; the pan uses the destination's stored duration only if panTimed.
  def(rt, "CameraSetupApply", (c, a) => {
    const s = c.rt.data<CameraSetupObj>(a[0]);
    if (s) c.rt.hooks?.applyCamera?.(moveFromSetup(s, truthy(a[1]), null, truthy(a[2]) ? (s.dest?.duration ?? 0) : 0));
    return JNULL;
  });
  def(rt, "CameraSetupApplyWithZ", (c, a) => {
    const s = c.rt.data<CameraSetupObj>(a[0]);
    if (!s) return JNULL;
    const move = moveFromSetup(s, true, null, s.dest?.duration ?? 0);
    move.fields.push({ field: CAMERA_FIELD.ZOFFSET, value: asNum(a[1]), duration: 0 });
    c.rt.hooks?.applyCamera?.(move);
    return JNULL;
  });
  // The workhorse: CameraSetupApplyForPlayer (9 of the 10 camera-setup maps) is
  // `CameraSetupApplyForceDuration(setup, doPan, duration)` behind a GetLocalPlayer gate.
  def(rt, "CameraSetupApplyForceDuration", (c, a) => {
    const s = c.rt.data<CameraSetupObj>(a[0]);
    const dur = asNum(a[2]);
    if (s) c.rt.hooks?.applyCamera?.(moveFromSetup(s, truthy(a[1]), dur, dur));
    return JNULL;
  });
  def(rt, "CameraSetupApplyForceDurationWithZ", (c, a) => {
    const s = c.rt.data<CameraSetupObj>(a[0]);
    if (!s) return JNULL;
    const dur = asNum(a[2]);
    const move = moveFromSetup(s, true, dur, dur);
    move.fields.push({ field: CAMERA_FIELD.ZOFFSET, value: asNum(a[1]), duration: dur });
    c.rt.hooks?.applyCamera?.(move);
    return JNULL;
  });

  // --- the live camera, driven directly ---------------------------------------------
  def(rt, "SetCameraField", (c, a) => {
    c.rt.hooks?.applyCamera?.({ fields: [{ field: c.rt.enumIndex(a[0]), value: asNum(a[1]), duration: asNum(a[2]) }] });
    return JNULL;
  });
  // AdjustCameraField's offset is in the SETTER's units (degrees) — so it reads the live
  // field through the hook, which speaks degrees, NOT through GetCameraField (radians).
  def(rt, "AdjustCameraField", (c, a) => {
    const field = c.rt.enumIndex(a[0]);
    const cur = c.rt.hooks?.cameraField?.(field) ?? 0;
    c.rt.hooks?.applyCamera?.({ fields: [{ field, value: cur + asNum(a[1]), duration: asNum(a[2]) }] });
    return JNULL;
  });
  const pan = (c: NativeCtx, x: number, y: number, duration: number, z?: number): JassValue => {
    const move: CameraMove = { fields: [], dest: { x, y, duration } };
    if (z !== undefined) move.fields.push({ field: CAMERA_FIELD.ZOFFSET, value: z, duration });
    c.rt.hooks?.applyCamera?.(move);
    return JNULL;
  };
  def(rt, "PanCameraTo", (c, a) => pan(c, asNum(a[0]), asNum(a[1]), 0));
  def(rt, "PanCameraToTimed", (c, a) => pan(c, asNum(a[0]), asNum(a[1]), asNum(a[2])));
  def(rt, "PanCameraToWithZ", (c, a) => pan(c, asNum(a[0]), asNum(a[1]), 0, asNum(a[2])));
  def(rt, "PanCameraToTimedWithZ", (c, a) => pan(c, asNum(a[0]), asNum(a[1]), asNum(a[3]), asNum(a[2])));
  // SetCameraPosition / SetCameraQuickPosition JUMP the focus with no blend at all — they
  // are not a pan, which is why they live in natives/melee.ts on their own hook (7.3:
  // MeleeStartingUnits frames the view on the starting workers with one).

  def(rt, "ResetToGameCamera", (c, a) => (c.rt.hooks?.resetToGameCamera?.(asNum(a[0])), JNULL));
  def(rt, "StopCamera", (c) => (c.rt.hooks?.stopCamera?.(), JNULL));
  def(rt, "SetCameraRotateMode", (c, a) =>
    (c.rt.hooks?.cameraRotateMode?.(asNum(a[0]), asNum(a[1]), asNum(a[2]), asNum(a[3])), JNULL));
  def(rt, "SetCameraTargetController", (c, a) => {
    const u = c.rt.data<JassUnit>(a[0]);
    c.rt.hooks?.setCameraTargetUnit?.(u?.simId ?? -1, asNum(a[1]), asNum(a[2]), truthy(a[3]));
    return JNULL;
  });
  // SetCameraOrientController points the camera AT a unit while the eye stays put — a
  // different shot from the target controller, and one no bundled map asks for. Rather than
  // fake it, we release the controller: an unimplemented-native default would do nothing at
  // all, and this at least leaves the camera in a sane, script-visible state.
  def(rt, "SetCameraOrientController", (c) => (c.rt.hooks?.setCameraTargetUnit?.(-1, 0, 0, false), JNULL));

  // The shake. WarChasers rattles the screen with CameraSetTargetNoise(100, 800) when its
  // boss appears; blizzard.j's CameraSetEQNoiseForPlayer builds an earthquake out of the
  // same two numbers (magnitude × 2, magnitude × 10^richter). The …Ex variants add a
  // vertical-only flag; CameraClearNoiseForPlayer is just noise(0, 0).
  // (The …Ex arity is 3, the plain one 2 — so the vertOnly flag has to be read defensively,
  // or CameraSetTargetNoise(100, 800) throws on an argument that isn't there.)
  const noise = (source: boolean) => (c: NativeCtx, a: JassValue[]): JassValue =>
    (c.rt.hooks?.setCameraNoise?.(source, asNum(a[0]), asNum(a[1]), a[2] !== undefined && truthy(a[2])), JNULL);
  def(rt, "CameraSetTargetNoise", noise(false));
  def(rt, "CameraSetSourceNoise", noise(true));
  def(rt, "CameraSetTargetNoiseEx", noise(false));
  def(rt, "CameraSetSourceNoiseEx", noise(true));
  // CameraSetSmoothingFactor damps the camera's follow lag. Ours has none to damp, so this
  // is an explicit no-op — CinematicModeExBJ calls it (via CameraResetSmoothingFactorBJ) on
  // the way out of every cinematic, and it must not log as unimplemented.
  def(rt, "CameraSetSmoothingFactor", () => JNULL);

  // --- reading the camera back --------------------------------------------------------
  // GetCameraField is the ONE place radians appear (see the header): the hook speaks the
  // setters' degrees, and this converts on the way out — which is exactly what blizzard.j's
  // GetCurrentCameraSetup then undoes with bj_RADTODEG.
  def(rt, "GetCameraField", (c, a) => {
    const field = c.rt.enumIndex(a[0]);
    const v = c.rt.hooks?.cameraField?.(field) ?? 0;
    return jReal(ANGLE_FIELDS.has(field) ? (v * Math.PI) / 180 : v);
  });
  def(rt, "GetCameraTargetPositionX", (c) => jReal(c.rt.hooks?.cameraTarget?.().x ?? 0));
  def(rt, "GetCameraTargetPositionY", (c) => jReal(c.rt.hooks?.cameraTarget?.().y ?? 0));
  def(rt, "GetCameraTargetPositionZ", (c) => jReal(c.rt.hooks?.cameraTarget?.().z ?? 0));
  def(rt, "GetCameraTargetPositionLoc", (c) => {
    const t = c.rt.hooks?.cameraTarget?.() ?? { x: 0, y: 0, z: 0 };
    return jHandle(c.rt.handles.alloc({ x: t.x, y: t.y } satisfies LocObj), "location");
  });
  def(rt, "GetCameraEyePositionX", (c) => jReal(c.rt.hooks?.cameraEye?.().x ?? 0));
  def(rt, "GetCameraEyePositionY", (c) => jReal(c.rt.hooks?.cameraEye?.().y ?? 0));
  def(rt, "GetCameraEyePositionZ", (c) => jReal(c.rt.hooks?.cameraEye?.().z ?? 0));
  def(rt, "GetCameraEyePositionLoc", (c) => {
    const e = c.rt.hooks?.cameraEye?.() ?? { x: 0, y: 0, z: 0 };
    return jHandle(c.rt.handles.alloc({ x: e.x, y: e.y } satisfies LocObj), "location");
  });

  // Camera BOUNDS — the rect the focus is confined to (our mapBounds). SetCameraBounds is
  // called by every one of the 165 maps' main(), always with the map's own playable rect,
  // which the renderer already derives from the terrain: we keep owning it, so the setter
  // stays a no-op while the getters answer honestly. (GetCameraMargin is the editor's
  // per-side camera padding; we apply none, hence 0.)
  def(rt, "SetCameraBounds", () => JNULL);
  def(rt, "GetCameraMargin", () => jReal(0));
  const bounds = (pick: (b: { minX: number; minY: number; maxX: number; maxY: number }) => number) => (c: NativeCtx): JassValue =>
    jReal(pick(c.rt.hooks?.cameraBounds?.() ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }));
  def(rt, "GetCameraBoundMinX", bounds((b) => b.minX));
  def(rt, "GetCameraBoundMinY", bounds((b) => b.minY));
  def(rt, "GetCameraBoundMaxX", bounds((b) => b.maxX));
  def(rt, "GetCameraBoundMaxY", bounds((b) => b.maxY));

  // SetCinematicCamera points the camera at a .mdx CAMERA track authored in a model file
  // (the campaign's flythroughs). We don't play model-driven camera paths — explicit no-op,
  // and no bundled map uses one.
  def(rt, "SetCinematicCamera", () => JNULL);
}
