// The script's camera (7.24 — issue #33; see docs/triggers.md).
//
// WC3 has exactly ONE camera. `CameraSetupApply`, `SetCameraField` and `PanCameraTo*` do not
// create a second, cinematic one — they move the camera the player is already looking
// through, over a duration. So this class owns no camera either: it is a bag of **tweens
// over the game camera we already have** (mapViewer's target / distance / yaw / pitch / fov),
// plus the three modes that outlive a tween — riding a unit, orbiting a point, and shaking.
//
// The consequence worth stating, because it's what makes the model right: a tween ENDS and
// then lets go. Once a 6-second pan lands, nothing here writes the focus any more and the
// player's own scrolling takes over from exactly where the shot finished — which is what WC3
// does, and why a map that wants the normal camera back has to ask for it (ResetToGameCamera)
// rather than simply waiting.

/** The live camera, in the units the JASS setters speak. Angles are DEGREES here (see the
 *  radian asymmetry documented in jass/natives/camera.ts); mapViewer converts at the edge. */
export interface CameraState {
  targetX: number;
  targetY: number;
  /** CAMERA_FIELD_ZOFFSET — the focus's height above the ground plane. */
  zOffset: number;
  /** CAMERA_FIELD_TARGET_DISTANCE — eye-to-focus distance in world units. */
  distance: number;
  /** CAMERA_FIELD_ROTATION — the compass bearing the camera looks along. WC3's default is
   *  90 (looking north), which is also ours. */
  rotationDeg: number;
  /** CAMERA_FIELD_ANGLE_OF_ATTACK — the VIEW direction's tilt, negative because it looks
   *  down. WC3's default is 304 (i.e. -56°). */
  aoaDeg: number;
  /** CAMERA_FIELD_FIELD_OF_VIEW — vertical FOV. WC3's default is 70; ours is 45, and the
   *  game camera keeps ours until a script says otherwise. */
  fovDeg: number;
  /** CAMERA_FIELD_ROLL — rotation about the view axis. Zero in every bundled map. */
  rollDeg: number;
  /** CAMERA_FIELD_FARZ — far clip plane. 0 means "derive it from the distance", which is
   *  what the game camera does. */
  farZ: number;
}

/** The seven common.j camerafield indices, in the order ConvertCameraField numbers them.
 *  (targetX/targetY are NOT fields — the destination point is its own thing.) */
type FieldKey = Exclude<keyof CameraState, "targetX" | "targetY">;
const FIELD_KEYS: FieldKey[] = [
  "distance", // 0 CAMERA_FIELD_TARGET_DISTANCE
  "farZ", // 1 CAMERA_FIELD_FARZ
  "aoaDeg", // 2 CAMERA_FIELD_ANGLE_OF_ATTACK
  "fovDeg", // 3 CAMERA_FIELD_FIELD_OF_VIEW
  "rollDeg", // 4 CAMERA_FIELD_ROLL
  "rotationDeg", // 5 CAMERA_FIELD_ROTATION
  "zOffset", // 6 CAMERA_FIELD_ZOFFSET
];
const FIELD_ROTATION = 5;

/** The fields that are ANGLES ON A CIRCLE, and so must blend along the SHORTEST arc.
 *
 *  This is not a nicety — it is the difference between a camera tilt and a barrel roll.
 *  Monolith's intro shot stores ANGLE_OF_ATTACK as **320.8**, and the game camera's is
 *  **-54.4**: the same tilt written 375° apart. Blend the raw numbers and the camera sweeps
 *  320.8 → 238 → 159 → 75 → -44.9 over the six seconds, i.e. it pitches through the horizon,
 *  goes fully upside-down, and comes back — while the map thinks it asked for a 15° nudge.
 *  Only the live run showed it; every headless check passed, because each endpoint was right.
 *  (FIELD_OF_VIEW is deliberately NOT here: a lens angle is a magnitude, not a bearing.) */
const CIRCULAR_FIELDS = new Set<number>([2 /* ANGLE_OF_ATTACK */, 4 /* ROLL */, 5 /* ROTATION */]);

/** Shortest signed way round from `from` to `to`, in degrees. */
function shortestArc(from: number, to: number): number {
  return from + (((to - from) % 360) + 540) % 360 - 180;
}

/** One field easing from `from` to `to` over `dur` seconds. `dur` 0 means "snap". */
interface Tween {
  from: number;
  to: number;
  t: number;
  dur: number;
}

export interface CameraMove {
  fields: Array<{ field: number; value: number; duration: number }>;
  dest?: { x: number; y: number; duration: number };
}

/** WC3's camera noise has no published formula and lives in no data file, so this is an
 *  approximation with the right two knobs: `magnitude` is the displacement in world units and
 *  `velocity` sets how fast the shake oscillates. The two calls we can calibrate against are
 *  WarChasers' boss rumble — `CameraSetTargetNoise(100, 800)` — and blizzard.j's own
 *  earthquake, `CameraSetEQNoiseForPlayer`, which builds `(magnitude × 2, magnitude × 10^richter)`
 *  — so velocity climbs into the hundreds of thousands and is plainly a RATE, not a speed.
 *  Reading it as `velocity / magnitude` cycles per second puts WarChasers at a believable 8 Hz
 *  and clamps the quake to a violent buzz. */
const NOISE_MIN_HZ = 0.5;
const NOISE_MAX_HZ = 30;

interface Noise {
  magnitude: number;
  velocity: number;
  vertOnly: boolean;
}

export class ScriptCamera {
  /** Field index → tween. A field with no tween is one the script isn't currently moving. */
  private tweens = new Map<number, Tween>();
  private panX: Tween | null = null;
  private panY: Tween | null = null;

  /** SetCameraTargetController — the camera rides this sim unit (-1 = nobody). */
  private followUnit = -1;
  private followOffX = 0;
  private followOffY = 0;

  /** SetCameraRotateMode — orbit (pivotX, pivotY), sweeping `radians` over `dur`. */
  private orbit: { x: number; y: number; from: number; sweep: number; t: number; dur: number } | null = null;

  private targetNoise: Noise = { magnitude: 0, velocity: 0, vertOnly: false };
  private sourceNoise: Noise = { magnitude: 0, velocity: 0, vertOnly: false };
  private noiseT = 0;

  /** The default gameplay camera — what ResetToGameCamera blends back to. Handed in by the
   *  renderer, because it is the renderer's own camera that defines "normal", not WC3's
   *  (our FOV is 45°, not 70°, and everything else is tuned around it). */
  constructor(private readonly gameCamera: () => Omit<CameraState, "targetX" | "targetY">) {}

  /** True while anything here is still driving the camera — a tween in flight, a followed
   *  unit, an orbit, or a shake. The renderer uses it to know when to stop asking. */
  get active(): boolean {
    return (
      this.tweens.size > 0 ||
      !!this.panX ||
      !!this.panY ||
      this.followUnit >= 0 ||
      !!this.orbit ||
      this.targetNoise.magnitude > 0 ||
      this.sourceNoise.magnitude > 0
    );
  }

  /** CameraSetupApply* / SetCameraField / PanCameraTo* — all one operation.
   *
   *  A **zero-duration move lands NOW**, written straight into `cam` rather than queued as a
   *  tween that resolves next frame. That is not an optimisation, it is the semantics — and
   *  Monolith's intro is the proof. Its trigger reads:
   *
   *      call CameraSetupApplyForPlayer( true, gg_cam_Monolith_Intro_Shot, GetEnumPlayer(), 0 )
   *      call ResetToGameCameraForPlayer( GetEnumPlayer(), udg_cinematicDuration )
   *
   *  — snap to the shot, then drift home from it over six seconds. Defer the snap by even one
   *  frame and the reset on the next line reads the camera the shot hasn't touched yet, so it
   *  blends the game camera back to the game camera: the intro shot never appears at all. */
  apply(move: CameraMove, cam: CameraState): void {
    for (const f of move.fields) {
      const key = FIELD_KEYS[f.field];
      if (!key) continue;
      // FARZ 0 out of a camera setup would clip the whole world away; treat it as "unset"
      // and let the game camera's derived far plane stand.
      if (key === "farZ" && f.value <= 0) continue;
      if (f.duration <= 0) {
        this.tweens.delete(f.field);
        cam[key] = f.value;
      } else {
        this.tween(f.field, cam[key], f.value, f.duration);
      }
    }
    if (move.dest) {
      // An explicit pan overrides a unit the camera was riding — WC3's target controller and
      // a scripted pan are the same channel, and the last caller wins.
      this.followUnit = -1;
      if (move.dest.duration <= 0) {
        this.panX = null;
        this.panY = null;
        cam.targetX = move.dest.x;
        cam.targetY = move.dest.y;
      } else {
        this.panX = mkTween(cam.targetX, move.dest.x, move.dest.duration);
        this.panY = mkTween(cam.targetY, move.dest.y, move.dest.duration);
      }
    }
  }

  /** ResetToGameCamera(duration) — every field eases back to the gameplay default. The focus
   *  is deliberately left where the cinematic parked it: WC3 restores the camera's SHAPE, not
   *  its position (Monolith's intro leans on exactly this — the shot drifts back to a normal
   *  camera in place over 6 s while the screen fades out). */
  resetToGameCamera(duration: number, cam: CameraState): void {
    const g = this.gameCamera();
    for (let i = 0; i < FIELD_KEYS.length; i++) this.tween(i, cam[FIELD_KEYS[i]], g[FIELD_KEYS[i]], duration);
    this.followUnit = -1;
    this.orbit = null;
  }

  /** StopCamera — freeze every blend where it stands (the values already written stay). */
  stop(): void {
    this.tweens.clear();
    this.panX = null;
    this.panY = null;
    this.orbit = null;
  }

  setTargetUnit(unitId: number, offX: number, offY: number): void {
    this.followUnit = unitId;
    this.followOffX = offX;
    this.followOffY = offY;
    if (unitId >= 0) {
      // Following overrides an in-flight pan, for the same reason a pan overrides following.
      this.panX = null;
      this.panY = null;
    }
  }

  setRotateMode(x: number, y: number, radians: number, duration: number, cam: CameraState): void {
    this.orbit = { x, y, from: cam.rotationDeg, sweep: (radians * 180) / Math.PI, t: 0, dur: Math.max(0, duration) };
    this.tweens.delete(FIELD_ROTATION); // the orbit owns the rotation now
  }

  setNoise(source: boolean, magnitude: number, velocity: number, vertOnly: boolean): void {
    const n = { magnitude: Math.max(0, magnitude), velocity: Math.max(0, velocity), vertOnly };
    if (source) this.sourceNoise = n;
    else this.targetNoise = n;
  }

  /** How far the EYE is displaced by source noise this frame (world units). The renderer adds
   *  it after deriving the eye, so the shot rattles without moving what it looks at. */
  eyeShake(): [number, number, number] {
    return this.shake(this.sourceNoise, 7);
  }

  /** Advance every blend and write the result into `cam`. `dt` is SECONDS.
   *
   *  `unitPos` resolves the followed unit (SetCameraTargetController); returning null means it
   *  died, and the camera simply stops following — it does not snap anywhere. */
  update(dt: number, cam: CameraState, unitPos: (simId: number) => { x: number; y: number } | null): void {
    for (const [field, tw] of [...this.tweens]) {
      const key = FIELD_KEYS[field];
      cam[key] = step(tw, dt);
      if (tw.t >= tw.dur) this.tweens.delete(field);
    }

    if (this.orbit) {
      // An orbit is a rotation sweep about a FIXED focus: pin the focus to the pivot and turn
      // the bearing, and the eye — which is derived from focus + bearing + distance — circles
      // the point. (RotateCameraAroundLocBJ is the GUI's "rotate camera N degrees around P".)
      const o = this.orbit;
      o.t = Math.min(o.dur, o.t + dt);
      cam.rotationDeg = o.from + o.sweep * (o.dur > 0 ? o.t / o.dur : 1);
      cam.targetX = o.x;
      cam.targetY = o.y;
      if (o.t >= o.dur) this.orbit = null;
    }

    if (this.panX) {
      cam.targetX = step(this.panX, dt);
      if (this.panX.t >= this.panX.dur) this.panX = null;
    }
    if (this.panY) {
      cam.targetY = step(this.panY, dt);
      if (this.panY.t >= this.panY.dur) this.panY = null;
    }

    if (this.followUnit >= 0) {
      const p = unitPos(this.followUnit);
      if (p) {
        cam.targetX = p.x + this.followOffX;
        cam.targetY = p.y + this.followOffY;
      } else {
        this.followUnit = -1;
      }
    }

    this.noiseT += dt;
    if (this.targetNoise.magnitude > 0) {
      const [nx, ny] = this.shake(this.targetNoise, 0);
      cam.targetX += nx;
      cam.targetY += ny;
    }
  }

  /** A magnitude-bounded wobble. Three incommensurable sines per axis so it never visibly
   *  repeats, driven at `velocity / magnitude` Hz (see the NOISE_* note above). */
  private shake(n: Noise, phase: number): [number, number, number] {
    if (n.magnitude <= 0) return [0, 0, 0];
    const hz = Math.min(NOISE_MAX_HZ, Math.max(NOISE_MIN_HZ, n.velocity / Math.max(1, n.magnitude)));
    const t = (this.noiseT + phase) * hz * Math.PI * 2;
    const wob = (a: number, b: number): number => (Math.sin(t * a) + Math.sin(t * b * 1.618)) * 0.5;
    const z = n.magnitude * wob(1.0, 0.37);
    if (n.vertOnly) return [0, 0, z]; // CameraSet*NoiseEx(…, vertOnly) — an earthquake bucks, it doesn't slide
    return [n.magnitude * wob(1.13, 0.61), n.magnitude * wob(0.87, 1.29), z];
  }

  private tween(field: number, from: number, to: number, duration: number): void {
    this.tweens.set(field, mkTween(from, CIRCULAR_FIELDS.has(field) ? shortestArc(from, to) : to, duration));
  }
}

function mkTween(from: number, to: number, duration: number): Tween {
  return { from, to, t: 0, dur: Math.max(0, duration) };
}

/** Advance a tween and return its current value. WC3 eases a camera blend in and out (a
 *  scripted pan does not start or stop dead), so a smoothstep rather than a straight lerp. */
function step(tw: Tween, dt: number): number {
  tw.t = Math.min(tw.dur, tw.t + dt);
  if (tw.dur <= 0) {
    tw.t = tw.dur;
    return tw.to;
  }
  const x = tw.t / tw.dur;
  const s = x * x * (3 - 2 * x);
  return tw.from + (tw.to - tw.from) * s;
}
