// Timer dialogs — the countdown windows (Phase 7.21 — issue #33; see docs/triggers.md).
//
// The little panel WC3 hangs top-right: "Build Town Hall  1:59", "Next Level  0:23",
// "Hero Revives In  0:42". Every TD and AoS puts one up, and — the reason this is a MELEE
// leftover rather than a custom-map nicety — **blizzard.j's own melee library builds two of
// them and we were silently throwing both away**:
//
//     // MeleeInitVictoryDefeat (Scripts\Blizzard.j)
//     set bj_finishSoonTimerDialog = CreateTimerDialog(null)          // tournament "finish soon"
//     …per playing slot…
//     set bj_crippledTimer[index]       = CreateTimer()
//     set bj_crippledTimerWindows[index] = CreateTimerDialog(bj_crippledTimer[index])
//     call TimerDialogSetTitle(bj_crippledTimerWindows[index], MeleeGetCrippledTimerMessage(indexPlayer))
//
// The CRIPPLED window is a real melee rule our engine already *computes* and never showed:
// lose your last main hall while you still hold other structures and blizzard.j starts a
// 120 s timer (bj_MELEE_CRIPPLE_TIMEOUT) — build a new hall before it drains or you are
// REVEALED to every opponent. MeleeCheckForCrippledPlayers already runs here (it rides the
// death / construct-cancel / construct-finish events, and its structure counts came in with
// 7.3), so the state was correct; the player just could not see the clock ticking.
//
// Two shapes worth naming, both read off the sources:
//
//  • A timerdialog HOLDS NO TIME. It is a view onto a `timer` — the engine reads that
//    timer's remaining every frame. That is why CreateTimerDialog takes the timer, and why
//    blizzard.j can create the window at map init and only TimerStart the timer two minutes
//    into the game.
//  • A dialog over a NULL timer is legal, and blizzard.j depends on it: bj_finishSoonTimerDialog
//    is `CreateTimerDialog(null)` — "it has no timer because it is driven by real time
//    (outside of the game state to avoid desyncs)". It shows whatever
//    TimerDialogSetRealTimeRemaining last put in it, so it must not crash on the null.

import type { NativeCtx, Runtime, TimerDialogObj, TimerObj } from "../runtime";
import { asInt, asNum, asStr, jBool, jHandle, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);
const td = (c: NativeCtx, v: JassValue): TimerDialogObj | undefined => c.rt.data<TimerDialogObj>(v);

/** Pack an (r, g, b, a) quad — each 0–255, as the natives take them — into 0xAARRGGBB,
 *  the same form TextTagObj and the leaderboard already use. */
const rgba = (a: JassValue[], i: number): number =>
  (((asInt(a[i + 3]) & 0xff) << 24) | ((asInt(a[i]) & 0xff) << 16) | ((asInt(a[i + 1]) & 0xff) << 8) | (asInt(a[i + 2]) & 0xff)) >>> 0;

export function registerTimerDialogNatives(rt: Runtime): void {
  def(rt, "CreateTimerDialog", (c, a) => {
    // The timer may be null (see the header) — a real-time dialog, not an error.
    const t = c.rt.data<TimerObj>(a[0]);
    const d: TimerDialogObj = {
      handleId: 0,
      timerId: t?.handleId ?? 0,
      title: "",
      titleColor: null, // null = keep the FDF's own font colour
      timeColor: null,
      speed: 1,
      displayed: false, // CreateTimerDialog does NOT show it — TimerDialogDisplay does
      realTimeRemaining: 0,
      revision: 0,
    };
    d.handleId = c.rt.handles.alloc(d);
    c.rt.timerDialogs.push(d);
    return jHandle(d.handleId, "timerdialog");
  });
  def(rt, "DestroyTimerDialog", (c, a) => {
    const d = td(c, a[0]);
    if (d) {
      const i = c.rt.timerDialogs.indexOf(d);
      if (i >= 0) c.rt.timerDialogs.splice(i, 1);
      c.rt.handles.free(d.handleId);
    }
    return JNULL;
  });
  def(rt, "TimerDialogSetTitle", (c, a) => {
    const d = td(c, a[0]);
    if (d) {
      d.title = asStr(a[1]);
      d.revision++;
    }
    return JNULL;
  });
  def(rt, "TimerDialogSetTitleColor", (c, a) => {
    const d = td(c, a[0]);
    if (d) {
      d.titleColor = rgba(a, 1);
      d.revision++;
    }
    return JNULL;
  });
  def(rt, "TimerDialogSetTimeColor", (c, a) => {
    const d = td(c, a[0]);
    if (d) {
      d.timeColor = rgba(a, 1);
      d.revision++;
    }
    return JNULL;
  });
  // TimerDialogSetSpeed scales the DISPLAY, not the timer — a dialog can run its numbers
  // faster than the clock behind it. 0 would freeze the readout, which no script wants and
  // which would read as a bug, so it is ignored (the engine's own default is 1.0).
  def(rt, "TimerDialogSetSpeed", (c, a) => {
    const d = td(c, a[0]);
    const s = asNum(a[1]);
    if (d && s > 0) {
      d.speed = s;
      d.revision++;
    }
    return JNULL;
  });
  def(rt, "TimerDialogDisplay", (c, a) => {
    const d = td(c, a[0]);
    if (d) {
      d.displayed = truthy(a[1]);
      d.revision++;
    }
    return JNULL;
  });
  def(rt, "IsTimerDialogDisplayed", (c, a) => jBool(td(c, a[0])?.displayed ?? false));
  def(rt, "TimerDialogSetRealTimeRemaining", (c, a) => {
    const d = td(c, a[0]);
    if (d) {
      d.realTimeRemaining = asNum(a[1]);
      d.revision++;
    }
    return JNULL;
  });
  // The whole "…ForPlayer" family is blizzard.j gating on GetLocalPlayer() and then calling
  // TimerDialogDisplay, so `displayed` IS local visibility — nothing extra to implement.
}
