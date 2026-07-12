// The trigger's AUDIO output — sounds + music (Phase 7.20 — issue #33; see docs/triggers.md).
//
// Custom maps were silent apart from unit/combat sounds: every one of the `sound` natives
// was a no-op, so a map's dialogue, its ambience and its music simply never played.
//
// This is a BRIDGE, not a new audio engine. src/audio/sounds.ts already had the hard parts
// — MPQ Huffman+ADPCM decode, positional PannerNodes with WC3's MinDistance/MaxDistance/
// DistanceCutoff falloff, and label lookup over the UI\SoundInfo SLKs. What was missing was
// the JASS `sound` handle in front of it.
//
// The shape of that handle is the thing to get right, and it is unusual: a `sound` is NOT a
// clip you fire, it's a **configured playback object** the map builds once and reuses. Every
// map with sounds emits the same InitSounds() (verified across the 165 bundled maps —
// all 27 that ship a war3map.w3s also emit CreateSound in their script, which is why we
// need no .w3s parser: the World Editor re-emits the sound definitions AS the script):
//
//     set gg_snd_N03Tyrande01 = CreateSound("Sound\Dialogue\…\N03Tyrande01.mp3", false, …)
//     call SetSoundParamsFromLabel(gg_snd_N03Tyrande01, "N03Tyrande01")   // ← DialogSounds.slk
//     call SetSoundDuration(gg_snd_N03Tyrande01, 14158)
//
// …then Starts / Stops / repositions *that same handle* for the rest of the game. So the
// natives here mostly mutate a SoundObj record (src/jass/runtime.ts), and only StartSound /
// StopSound reach the engine.
//
// Two semantics worth naming, both read off the sources rather than guessed:
//
//  • SetSoundParamsFromLabel sets PARAMS, never the FILE. A label's row usually lists
//    several variants ("HeroDeathKnightPissed" → six WAVs), but the map picked exactly one
//    in CreateSound. Only CreateSoundFromLabel — which is handed no file at all — takes the
//    file from the row.
//  • The label namespace spans every SoundInfo table, with nothing at the call site to say
//    which: "N03Tyrande01" is DialogSounds, "HeroDeathKnightPissed" is UnitAckSounds,
//    "QuestCompleted" (blizzard.j's victory sting) is UISounds. SoundBoard.labelParams
//    searches them all.

import type { JassUnit, NativeCtx, Runtime, SoundObj } from "../runtime";
import { asInt, asNum, asStr, jBool, jHandle, jInt, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);
const sound = (c: NativeCtx, v: JassValue): SoundObj | undefined => c.rt.data<SoundObj>(v);

/** A fresh handle with the engine's defaults. WC3 plays a sound at full volume, unpitched
 *  and non-positional until the script (or a label) says otherwise. */
function newSound(rt: Runtime, file: string): SoundObj {
  const s: SoundObj = {
    handleId: 0,
    file,
    label: "",
    looping: false,
    is3D: false,
    stopWhenOutOfRange: false,
    fadeInRate: 0,
    fadeOutRate: 0,
    volume: 127,
    pitch: 1,
    channel: 0,
    minDist: 0,
    maxDist: 0,
    cutoff: 0,
    coneInside: 0,
    coneOutside: 0,
    coneOutsideVolume: 0,
    coneOrient: null,
    duration: 0,
    x: 0,
    y: 0,
    z: 0,
    positioned: false,
    attachUnit: -1,
    killWhenDone: false,
    started: false,
  };
  s.handleId = rt.handles.alloc(s);
  rt.sounds.push(s);
  return s;
}

/** Copy a SoundInfo row's playback parameters onto a handle — SetSoundParamsFromLabel, and
 *  the tail of CreateSoundFromLabel. `takeFile` is what separates the two. */
function applyLabel(rt: Runtime, s: SoundObj, label: string, takeFile: boolean): void {
  s.label = label;
  const info = rt.hooks?.soundLabelInfo?.(label);
  if (!info) return;
  if (takeFile && info.files.length) s.file = info.files[Math.floor(rt.random() * info.files.length)];
  s.volume = info.volume;
  s.pitch = info.pitch;
  s.channel = info.channel;
  s.is3D = s.is3D || info.threeD; // the row's WANT3D can only ADD 3D to a sound created with it
  s.minDist = info.minDist;
  s.maxDist = info.maxDist;
  s.cutoff = info.cutoff;
}

/** The sound's world position right now: an attached unit's live position wins over a
 *  SetSoundPosition point (AttachSoundToUnit is the later, more specific statement). */
function positionOf(rt: Runtime, s: SoundObj): { x: number; y: number; z: number } | null {
  if (s.attachUnit >= 0) {
    const x = rt.hooks?.getUnitX?.(s.attachUnit);
    const y = rt.hooks?.getUnitY?.(s.attachUnit);
    if (x !== undefined && y !== undefined) return { x, y, z: s.z };
  }
  return s.positioned ? { x: s.x, y: s.y, z: s.z } : null;
}

export function registerSoundNatives(rt: Runtime): void {
  // --- building a sound handle ------------------------------------------------------
  // CreateSound(fileName, looping, is3D, stopwhenoutofrange, fadeInRate, fadeOutRate, eax)
  def(rt, "CreateSound", (c, a) => {
    const s = newSound(c.rt, asStr(a[0]));
    s.looping = truthy(a[1]);
    s.is3D = truthy(a[2]);
    s.stopWhenOutOfRange = truthy(a[3]);
    s.fadeInRate = asInt(a[4]);
    s.fadeOutRate = asInt(a[5]);
    // arg 6 is the EAX preset ("DefaultEAXON", "HeroAcksEAX", …) — an environmental reverb
    // profile from UI\SoundInfo\EnvironmentSounds.slk. We don't model reverb; recorded via
    // the label field would be misleading, so it's simply not read.
    return jHandle(s.handleId, "sound");
  });
  // CreateSoundFromLabel(soundLabel, looping, is3D, stopwhenoutofrange, fadeIn, fadeOut) —
  // no file: the label's own row supplies it. This is where blizzard.j's victory/defeat
  // stings come from (bj_victoryDialogSound = CreateSoundFromLabel("QuestCompleted", …)).
  def(rt, "CreateSoundFromLabel", (c, a) => {
    const s = newSound(c.rt, "");
    s.looping = truthy(a[1]);
    s.is3D = truthy(a[2]);
    s.stopWhenOutOfRange = truthy(a[3]);
    s.fadeInRate = asInt(a[4]);
    s.fadeOutRate = asInt(a[5]);
    applyLabel(c.rt, s, asStr(a[0]), true);
    return jHandle(s.handleId, "sound");
  });
  // CreateSoundFilenameWithLabel — an explicit file AND a label for its params (the two
  // halves of the InitSounds idiom in one call).
  def(rt, "CreateSoundFilenameWithLabel", (c, a) => {
    const s = newSound(c.rt, asStr(a[0]));
    s.looping = truthy(a[1]);
    s.is3D = truthy(a[2]);
    s.stopWhenOutOfRange = truthy(a[3]);
    s.fadeInRate = asInt(a[4]);
    s.fadeOutRate = asInt(a[5]);
    applyLabel(c.rt, s, asStr(a[6]), false);
    return jHandle(s.handleId, "sound");
  });
  // CreateMIDISound — the MIDI ambience beds (MIDISounds.slk). We synthesize no MIDI, so
  // this hands back a real handle that simply has no file: Start/Stop/query all behave,
  // nothing is heard. Silently returning null would crash a script that configures it.
  def(rt, "CreateMIDISound", (c, a) => {
    const s = newSound(c.rt, "");
    s.label = asStr(a[0]);
    return jHandle(s.handleId, "sound");
  });

  def(rt, "SetSoundParamsFromLabel", (c, a) => {
    const s = sound(c, a[0]);
    if (s) applyLabel(c.rt, s, asStr(a[1]), false); // params only — the file stays the script's
    return JNULL;
  });

  // --- the setters ------------------------------------------------------------------
  // SetSoundVolume takes 0–127 (SetSoundVolumeBJ = PercentToInt(percent, 127)). The World
  // Editor sometimes emits `SetSoundVolume(snd, -1)` / `SetSoundPitch(snd, 4294967296.0)`
  // for a sound left on its defaults — a sentinel, not a value (seen in the shipped
  // (10)DustwallowKeys war3map.j). Out-of-range writes keep the current setting rather
  // than silence the sound or shift it 4 billion semitones.
  def(rt, "SetSoundVolume", (c, a) => {
    const s = sound(c, a[0]);
    const v = asInt(a[1]);
    if (s && v >= 0 && v <= 127) s.volume = v;
    return JNULL;
  });
  def(rt, "SetSoundPitch", (c, a) => {
    const s = sound(c, a[0]);
    const p = asNum(a[1]);
    if (s && Number.isFinite(p) && p > 0 && p <= 10) s.pitch = p;
    return JNULL;
  });
  // SetSoundChannel — WC3's mixing channel (the SLK rows' Channel column: 0 general,
  // 8 interface, …). It drives the engine's own preemption/priority rules, which we don't
  // model (we cap concurrency per pool instead), so it's recorded and read back faithfully
  // but nothing yet reads it. Same for the EAX/reverb settings.
  def(rt, "SetSoundChannel", (c, a) => {
    const s = sound(c, a[0]);
    if (s) s.channel = asInt(a[1]);
    return JNULL;
  });
  // SetSoundDuration — metadata, not a truncation: the editor bakes the file's real length
  // into the script and GetSoundDuration reads it back, which is how a cinematic waits out
  // a line of dialogue before starting the next.
  def(rt, "SetSoundDuration", (c, a) => {
    const s = sound(c, a[0]);
    if (s) s.duration = asInt(a[1]);
    return JNULL;
  });
  def(rt, "SetSoundDistanceCutoff", (c, a) => {
    const s = sound(c, a[0]);
    if (s) s.cutoff = asNum(a[1]);
    return JNULL;
  });
  // The 3D-only setters. common.j: "these calls are only valid if the sound was created
  // with 3d enabled" — so a script calling them on a 2D sound is a no-op, not an error.
  def(rt, "SetSoundDistances", (c, a) => {
    const s = sound(c, a[0]);
    if (s?.is3D) {
      s.minDist = asNum(a[1]);
      s.maxDist = asNum(a[2]);
    }
    return JNULL;
  });
  def(rt, "SetSoundConeAngles", (c, a) => {
    const s = sound(c, a[0]);
    if (s?.is3D) {
      s.coneInside = asNum(a[1]);
      s.coneOutside = asNum(a[2]);
      s.coneOutsideVolume = asInt(a[3]); // 0–127 (SetSoundConeAnglesBJ = PercentToInt(pct, 127))
    }
    return JNULL;
  });
  def(rt, "SetSoundConeOrientation", (c, a) => {
    const s = sound(c, a[0]);
    if (s?.is3D) s.coneOrient = { x: asNum(a[1]), y: asNum(a[2]), z: asNum(a[3]) };
    return JNULL;
  });
  def(rt, "SetSoundPosition", (c, a) => {
    const s = sound(c, a[0]);
    if (!s) return JNULL;
    s.x = asNum(a[1]);
    s.y = asNum(a[2]);
    s.z = asNum(a[3]);
    s.positioned = true;
    s.attachUnit = -1; // a fixed point supersedes a previous attachment
    if (s.is3D) c.rt.hooks?.moveSound?.(s.handleId, s.x, s.y, s.z); // live, if it's playing
    return JNULL;
  });
  def(rt, "SetSoundVelocity", () => JNULL); // Doppler — the engine models no listener/source velocity
  def(rt, "AttachSoundToUnit", (c, a) => {
    const s = sound(c, a[0]);
    const u = c.rt.data<JassUnit>(a[1]);
    if (!s) return JNULL;
    s.attachUnit = u?.simId ?? -1;
    s.positioned = s.attachUnit >= 0; // it now has a position: the unit's
    const at = positionOf(c.rt, s);
    if (at && s.is3D) c.rt.hooks?.moveSound?.(s.handleId, at.x, at.y, at.z);
    return JNULL;
  });

  // --- playback ---------------------------------------------------------------------
  def(rt, "StartSound", (c, a) => {
    const s = sound(c, a[0]);
    if (!s) return JNULL;
    const at = positionOf(c.rt, s);
    if (at) {
      s.x = at.x;
      s.y = at.y;
      s.z = at.z;
    }
    s.started = true;
    c.rt.hooks?.playSound?.(s);
    return JNULL;
  });
  // StopSound(snd, killWhenDone, fadeOut)
  def(rt, "StopSound", (c, a) => {
    const s = sound(c, a[0]);
    if (!s) return JNULL;
    c.rt.hooks?.stopSound?.(s.handleId, truthy(a[2]));
    if (truthy(a[1])) c.rt.destroySound(s);
    return JNULL;
  });
  // KillSoundWhenDone — destroy the handle once the clip finishes. The sweep lives in the
  // engine's frame loop (it's the only side that knows when playback ended); this just
  // arms it. blizzard.j's PlaySound() does CreateSound + StartSound + KillSoundWhenDone,
  // i.e. it leans on this to not leak a handle per fire-and-forget sound.
  def(rt, "KillSoundWhenDone", (c, a) => {
    const s = sound(c, a[0]);
    if (s) s.killWhenDone = true;
    return JNULL;
  });
  def(rt, "SetSoundPlayPosition", () => JNULL); // seek — the engine has no per-sound seek yet
  def(rt, "GetSoundIsPlaying", (c, a) => {
    const s = sound(c, a[0]);
    return jBool(!!s && (c.rt.hooks?.soundIsPlaying?.(s.handleId) ?? false));
  });
  def(rt, "GetSoundIsLoading", () => jBool(false));
  def(rt, "GetSoundDuration", (c, a) => jInt(sound(c, a[0])?.duration ?? 0));
  def(rt, "GetSoundFileDuration", (c, a) => jInt(c.rt.hooks?.soundFileDuration?.(asStr(a[0])) ?? 0));
  // A "stacked" sound is WC3's de-duplication of many identical world sounds (a forest of
  // burning trees) into one. We cap concurrency per pool instead — nothing to register.
  def(rt, "RegisterStackedSound", () => JNULL);
  def(rt, "UnregisterStackedSound", () => JNULL);
  // NewSoundEnvironment("Default") — the EAX reverb preset for the whole map. No reverb.
  def(rt, "NewSoundEnvironment", () => JNULL);

  // --- volume groups ------------------------------------------------------------------
  // VolumeGroupSetVolume(vgroup, scale 0–1). Our pools map onto the eight SOUND_VOLUMEGROUP_*
  // indices; see the mapping (and how blizzard.j's own cinematic-mode ducking proves it) in
  // src/audio/sounds.ts.
  def(rt, "VolumeGroupSetVolume", (c, a) => {
    c.rt.hooks?.setVolumeGroup?.(c.rt.enumIndex(a[0]), asNum(a[1]));
    return JNULL;
  });
  def(rt, "VolumeGroupReset", (c) => {
    c.rt.hooks?.resetVolumeGroups?.();
    return JNULL;
  });

  // --- music --------------------------------------------------------------------------
  // SetMapMusic is the one that matters: all 165 bundled maps call it and only one calls
  // PlayMusic, yet every melee game has music — so SetMapMusic STARTS the list, it doesn't
  // merely record it. Its `musicName` is a PLAYLIST KEY, not a file: `SetMapMusic("Music",
  // true, 0)` resolves through UI\war3skins.txt against the local player's race.
  def(rt, "SetMapMusic", (c, a) => {
    c.rt.hooks?.setMapMusic?.(asStr(a[0]), truthy(a[1]), asInt(a[2]));
    return JNULL;
  });
  def(rt, "ClearMapMusic", (c) => {
    c.rt.hooks?.clearMapMusic?.();
    return JNULL;
  });
  def(rt, "PlayMusic", (c, a) => {
    c.rt.hooks?.playMusic?.(asStr(a[0]), 0, 0);
    return JNULL;
  });
  def(rt, "PlayMusicEx", (c, a) => {
    c.rt.hooks?.playMusic?.(asStr(a[0]), asInt(a[1]), asInt(a[2]));
    return JNULL;
  });
  def(rt, "StopMusic", (c, a) => {
    c.rt.hooks?.stopMusic?.(truthy(a[0]));
    return JNULL;
  });
  def(rt, "ResumeMusic", (c) => {
    c.rt.hooks?.resumeMusic?.();
    return JNULL;
  });
  def(rt, "PlayThematicMusic", (c, a) => {
    c.rt.hooks?.playThematicMusic?.(asStr(a[0]), 0);
    return JNULL;
  });
  def(rt, "PlayThematicMusicEx", (c, a) => {
    c.rt.hooks?.playThematicMusic?.(asStr(a[0]), asInt(a[1]));
    return JNULL;
  });
  def(rt, "EndThematicMusic", (c) => {
    c.rt.hooks?.endThematicMusic?.();
    return JNULL;
  });
  def(rt, "SetMusicVolume", (c, a) => {
    c.rt.hooks?.setMusicVolume?.(asInt(a[0]));
    return JNULL;
  });
  def(rt, "SetMusicPlayPosition", () => JNULL); // seek — no per-track seek on a live source
  def(rt, "SetThematicMusicPlayPosition", () => JNULL);

  // The "…ForPlayer" BJs (StartSoundForPlayerBJ, VolumeGroupSetVolumeBJ, …) need no natives
  // of their own: they are blizzard.j functions that gate on GetLocalPlayer() and then call
  // the natives above —
  //     if (whichPlayer == GetLocalPlayer()) then call StartSound(soundHandle) endif
  // — which is why another player's defeat sting is silent on this machine (see 7.19).
}
