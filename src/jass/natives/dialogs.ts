// Dialogs + the game-over path (Phase 7.19 — issue #33; see docs/triggers.md).
//
// A JASS `dialog` is a modal message box with buttons, and it is the thing WC3's
// **victory/defeat screen actually is**. Blizzard never wrote a bespoke "Victory!"
// panel: MeleeVictoryDialogBJ (Scripts\Blizzard.j) builds a plain dialog —
//
//     call DialogSetMessage( d, GetLocalizedString( "GAMEOVER_VICTORY_MSG" ) )   // "Victory!"
//     call DialogAddButton( d, GetLocalizedString( "GAMEOVER_CONTINUE_GAME" ), … )
//     call TriggerRegisterDialogButtonEvent( t, DialogAddQuitButton( d, true, … ) )
//     call DialogDisplay( whichPlayer, d, true )
//     call StartSoundForPlayerBJ( whichPlayer, bj_victoryDialogSound )
//
// — so implementing `dialog` faithfully renders the real melee end screen (7.3 already
// flips bj_meleeVictoried/bj_meleeDefeated correctly; these natives are what was missing
// between the game state and the player's eyes). The engine draws them from the game's
// own `ScriptDialog` FDF frame (src/ui/gameDialog.ts).
//
// Two behaviours belong to the ENGINE, not to the script, and are easy to miss because
// blizzard.j says nothing about them:
//   • clicking ANY button closes the dialog;
//   • a DialogAddQuitButton button ends the game — MeleeVictoryDialogBJ registers a
//     trigger on it but adds no action, because the quitting is the native's own job.
// Both live in the UI layer (it owns the click), which then calls back into
// Interpreter.fireDialogClick to run whatever triggers the script did register.

import type { DialogButtonObj, DialogObj, JassPlayer, NativeCtx, Runtime, TriggerObj } from "../runtime";
import { asInt, asStr, jBool, jHandle, jInt, JNULL, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);
const dialog = (c: NativeCtx, v: JassValue): DialogObj | undefined => c.rt.data<DialogObj>(v);
const playerIndex = (c: NativeCtx, v: JassValue): number => c.rt.data<JassPlayer>(v)?.index ?? 0;

/** A `sound` handle. We model a sound as nothing but its UISounds.slk label — which is
 *  all CreateSoundFromLabel is given, and all the engine needs to play it back through
 *  our SoundBoard (`playUi`). Positional/3D sounds are a separate (unbuilt) surface. */
interface SoundObj {
  handleId: number;
  label: string;
}

export function registerDialogNatives(rt: Runtime): void {
  // --- the dialog object ---------------------------------------------------------
  def(rt, "DialogCreate", (c) => {
    const d: DialogObj = { handleId: 0, message: "", buttons: [], visibleFor: new Set(), revision: 0 };
    d.handleId = c.rt.handles.alloc(d);
    c.rt.dialogs.push(d);
    return jHandle(d.handleId, "dialog");
  });
  def(rt, "DialogDestroy", (c, a) => {
    const d = dialog(c, a[0]);
    if (d) {
      const i = c.rt.dialogs.indexOf(d);
      if (i >= 0) c.rt.dialogs.splice(i, 1);
      for (const b of d.buttons) c.rt.handles.free(b.handleId);
      c.rt.handles.free(d.handleId);
    }
    return JNULL;
  });
  // DialogClear drops the buttons AND the message — it resets the dialog for reuse.
  def(rt, "DialogClear", (c, a) => {
    const d = dialog(c, a[0]);
    if (d) {
      for (const b of d.buttons) c.rt.handles.free(b.handleId);
      d.buttons = [];
      d.message = "";
      d.revision++;
    }
    return JNULL;
  });
  def(rt, "DialogSetMessage", (c, a) => {
    const d = dialog(c, a[0]);
    if (d) {
      d.message = asStr(a[1]);
      d.revision++;
    }
    return JNULL;
  });
  def(rt, "DialogAddButton", (c, a) => addButton(c, a[0], asStr(a[1]), asInt(a[2]), false, false));
  // DialogAddQuitButton(dialog, doScoreScreen, text, hotkey) — note the score-screen flag
  // sits BEFORE the text (unlike DialogAddButton). It is the button that leaves the match.
  def(rt, "DialogAddQuitButton", (c, a) => addButton(c, a[0], asStr(a[2]), asInt(a[3]), true, truthy(a[1])));
  def(rt, "DialogDisplay", (c, a) => {
    const d = dialog(c, a[1]);
    if (d) {
      const p = playerIndex(c, a[0]);
      if (truthy(a[2])) d.visibleFor.add(p);
      else d.visibleFor.delete(p);
      d.revision++;
    }
    return JNULL;
  });

  // --- dialog events -------------------------------------------------------------
  // The button/dialog handle is the registration's param; the UI calls back with the
  // clicked button and Interpreter.fireDialogClick matches on it.
  def(rt, "TriggerRegisterDialogButtonEvent", (c, a) => {
    const t = c.rt.data<TriggerObj>(a[0]);
    if (t) c.rt.triggerRegs.push({ kind: "dialogButton", trigId: t.handleId, params: [a[1]] });
    return JNULL;
  });
  def(rt, "TriggerRegisterDialogEvent", (c, a) => {
    const t = c.rt.data<TriggerObj>(a[0]);
    if (t) c.rt.triggerRegs.push({ kind: "dialogEvent", trigId: t.handleId, params: [a[1]] });
    return JNULL;
  });
  def(rt, "GetClickedButton", (c) => c.rt.eventResponse("ClickedButton"));
  def(rt, "GetClickedDialog", (c) => c.rt.eventResponse("ClickedDialog"));

  // --- the game-over path --------------------------------------------------------
  // EndGame is what a quit button does. `doScoreScreen` asks for the post-game score
  // screen (UI\FrameDef\Glue\ScoreScreen.fdf) — we don't build one, so we leave the
  // match either way and say so rather than silently ignoring the flag.
  def(rt, "EndGame", (c, a) => {
    c.rt.hooks?.endGame?.(truthy(a[0]));
    return JNULL;
  });
  def(rt, "PauseGame", (c, a) => {
    c.rt.hooks?.pauseGame?.(truthy(a[0]));
    return JNULL;
  });
  def(rt, "EnableUserUI", (c, a) => {
    c.rt.hooks?.enableUserUi?.(truthy(a[0]));
    return JNULL;
  });
  def(rt, "EnableUserControl", () => JNULL); // we never lock input away from the player
  // AllowVictoryDefeat gates the whole end-game path on these two. They report the "no
  // victory"/"no defeat" CHEATS being off — which they are; we implement no cheat codes.
  def(rt, "IsNoVictoryCheat", () => jBool(false));
  def(rt, "IsNoDefeatCheat", () => jBool(false));
  def(rt, "SetIntegerGameState", () => JNULL); // GAME_STATE_DISCONNECTED etc. — nothing to set
  def(rt, "RestartGame", () => JNULL);
  def(rt, "ChangeLevel", () => JNULL); // campaign-only (bj_changeLevelMapName is null in melee)

  // --- sounds, only as far as the dialogs need them -------------------------------
  // bj_victoryDialogSound = CreateSoundFromLabel("QuestCompleted", …) and its "QuestFailed"
  // twin (blizzard.j InitBlizzardGlobals) — both are UISounds.slk labels, so StartSound on
  // one plays through our SoundBoard.playUi. That is where the win/lose sting comes from.
  def(rt, "CreateSoundFromLabel", (c, a) => {
    const s: SoundObj = { handleId: 0, label: asStr(a[0]) };
    s.handleId = c.rt.handles.alloc(s);
    return jHandle(s.handleId, "sound");
  });
  def(rt, "StartSound", (c, a) => {
    const s = c.rt.data<SoundObj>(a[0]);
    if (s?.label) c.rt.hooks?.playUiSound?.(s.label);
    return JNULL;
  });
  def(rt, "GetSoundIsPlaying", () => jBool(false));
  def(rt, "GetSoundDuration", () => jInt(0));
  def(rt, "GetSoundFileDuration", () => jInt(0));
}

/** Attach a button to a dialog and hand back its `button` handle. Shared by
 *  DialogAddButton and DialogAddQuitButton — a quit button differs only in what the
 *  ENGINE does when it is clicked (EndGame), not in how it is built. */
function addButton(
  c: NativeCtx,
  dv: JassValue,
  text: string,
  hotkey: number,
  quit: boolean,
  doScoreScreen: boolean,
): JassValue {
  const d = c.rt.data<DialogObj>(dv);
  if (!d) return JNULL;
  const b: DialogButtonObj = { handleId: 0, dialogId: d.handleId, text, hotkey, quit, doScoreScreen };
  b.handleId = c.rt.handles.alloc(b);
  d.buttons.push(b);
  d.revision++;
  return jHandle(b.handleId, "button");
}
