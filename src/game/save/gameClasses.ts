// SAVED GAMES (issue #159) — the classes of the GAME layer (the controller and what it owns), for
// the codec. Apart from classes.ts because the controller pulls in the renderer, and the headless
// save tests compile classes.ts for Node.
//
// The controller is the one class here that is mostly NOT state: it is the RTS front end, and the
// greater part of its fields are the picture (the entries and their models), the input (what is
// armed, what is hovered), the wire of a LAN game and scratch buffers. Those are listed TRANSIENT
// below — the loaded match keeps its own — and everything else it holds is written: the
// alliances, the fog, the control groups and selection, the computers' brains, the placed-unit
// index, a script's looks. A new field is therefore SAVED unless it is added to this list, which
// is the safe way round: forgetting to list a cache costs a few bytes, forgetting to save state
// costs a game that is quietly different after a load.

import { registerSaveClass } from "./graph";
import { RtsController } from "../rts";

let done = false;

export function registerGameSaveClasses(): void {
  if (done) return;
  done = true;
  registerSaveClass("game.RtsController", RtsController, [
    // wiring: the renderer's samplers, the host, the data tables, the sound board, the DOM
    "heightAt", "host", "registry", "abilities", "items", "tech", "upgrades", "footMaxHeight", "sounds",
    "overlays", "voiceLabels", "aiScriptHost", "walkableAt", "waterAt",
    // the picture: one entry per model, the corpses being drawn, what the cursor is on
    "entries", "byId", "corpses", "seededInstances", "clearedInstances", "processedInstances", "lastSeenUnitCount",
    "hovered", "hoveredMine", "hoveredItem", "previewIds", "aoeHighlight", "flashRequests", "treePulses", "orderArrows",
    "forgotten", "settledEntries", "upgradeBoxCache", "buildingTiers", "creepCampView",
    // input: what is armed on the card, which modifier is down, the last voice clicked
    "orderMode", "armedUnload", "armedShopUser", "armedLoad", "armedCast", "armedItem", "shiftRearmed", "altHeld",
    "lastVoiceId", "voiceStreak",
    // scratch
    "loc", "quat", "world", "screen", "world2", "screen2", "ray", "groundT", "volumes", "rideLoc", "rideQuat", "poseOut",
    // a LAN game's wire (a saved game is single-player)
    "matchLink", "snapshot", "matchLinkIsHost", "lastApplied", "pendingWireDeaths", "wireDeaths", "snapshotMorphs",
    "poses", "poseLive", "poseGliding", "snapshotSpawns", "snapshotItemSpawns", "snapshotItemRemovals",
    "snapshotProjSpawns", "snapshotProjImpacts", "projAim", "fxEffects", "fxSplats", "fxLightnings", "fxLightningStops",
    "fxCastStarts", "fxCastFires", "fxCombatTexts", "wireFx", "saidComparisonStopped", "hbAccum", "commandsSent",
    "commandsAcked", "ackWaitSince", "sentStash", "sentTotal",
    // the load gate's own hold
    "worldHeld",
    // a look or a clip waiting for a body that is still loading — the looks are carried by the
    // scene's half of the save instead (`captureLooks`), and re-worn on the bodies of the load
    "pendingLook", "pendingAnim",
  ]);
}

/** A thing of the RENDERER or the page that a state object holds a reference to: written as
 *  opaque, so the loaded object keeps its own. A model, a model instance, a DOM node. */
export function isRenderObject(o: object): boolean {
  if (typeof EventTarget !== "undefined" && o instanceof EventTarget) return true;
  const r = o as Record<string, unknown>;
  if (typeof r.setSequence === "function" && "model" in r) return true; // an mdx instance
  if (typeof r.addInstance === "function" && "sequences" in r) return true; // an mdx model
  if (typeof WebGLRenderingContext !== "undefined" && o instanceof WebGLRenderingContext) return true;
  return false;
}
