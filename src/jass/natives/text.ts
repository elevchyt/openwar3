// Text natives — the "Text Message" + "Floating Text" trigger actions and the
// string/text-logic functions (Phase 7 — issue #33; see docs/triggers.md).
//
// Two families, both what the GUI trigger editor calls "text":
//   • Text ACTIONS — on-screen chat lines (DisplayTextToPlayer & timed variant,
//     ClearTextMessages) and floating text tags (CreateTextTag + its setters, the
//     GUI "Floating Text" category). The force-targeted BJ wrappers
//     (DisplayTextToForce/ClearTextMessagesBJ/…) run through blizzard.j on top of
//     these + the force natives (natives/forces.ts).
//   • Text LOGIC — the string functions those actions build their messages from:
//     names (GetPlayerName/GetUnitName/GetObjectName/GetHeroProperName), StringHash,
//     and the localization pass-throughs (GetLocalizedString/GetLocalizedHotkey).
//     (I2S/R2S/SubString/StringLength/StringCase live in the util group.)
//
// On-screen messages route through the EngineHooks bridge; floating text tags are
// stored as live objects in runtime.textTags for the renderer to poll (see the
// TextTagObj note in runtime.ts for why we don't push-emit them per setter).

import { intToRawcode } from "../lexer";
import type { JassPlayer, JassUnit, NativeCtx, Runtime, TextTagObj } from "../runtime";
import { asInt, asNum, asStr, jHandle, jInt, JNULL, jStr, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);
const tag = (c: NativeCtx, v: JassValue): TextTagObj | undefined => c.rt.data<TextTagObj>(v);
const unit = (c: NativeCtx, v: JassValue): JassUnit | undefined => c.rt.data<JassUnit>(v);

/** A unit's engine-resolved display name, falling back through the data bridge to
 *  the raw type id when no engine is attached (headless). */
function unitName(c: NativeCtx, u: JassUnit | undefined): string {
  if (!u) return "";
  return (u.simId >= 0 ? c.rt.hooks?.unitName?.(u.simId) : undefined) ?? c.rt.hooks?.objectName?.(u.typeId) ?? u.typeId;
}

export function registerTextNatives(rt: Runtime): void {
  // --- floating text tags (the GUI "Floating Text" actions) ---
  // A fresh tag is PERMANENT (WC3's default — a CreateTextTag with no further setters
  // hangs on screen forever; that's the well-known floating-text leak). `lifespan` only
  // takes effect once a script clears permanence — see Runtime.advanceTextTags.
  def(rt, "CreateTextTag", (c) => {
    const tt: TextTagObj = {
      handleId: 0, text: "", x: 0, y: 0, z: 0, size: 0, color: 0xffffffff, visible: true,
      permanent: true, lifespan: 0, fadepoint: 0, age: 0, velX: 0, velY: 0,
      offsetX: 0, offsetY: 0, suspended: false, followUnit: -1, dead: false,
    };
    tt.handleId = c.rt.handles.alloc(tt);
    c.rt.textTags.push(tt);
    return jHandle(tt.handleId, "texttag");
  });
  def(rt, "SetTextTagText", (c, a) => {
    const tt = tag(c, a[0]);
    if (tt) {
      tt.text = asStr(a[1]);
      tt.size = asNum(a[2]);
    }
    return JNULL;
  });
  def(rt, "SetTextTagPos", (c, a) => {
    const tt = tag(c, a[0]);
    if (tt) {
      tt.x = asNum(a[1]);
      tt.y = asNum(a[2]);
      tt.z = asNum(a[3]);
      tt.followUnit = -1;
    }
    return JNULL;
  });
  def(rt, "SetTextTagPosUnit", (c, a) => {
    const tt = tag(c, a[0]);
    const u = unit(c, a[1]);
    if (tt) {
      tt.followUnit = u?.simId ?? -1;
      tt.z = asNum(a[2]);
      if (u) {
        tt.x = u.x;
        tt.y = u.y;
      }
    }
    return JNULL;
  });
  def(rt, "SetTextTagColor", (c, a) => {
    const tt = tag(c, a[0]);
    if (tt) {
      const r = asInt(a[1]) & 0xff, g = asInt(a[2]) & 0xff, b = asInt(a[3]) & 0xff, al = asInt(a[4]) & 0xff;
      tt.color = ((al << 24) | (r << 16) | (g << 8) | b) >>> 0;
    }
    return JNULL;
  });
  def(rt, "SetTextTagVelocity", (c, a) => {
    const tt = tag(c, a[0]);
    if (tt) {
      tt.velX = asNum(a[1]);
      tt.velY = asNum(a[2]);
    }
    return JNULL;
  });
  def(rt, "SetTextTagVisibility", (c, a) => (tag(c, a[0]) && (tag(c, a[0])!.visible = truthy(a[1])), JNULL));
  def(rt, "SetTextTagSuspended", (c, a) => (tag(c, a[0]) && (tag(c, a[0])!.suspended = truthy(a[1])), JNULL));
  def(rt, "SetTextTagPermanent", (c, a) => (tag(c, a[0]) && (tag(c, a[0])!.permanent = truthy(a[1])), JNULL));
  def(rt, "SetTextTagAge", (c, a) => (tag(c, a[0]) && (tag(c, a[0])!.age = asNum(a[1])), JNULL));
  def(rt, "SetTextTagLifespan", (c, a) => (tag(c, a[0]) && (tag(c, a[0])!.lifespan = asNum(a[1])), JNULL));
  def(rt, "SetTextTagFadepoint", (c, a) => (tag(c, a[0]) && (tag(c, a[0])!.fadepoint = asNum(a[1])), JNULL));
  def(rt, "DestroyTextTag", (c, a) => {
    const tt = tag(c, a[0]);
    if (tt) c.rt.destroyTextTag(tt);
    return JNULL;
  });

  // --- on-screen messages (DisplayTextToPlayer family + ClearTextMessages) ---
  // DisplayTextToPlayer(player, x, y, message): untimed (duration < 0 = host default).
  // A line addressed to a second seat in the same instant is a broadcast written as a loop,
  // and the watchers are shown it once (Runtime.watcherEcho).
  const tell = (c: NativeCtx, to: number, msg: string, duration: number): void => {
    c.rt.hooks?.displayText?.(to, msg, duration);
    for (const w of c.rt.watcherEcho(to, msg)) c.rt.hooks?.displayText?.(w, msg, duration);
  };
  def(rt, "DisplayTextToPlayer", (c, a) => {
    tell(c, c.rt.data<JassPlayer>(a[0])?.index ?? 0, asStr(a[3]), -1);
    return JNULL;
  });
  // DisplayTimedTextToPlayer(player, x, y, duration, message).
  def(rt, "DisplayTimedTextToPlayer", (c, a) => {
    tell(c, c.rt.data<JassPlayer>(a[0])?.index ?? 0, asStr(a[4]), asNum(a[3]));
    return JNULL;
  });
  // DisplayTimedTextFromPlayer(player, x, y, duration, message) — despite common.j naming
  // the parameter `toPlayer`, the player here is the SUBJECT, not the audience: the message
  // goes to everyone with the player's name substituted into its `%s`. That is how
  // "Player 1 was victorious." reaches the whole game from MeleeVictoryDialogBJ, which
  // passes the raw format string GetLocalizedString("PLAYER_VICTORIOUS") = "%s was victorious."
  def(rt, "DisplayTimedTextFromPlayer", (c, a) => {
    const idx = c.rt.data<JassPlayer>(a[0])?.index ?? 0;
    const msg = asStr(a[4]).replace(/%s/g, c.rt.playerName(idx));
    // A BROADCAST (see above): "Player 1 was victorious." is for the whole game, not for the
    // machine that happened to run the script. It used to resolve `localViewer` ONCE — right
    // while one client simulated its own match, and wrong the moment a host answers for N
    // players, where every seat but the host's would silently never be told who won.
    c.rt.broadcast((to) => c.rt.hooks?.displayText?.(to, msg, asNum(a[3])));
    return JNULL;
  });
  def(rt, "ClearTextMessages", (c) => {
    // Also a broadcast, and it was hardcoded to slot 0 before the lobby could say otherwise.
    // Clearing one seat's log is not what this native does: it wipes EVERY player's messages,
    // which is why cinematics open with it.
    c.rt.broadcast((to) => c.rt.hooks?.clearText?.(to));
    return JNULL;
  });

  // --- text logic: names ---
  def(rt, "GetPlayerName", (c, a) => jStr(c.rt.playerName(c.rt.data<JassPlayer>(a[0])?.index ?? 0)));
  def(rt, "SetPlayerName", (c, a) => {
    const p = c.rt.data<JassPlayer>(a[0]);
    if (p) p.name = asStr(a[1]);
    return JNULL;
  });
  def(rt, "GetObjectName", (c, a) => {
    const raw = intToRawcode(asInt(a[0]));
    return jStr(c.rt.hooks?.objectName?.(raw) ?? raw);
  });
  def(rt, "GetUnitName", (c, a) => jStr(unitName(c, unit(c, a[0]))));
  def(rt, "GetHeroProperName", (c, a) => jStr(unitName(c, unit(c, a[0]))));

  // --- text logic: string hashing + localization ---
  // StringHash — the GAME's hash, bit for bit (`stringHash` below), because maps depend on the
  // exact number and not only on its being stable: a chat command compared by hash (`-AR`
  // against `-ar`), a precomputed hash literal in a map's script, a save code with a hash in
  // it. It used to be a case-sensitive FNV-1a, which answered every one of those wrongly.
  def(rt, "StringHash", (_c, a) => jInt(stringHash(asStr(a[0]))));
  // GetLocalizedString is a lookup in the GAME's own string table, not a no-op: the whole
  // victory/defeat screen is written in its keys (GAMEOVER_VICTORY_MSG → "Victory!",
  // GAMEOVER_QUIT_GAME → "|CFFFFFFFFQ|Ruit Game"), and blizzard.j never spells the text
  // out. The engine reads UI\FrameDef\GlobalStrings.fdf — the same file the FDF UI system
  // already loads (src/ui/fdf/library.ts). A key with no entry falls through as itself,
  // which is also what a plain sentence passed to GetLocalizedString does.
  def(rt, "GetLocalizedString", (c, a) => {
    const key = asStr(a[0]);
    return jStr(c.rt.hooks?.localizedString?.(key) ?? key);
  });
  // The hotkey is the accelerator letter of a localized string. GlobalStrings marks it by
  // colouring it white ("|CFFFFFFFFQ|Ruit Game" → Q), so read the char inside the first
  // colour run when there is one; otherwise fall back to the first meaningful character.
  def(rt, "GetLocalizedHotkey", (c, a) => {
    const key = asStr(a[0]);
    return jInt(localizedHotkey(c.rt.hooks?.localizedString?.(key) ?? key));
  });
}

/** GetLocalizedHotkey's answer for an already-localized string: the char code of its
 *  accelerator letter (see above), 0 when it has none. Exported for the dialogs the ENGINE
 *  raises itself — the victory screen a match with no script still gets — which must answer
 *  the same keys blizzard.j's own MeleeVictoryDialogBJ gives its buttons. */
export function localizedHotkey(text: string): number {
  const s = text.trim();
  const marked = /\|[cC][0-9a-fA-F]{8}(.)/.exec(s);
  const ch = marked ? marked[1] : s.replace(/\|[cC][0-9a-fA-F]{8}|\|[rRnN]/g, "").trim()[0];
  return ch ? ch.charCodeAt(0) : 0;
}

/**
 * The game's string folding: ASCII letters upper-cased and `/` read as `\`, so "a/b", "A\B"
 * and "a\b" are one string. It is Storm's path-name rule (the same function hashes archive
 * paths) and why `StringHash` and the game cache ignore case. Only ASCII is folded — the
 * jassbot documentation of StringHash notes that multi-byte characters hash differently from
 * one patch to the next (1.30.0 / 1.31.1), and 1.30.4 is the one we answer for.
 */
export function foldStormString(s: string): string {
  return s.replace(/[a-z/]/g, (ch) => (ch === "/" ? "\\" : String.fromCharCode(ch.charCodeAt(0) - 32)));
}

/** lookup2's mixing step (Bob Jenkins, lookup2.c, 1996, public domain), on three int32s. */
function mix(r: Int32Array): void {
  let a = r[0], b = r[1], c = r[2];
  a = (a - b - c) | 0; a ^= c >>> 13;
  b = (b - c - a) | 0; b ^= a << 8;
  c = (c - a - b) | 0; c ^= b >>> 13;
  a = (a - b - c) | 0; a ^= c >>> 12;
  b = (b - c - a) | 0; b ^= a << 16;
  c = (c - a - b) | 0; c ^= b >>> 5;
  a = (a - b - c) | 0; a ^= c >>> 3;
  b = (b - c - a) | 0; b ^= a << 10;
  c = (c - a - b) | 0; c ^= b >>> 15;
  r[0] = a; r[1] = b; r[2] = c;
}

const utf8 = new TextEncoder();

/**
 * `StringHash` as the game computes it. The native is Storm's `SStrHash2`, which jassbot's
 * documentation of StringHash (lep.duckdns.org/jassbot/doc/StringHash) and the Hive thread
 * "bits of interest" (hiveworkshop 213272) describe as the hash of the 1997 Dr. Dobb's article
 * — Bob Jenkins' lookup2, his public-domain "My Hash" — over the FOLDED string's UTF-8 bytes
 * with an initial value of 0. Written here from lookup2.c, not from anything of Blizzard's. The
 * check that it is the same function is a number the community publishes:
 * `StringHash("A") = -1587459251`, which this reproduces (tools/jass-semantics-test.cjs).
 */
export function stringHash(s: string): number {
  const k = utf8.encode(foldStormString(s));
  const r = new Int32Array([0x9e3779b9 | 0, 0x9e3779b9 | 0, 0]);
  const word = (i: number): number => k[i] | (k[i + 1] << 8) | (k[i + 2] << 16) | (k[i + 3] << 24);
  let i = 0;
  let len = k.length;
  for (; len >= 12; i += 12, len -= 12) {
    r[0] += word(i);
    r[1] += word(i + 4);
    r[2] += word(i + 8);
    mix(r);
  }
  r[2] += k.length;
  // The tail, as lookup2's fall-through switch adds it: c's low byte is the length's, so the
  // last three bytes land one byte up in c.
  if (len >= 11) r[2] += k[i + 10] << 24;
  if (len >= 10) r[2] += k[i + 9] << 16;
  if (len >= 9) r[2] += k[i + 8] << 8;
  if (len >= 8) r[1] += k[i + 7] << 24;
  if (len >= 7) r[1] += k[i + 6] << 16;
  if (len >= 6) r[1] += k[i + 5] << 8;
  if (len >= 5) r[1] += k[i + 4];
  if (len >= 4) r[0] += k[i + 3] << 24;
  if (len >= 3) r[0] += k[i + 2] << 16;
  if (len >= 2) r[0] += k[i + 1] << 8;
  if (len >= 1) r[0] += k[i];
  mix(r);
  return r[2];
}
