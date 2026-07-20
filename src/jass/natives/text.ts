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
  def(rt, "DisplayTextToPlayer", (c, a) => {
    c.rt.hooks?.displayText?.(c.rt.data<JassPlayer>(a[0])?.index ?? 0, asStr(a[3]), -1);
    return JNULL;
  });
  // DisplayTimedTextToPlayer(player, x, y, duration, message).
  def(rt, "DisplayTimedTextToPlayer", (c, a) => {
    c.rt.hooks?.displayText?.(c.rt.data<JassPlayer>(a[0])?.index ?? 0, asStr(a[4]), asNum(a[3]));
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
    // Goes to whoever is being evaluated for. The message is a BROADCAST (see above), so
    // under Phase E this is delivered once per recipient rather than once to the host.
    c.rt.hooks?.displayText?.(c.rt.localViewer, msg, asNum(a[3]));
    return JNULL;
  });
  def(rt, "ClearTextMessages", (c) => {
    // Was hardcoded to slot 0 with the note "single-player: slot 0", which is wrong the
    // moment the human is not in slot 0 — it cleared a bystander's message log and left the
    // real one standing. The lobby has said which slot we are since applyLobby.
    c.rt.hooks?.clearText?.(c.rt.localViewer);
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
  // StringHash — a deterministic 32-bit hash (FNV-1a). Not bit-identical to
  // Blizzard's (theirs is an internal detail), but stable within a run, which is all
  // maps rely on: it keys gamecache/hashtable slots via StringHashBJ.
  def(rt, "StringHash", (_c, a) => jInt(fnv1a(asStr(a[0]))));
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
    const s = (c.rt.hooks?.localizedString?.(key) ?? key).trim();
    const marked = /\|[cC][0-9a-fA-F]{8}(.)/.exec(s);
    const ch = marked ? marked[1] : s.replace(/\|[cC][0-9a-fA-F]{8}|\|[rRnN]/g, "").trim()[0];
    return jInt(ch ? ch.charCodeAt(0) : 0);
  });
}

/** FNV-1a 32-bit, returned as a signed int (JASS `integer` is 32-bit signed). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}
