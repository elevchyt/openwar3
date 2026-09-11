import { wc3StripMarkup } from "../../../ui/wc3Text";
import { readAllyCall } from "../teamchat";

// Computer+ on Extreme Candy War — what its heroes SAY, and what they hear.
//
// A lane map is played by talking far more than a melee game is: who is going where, who is going
// in on whom, who is running. So this file is the hero game's counterpart of plus/teamchat.ts, and
// it keeps that file's two standing rules:
//
//  · Every line goes out through the ORDINARY chat path (`PlusHost.say` → `deliverChat`), routed,
//    tagged, logged and relayed exactly like a typed one. Team talk is on the ALLIES channel; the
//    banter after a kill is on ALL, because an opponent is who it is for.
//  · The parser must not eat its own vocabulary. Every line below is run through `readCandyCall` by
//    `tools/ai-plus-candy-test.cjs`, and a line that is not meant as a call must not read as one —
//    an "im back" heard as "back!" pulls every hero on the team out of its lane.
//
// The one place it departs from teamchat.ts is the banter. Issue #124 ruled jokes out of the melee
// computer; the developer asked for them here in as many words ("jokes/light banter when they kill
// an opponent"), and the map is Blizzard's own Halloween map ("Happy Halloween!", its w3i
// description), so what little there is is candy-and-trick-or-treat and never at a person.
//
// None of the words or numbers here are Warcraft III's: nothing in the install describes a
// computer that talks (docs/computer-plus.md), so everything is OURS.

/** The three lanes, as a player names them. */
export type Lane = "top" | "mid" | "bot";
export const LANES: readonly Lane[] = ["top", "mid", "bot"];

/** Lowercase, every non-letter a space, a space on each end — plus/teamchat.ts `fold`'s shape. */
function fold(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
}

/** The lane a line names, or null. "bottom"/"bot" are one lane, "middle"/"mid" another. */
export function laneIn(text: string): Lane | null {
  const said = fold(text);
  if (/ (top|north|upper) /.test(said)) return "top";
  if (/ (mid|middle|center|centre) /.test(said)) return "mid";
  if (/ (bot|bottom|south|lower) /.test(said)) return "bot";
  return null;
}

// --- what it says ------------------------------------------------------------------------------

/** "im going mid" — said once per trip out of the base, when it picks a lane. */
export const LANE_LINES: Record<Lane, readonly string[]> = {
  top: ["im going top", "going top", "i'll take top", "top is mine"],
  mid: ["im going mid", "going mid", "i'll take mid", "mid is mine"],
  bot: ["im going bottom", "going bot", "i'll take bottom", "bot is mine"],
};

/** …and when it moves to another one mid-game (a lane with nobody of ours in it, a push). */
export function laneSwitchLines(lane: Lane): readonly string[] {
  const word = lane === "bot" ? "bottom" : lane;
  return [`moving to ${word}`, `heading ${word}`, `rotating ${word}`];
}

/**
 * "going in on the undead warlock" — it has picked an enemy HERO to kill and is committing to it.
 *
 * `name` is a whole phrase from `heroCallName` ("the undead warlock", "boogie kid the mage"), so a
 * teammate reads WHO without looking anything up, and allied computers resolve it back to the
 * unit (`namedHero`) — though an allied computer mostly does not need to, since it is standing next
 * to the fight and SEES who its teammate is swinging at (`CandyWarAi.allyEngagement`).
 */
export function engageLines(name: string): readonly string[] {
  return [`going in on ${name}`, `jumping ${name}`, `engaging ${name}`, `diving ${name}`, `focus ${name}`];
}

/** "with you on the mage" — it has seen (or heard) an ally go in and is coming to help. */
export function followLines(name: string): readonly string[] {
  return [`with you on ${name}`, `helping on ${name}`, `right behind you`, `coming for ${name}`];
}

/** It is leaving the fight for ITSELF — low on life or mana. Not a call: nobody else should run. */
export const SELF_BACK_LINES = [
  "falling back", "backing off, low hp", "low hp, heading to base", "retreating to heal", "oom, heading to base",
] as const;

/** It is telling the TEAM to leave — the enemy is here in numbers. This one IS a call. */
export const TEAM_BACK_LINES = ["back off, too many", "careful, back off", "retreat, they have more"] as const;

/** It died. */
export const DEATH_LINES = ["they got me", "died, sorry", "dead, out for a bit", "ugh, dead"] as const;

/** It killed an enemy hero — to the team. */
export function killLines(name: string): readonly string[] {
  return [`got ${name}`, `${name} is down`, `took out ${name}`];
}

/**
 * …and to EVERYONE. Light, candy-flavoured, never aimed at a person — see the file header.
 * Some take the victim's name, which is the hero's (`heroCallName`), never the player's.
 */
export function banterLines(name: string): readonly string[] {
  return [
    "trick or treat!", "no candy for you", "sugar rush!", "should have stayed home", "better luck next halloween",
    "om nom nom", "you dropped your candy", "boo!", "that one was sugar free", "gimme your candy",
    `sweet dreams, ${name}`, `bye bye ${name}`, `${name} needs more candy`,
  ];
}

/** …and when it is the one killed, sometimes — a good sport, never a sore one. */
export const GOOD_SPORT_LINES = ["nice one", "wp", "ok that was clean", "lucky"] as const;

/** "careful, 3 heroes mid" — it sees the enemy grouped where an ally is. */
export function warnLines(count: number, lane: Lane | null): readonly string[] {
  const where = lane ? (lane === "bot" ? " bottom" : ` ${lane}`) : "";
  return [`careful, ${count} heroes${where}`, `${count} of them${where}`, `watch out, ${count} coming${where}`];
}

/** Answering "help" — on the way. */
export const CANDY_COMING_LINES = ["omw", "on my way", "coming"] as const;

/** …or not, and why. Every line opens with a word plus/teamchat.ts `BUSY` reads. */
export const CANDY_BUSY_LINES = {
  dead: ["can't come, i'm dead", "can't help, dead right now"],
  hurt: ["can't come, i'm almost dead", "not now, need to heal first"],
  fighting: ["can't come, i'm fighting", "not now, in a fight"],
  far: ["can't come there, too far", "not now, i'm across the map"],
} as const;

/** "ok, pushing with you" — yes to a rally. Every line reads as `joining` or `coming`. */
export const CANDY_RALLY_YES_LINES = [
  "ok im in", "right behind you", "on it", "count me in", "ok, coming with you", "ill join you",
] as const;

/** …no to a rally, and why. */
export const CANDY_RALLY_NO_LINES = {
  dead: ["can't join, i'm dead", "not now, waiting to respawn"],
  hurt: ["can't join, too low", "not now, need to heal"],
  fighting: ["can't join, i'm in a fight", "not now, busy fighting"],
} as const;

// --- naming a hero -----------------------------------------------------------------------------

/**
 * What a hero is CALLED in chat: the hero's name, which on this map is its class — the unit type's
 * name, "Undead Priest" — and nothing else. The given name a hero also carries ("Boogie Kid") is
 * left out, and so is any article: the developer's rule is that a line names the enemy hero by
 * that name only ("going in on Undead Priest").
 *
 * It is the MAP's string, never typed here: a custom map colours its unit names in the object
 * editor, so the markup is stripped (`wc3StripMarkup`) and the words are kept as the map spells
 * them. Only a hero whose type has no name falls back on its given name.
 */
export function heroCallName(typeName: string, properName: string): string {
  const title = spoken(typeName);
  if (title) return title;
  return spoken(properName) || "their hero";
}

/** A map string as a NAME in chat: markup gone, spaces collapsed, the map's own capitals kept. */
function spoken(raw: string): string {
  return wc3StripMarkup(raw ?? "").replace(/\s+/g, " ").trim();
}

/** A map string as chat: markup gone, lowercase, spaces collapsed. */
export function plain(raw: string): string {
  return wc3StripMarkup(raw ?? "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** One enemy hero, as the reader of a line sees it. */
export interface HeroName {
  id: number;
  typeName: string;
  properName: string;
}

/**
 * The enemy hero a line names, or 0.
 *
 * Tried by GIVEN name first (it is unique), then by the class — the whole title ("undead warlock")
 * before its last word ("warlock"), longest first, so "the undead mage" never reads as a call on
 * the human mage when both are playing. A word both of two heroes answer to names neither: an army
 * aimed at the wrong one of two mages is worse than no call at all.
 */
export function namedHero(text: string, heroes: readonly HeroName[]): number {
  const said = fold(text);
  const hit = (word: string): boolean => word.length > 2 && said.includes(` ${word} `);
  for (const h of heroes) if (hit(fold(plain(h.properName)).trim())) return h.id;
  for (const pass of [(h: HeroName) => fold(plain(h.typeName)).trim(), (h: HeroName) => fold(plain(h.typeName)).trim().split(" ").pop() ?? ""]) {
    const matches = heroes.filter((h) => hit(pass(h)));
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) return 0;
  }
  return 0;
}

// --- what it hears -----------------------------------------------------------------------------

/**
 * What a heard line asks of a Candy War hero.
 *
 * A `rally` carries `ask`: true when plus/teamchat.ts itself reads it as a request ("attack",
 * "lets push mid", "going in on the orc"), false when all it has is an ENGAGE verb ("jumping the
 * mage") — which means something only if the line also names an enemy hero, and the caller is the
 * one who knows the heroes (`namedHero`).
 */
export type CandyCall =
  | { kind: "help"; lane: Lane | null }
  | { kind: "rally"; lane: Lane | null; ask: boolean }
  | { kind: "retreat" }
  | { kind: "lane"; lane: Lane }
  | { kind: "answer" };

/** The verbs of going in on ONE target — see `CandyCall`. */
const ENGAGE = /\b(go in on|going in on|jump|jumping|engage|engaging|dive|diving|gank|ganking|focus|kill|attack|hit|get)\b/;

/** "lets go top", "lets push bot" — a rally that is also a lane, which the lane claim below would
 *  otherwise take for news. */
const LANE_RALLY = /\b(lets|let s|let us) (go|push|all go|group) (top|mid|middle|bot|bottom)\b/;

/**
 * `BACK` — "back!", "retreat", "fall back", "back off, too many". A call to the team to leave.
 *
 * Anchored to the start of the line (after at most two filler words) on purpose: every hero that
 * leaves a fight for itself says so ("falling back", "low hp, heading to base"), and those are
 * news, not orders. Only the imperative moves anybody else.
 */
const BACK: readonly RegExp[] = [
  /^ (?:(?:guys|all|everyone|team|ok|go|pls|plz|careful) ){0,2}(back|retreat|fall back|pull back|back off|get out|run|go back|bail)\b/,
];

/** "im going top", "i'll take bot", "top is mine" — a teammate claiming a lane. News, for the
 *  lane split (`CandyWarAi.pickLane`). */
const LANE_CLAIM: readonly RegExp[] = [
  /\b(im|i m|i ll|ill|i will|i am)? ?(going|go|take|taking|staying|headed|heading|moving|rotating|stay) (to )?(top|mid|middle|bot|bottom)\b/,
  /\b(top|mid|middle|bot|bottom) (is mine|for me)\b/,
];

/**
 * What a line says to a Candy War hero, or null.
 *
 * plus/teamchat.ts reads the words it already knows — a request for help, a rally, and the three
 * kinds of ANSWER (which are recognised so that nothing answers an answer). On top of that: a call
 * to fall back, and a lane claim. The order is the parser, as it is there: answers first, then the
 * call to fall back (so "back off, too many" is never read as a rally by its "off"… or by anything
 * else), then help and rally, then the lane claim — which is only news, so it comes last.
 *
 * An ENGAGE ("going in on the warlock") reads here as a rally or as nothing; whether it names an
 * enemy hero is the caller's question (`namedHero`), because only the caller knows who is playing.
 */
export function readCandyCall(text: string): CandyCall | null {
  const said = fold(text);
  if (!said.trim()) return null;
  const ally = readAllyCall(text);
  if (ally === "joining" || ally === "coming" || ally === "busy") return { kind: "answer" };
  if (BACK.some((re) => re.test(said))) return { kind: "retreat" };
  if (ally === "help") return { kind: "help", lane: laneIn(text) };
  if (ally === "rally" || ally === "attack" || LANE_RALLY.test(said)) return { kind: "rally", lane: laneIn(text), ask: true };
  if (LANE_CLAIM.some((re) => re.test(said))) {
    const lane = laneIn(text);
    if (lane) return { kind: "lane", lane };
  }
  if (ENGAGE.test(said)) return { kind: "rally", lane: laneIn(text), ask: false };
  return null;
}

// --- the clocks --------------------------------------------------------------------------------

/** Seconds between two lines of TEAM talk from one hero, the answers excepted. */
export const CANDY_TALK_GAP = 12;
/** Seconds between two engage calls — a hero diving the same target twice is one dive. */
export const ENGAGE_TALK_GAP = 20;
/** Chance a kill is followed by a line on ALL, and the gap between two such lines. Most kills go
 *  unremarked — banter after every one of them is a bot, not a player. */
export const BANTER_CHANCE = 0.45;
export const BANTER_GAP = 40;
/** Chance a death is followed by a good-sport line on ALL. */
export const GOOD_SPORT_CHANCE = 0.2;
/** Seconds one hero's answer to a help call or a rally stands (teamchat.ts `RALLY_ANSWER_GAP`). */
export const CANDY_ANSWER_GAP = 20;
/** Seconds between two "careful, 3 heroes mid" warnings. */
export const WARN_GAP = 45;
