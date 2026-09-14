import { wc3StripMarkup } from "../../../ui/wc3Text";

// Computer+ on WarChasers — what its heroes HEAR from the party, and what they SAY back.
//
// WarChasers is a co-operative dungeon crawl for four, so a computer in it is a PARTY MEMBER rather
// than a player with a plan of its own: it follows a person (the LEADER), fights beside them, and
// does what the party tells it. The developer's brief is the vocabulary: "let's wait", "wait",
// "back" must stop it; "let's go", "follow me", "attack", "hit them" must send it, overriding
// whatever it had decided for itself; and all of it has to survive the way people actually type in
// the middle of a fight — "wiat", "folow", "atack", "lets goo".
//
// The two standing rules of plus/teamchat.ts hold here too. Every line goes out through the
// ORDINARY chat path (`PlusHost.say`), and the parser must not eat the AI's own vocabulary — which
// here is enforced at the door rather than word by word: a command is only ever taken from a
// PERSON (`WarChasersAi.heard`), so "wait i need a bit more health" from one computer can never
// stop another. `tools/ai-plus-warchasers-test.cjs` pins both the parser and that rule's premise.
//
// None of the words or numbers here are Warcraft III's: nothing in the install describes a computer
// that takes orders in chat (docs/computer-plus.md), so everything is OURS.

/** What a line tells the party's computers to do. */
export type Command =
  /** Stop where you are and hold ("wait", "lets wait", "hold on", "stop"). */
  | "wait"
  /** Get out of the fight, back to the leader, and hold there ("back", "retreat", "fall back"). */
  | "back"
  /** Move on with the leader ("lets go", "go", "come on", "move"). */
  | "go"
  /** Stay on the leader ("follow me", "follow", "come here", "with me"). */
  | "follow"
  /** Fight ("attack", "hit", "hit them", "kill them", "charge"). */
  | "attack";

export interface HeardCommand {
  command: Command;
  /** "follow me" / "i lead" — the speaker is taking the lead. */
  claimsLead: boolean;
}

// --- tokens ---------------------------------------------------------------------------------------

/** A line as words: markup gone, lower case, apostrophes dropped ("let's" → "lets"), every other
 *  non-letter a break, and a run of three or more of one letter squeezed to two ("gooooo" → "goo"). */
export function words(text: string): string[] {
  return wc3StripMarkup(text ?? "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z]+/g, " ")
    .replace(/([a-z])\1{2,}/g, "$1$1")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// --- typo tolerance -------------------------------------------------------------------------------

/** QWERTY neighbours — a substitution between two of them is a slip of the finger, and costs one. */
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
function neighbours(a: string, b: string): boolean {
  const at = (c: string): [number, number] | null => {
    for (let r = 0; r < ROWS.length; r++) {
      const i = ROWS[r].indexOf(c);
      if (i >= 0) return [r, i + r * 0.5]; // each row sits half a key to the right of the one above
    }
    return null;
  };
  const pa = at(a);
  const pb = at(b);
  return !!pa && !!pb && Math.abs(pa[0] - pb[0]) <= 1 && Math.abs(pa[1] - pb[1]) <= 1;
}
const VOWELS = "aeiou";

/**
 * How far a typed word is from a vocabulary word, as a typist makes mistakes — Damerau-Levenshtein
 * with a WEIGHTED substitution: a neighbouring key or one vowel for another ("fallow", "atteck") is
 * one slip, any other letter for another is two. A dropped letter, a doubled one and two letters
 * swapped are one each.
 *
 * The weighting is what lets the tolerance be generous without hearing commands in ordinary words:
 * "what" is two plain substitutions from "wait", "shop" is h-for-t (not neighbours) from "stop", and
 * "yellow" is three from "follow".
 */
export function typoDistance(typed: string, word: string): number {
  const n = typed.length;
  const m = word.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const a = typed[i - 1];
      const b = word[j - 1];
      const sub = a === b ? 0 : neighbours(a, b) || (VOWELS.includes(a) && VOWELS.includes(b)) ? 1 : 2;
      let best = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + sub);
      if (i > 1 && j > 1 && a === word[j - 2] && typed[i - 2] === b) best = Math.min(best, d[i - 2][j - 2] + 1);
      d[i][j] = best;
    }
  }
  return d[n][m];
}

/**
 * Words that are close to a command word and are NOT one — the handful that survive the weighting
 * above and are said in a game chat often enough to matter ("the hut", "hot", "cone"…). Checked
 * before any fuzzy match, never before an exact one.
 */
const NOT_A_COMMAND: ReadonlySet<string> = new Set([
  "what", "want", "shop", "stock", "stuck", "hot", "hut", "hat", "his", "him", "home", "some", "cone", "gone", "done",
  "bold", "old", "hack", "pack", "lack", "hollow", "yellow", "fellow", "allow", "wall", "tall", "call", "halt",
  "sit", "kit", "fill", "hill", "will", "gold", "hole", "role", "goal", "good", "god", "got", "get", "gg",
  "attach", "hunt", "tank", "bank", "black", "right", "light", "night", "might", "sight", "tight", "fine", "wit",
  "rust", "best", "test", "most", "just", "must", "past", "fast", "hush", "rush", "bush", "mush", "cash", "case", "came",
]);

/** The fuzzy allowance for a word of this length: short words must be exact (or two letters
 *  swapped), because a single slip turns "hit" into "hot" and "go" into "no". */
function allowance(len: number): number {
  return len <= 3 ? 0 : len <= 5 ? 1 : 2;
}

/** Does `typed` read as `word`, typos and all? */
export function sounds(typed: string, word: string): boolean {
  if (typed === word) return true;
  if (NOT_A_COMMAND.has(typed)) return false;
  // A doubled letter ("hitt", "goo", "stopp") is still the word.
  if (typed.replace(/([a-z])\1/g, "$1") === word) return true;
  // A short word gets only the swap: "hti", "og".
  if (word.length <= 3) return typed.length === word.length && typoDistance(typed, word) === 1 && [...typed].sort().join("") === [...word].sort().join("");
  return Math.abs(typed.length - word.length) <= 2 && typoDistance(typed, word) <= allowance(word.length);
}

// --- the vocabulary -------------------------------------------------------------------------------

/** One-word commands. `go` and `hit` are short, so they are exact (or swapped) only — see `sounds`. */
const VERBS: ReadonlyArray<{ word: string; command: Command }> = [
  { word: "wait", command: "wait" }, { word: "hold", command: "wait" }, { word: "stop", command: "wait" },
  { word: "stay", command: "wait" }, { word: "halt", command: "wait" }, { word: "rest", command: "wait" },
  { word: "back", command: "back" }, { word: "retreat", command: "back" }, { word: "run", command: "back" },
  { word: "flee", command: "back" }, { word: "fallback", command: "back" },
  { word: "go", command: "go" }, { word: "letsgo", command: "go" }, { word: "move", command: "go" },
  { word: "onward", command: "go" }, { word: "forward", command: "go" }, { word: "advance", command: "go" },
  { word: "continue", command: "go" }, { word: "push", command: "go" }, { word: "gogo", command: "go" },
  { word: "follow", command: "follow" }, { word: "come", command: "follow" }, { word: "regroup", command: "follow" },
  { word: "attack", command: "attack" }, { word: "hit", command: "attack" }, { word: "kill", command: "attack" },
  { word: "fight", command: "attack" }, { word: "charge", command: "attack" }, { word: "engage", command: "attack" },
  { word: "focus", command: "attack" }, { word: "atk", command: "attack" }, { word: "smash", command: "attack" },
];

/** The word a typed token is, if it is one of `VERBS` — an exact match first, then the nearest typo. */
function verbOf(token: string): Command | null {
  for (const v of VERBS) if (v.word === token) return v.command;
  let best: { command: Command; d: number } | null = null;
  for (const v of VERBS) {
    if (!sounds(token, v.word)) continue;
    const d = typoDistance(token, v.word);
    if (!best || d < best.d) best = { command: v.command, d };
  }
  return best?.command ?? null;
}

const isWord = (token: string | undefined, ...ws: string[]): boolean => !!token && ws.some((w) => sounds(token, w));
/** The opposite of a command, for "dont wait" / "stop waiting" / "dont go". */
const OPPOSITE: Readonly<Record<Command, Command>> = { wait: "go", back: "go", go: "wait", follow: "wait", attack: "wait" };
/** Words after which "back" is news rather than an order: "im back", "be right back", "ill be back". */
const BACK_IS_NEWS: ReadonlySet<string> = new Set(["im", "am", "be", "is", "its", "right", "come", "came", "got"]);

/** Words after which an ATTACK verb is praise: "nice hit", "good kill". */
const PRAISE: ReadonlySet<string> = new Set(["nice", "good", "great", "big", "gj", "sick", "wp", "lucky", "what"]);

/** An "-ing" form's stem, doubled consonant and all: "waiting" → "wait", "hitting" → "hit", "going" → "go". */
function stem(w: string): string | null {
  if (w.length < 5 || !w.endsWith("ing")) return null;
  const s = w.slice(0, -3);
  return /([a-z])\1$/.test(s) ? s.slice(0, -1) : s;
}

/** Is token `i` turned round by what stands before it — "dont", "never", "do not", "no need to"? */
function negated(t: readonly string[], i: number): boolean {
  const p = t[i - 1];
  if (p === "dont" || p === "don" || p === "never" || p === "cant" || p === "wont") return true;
  if (p === "not" && (t[i - 2] === "do" || t[i - 2] === "dont" || t[i - 2] === "should")) return true;
  if (p === "to" && t[i - 2] === "need" && t[i - 3] === "no") return true;
  return false;
}

/**
 * What a line tells the party's computers to do, or null.
 *
 * Read left to right, and the LAST command in the line wins — "wait… ok lets go" is a go — with the
 * phrases people use settled before the single words inside them:
 *
 *  · "go back", "get back", "fall back", "pull back", "move back" are a BACK, never a go; "come back"
 *    is a FOLLOW (come back to me); and "im back", "be right back" are nothing at all.
 *  · "hold on", "hang on", "one sec", "wait up" are a WAIT; "come on" is a GO.
 *  · "follow me", "on me", "with me", "i lead", "im the leader" take the LEAD as well.
 *  · a NEGATION turns a command round: "dont wait", "no need to wait" and "stop waiting" are a go,
 *    "dont go" and "stop attacking" a wait. "stop" by itself is still a wait.
 *  · an "-ing" form on its own is NEWS, not an order ("im waiting", "attacking now") — it only counts
 *    when a "stop" turns it round.
 */
export function readCommand(text: string): HeardCommand | null {
  const t = words(text);
  // A line that is nothing but "b" is BACK — the one-key retreat people type mid-fight (the
  // developer's own rule). Only the whole line: a "b" inside a sentence ("plan b") is a letter.
  if (t.length === 1 && t[0] === "b") return { command: "back", claimsLead: false };
  let command: Command | null = null;
  let claimsLead = false;
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    const prev = t[i - 1];
    const next = t[i + 1];
    // --- phrases -----------------------------------------------------------------------------
    if (isWord(w, "back")) {
      if (isWord(prev ?? "", "come")) { command = "follow"; continue; }
      if (prev && BACK_IS_NEWS.has(prev)) continue;
      command = negated(t, i) ? "go" : "back"; // "go back", "fall back", "get back", or just "back"
      continue;
    }
    if (w === "on" && (prev === "hold" || prev === "hang")) { command = "wait"; continue; }
    if (w === "on" && isWord(prev ?? "", "come")) { command = "go"; continue; }
    if (w === "up" && isWord(prev ?? "", "wait")) { command = "wait"; continue; }
    if ((w === "sec" || w === "second" || w === "moment") && (!prev || prev === "one" || prev === "a" || prev === "just")) { command = "wait"; continue; }
    if ((w === "me" || w === "us") && (isWord(prev ?? "", "follow") || prev === "on" || prev === "with")) {
      command = "follow";
      claimsLead ||= w === "me";
      continue;
    }
    if ((w === "lead" || w === "leader") && (prev === "i" || prev === "im" || prev === "the" || prev === "ill")) {
      command ??= "follow";
      claimsLead = true;
      continue;
    }
    // Praise is not an order: "nice hit", "good kill", "great charge".
    if (prev && PRAISE.has(prev) && verbOf(w) === "attack") continue;
    if (w === "get" && (next === "them" || next === "em" || next === "him" || next === "it")) { command = "attack"; continue; }
    if (w === "out" && prev === "get") { command = "back"; continue; }
    // --- single words ------------------------------------------------------------------------
    // A verb that the next word makes into a phrase is settled on that word ("go back", "come on").
    if (isWord(next ?? "", "back") && (isWord(w, "go", "come", "fall", "pull", "move", "step") || w === "get")) continue;
    if (next === "on" && (w === "hold" || w === "hang" || isWord(w, "come"))) continue;
    if (next === "up" && isWord(w, "wait")) continue;
    const base = stem(w);
    const v = verbOf(base ?? w) ?? (base ? null : verbOf(w));
    if (!v) continue;
    if (base) {
      // "stop waiting" / "stop attacking": the stop of the thing named.
      if (prev === "stop" || prev === "quit") command = OPPOSITE[v];
      continue; // …and otherwise news
    }
    // "stop" that a following "-ing" verb turns into a negation is settled on that word.
    if (w === "stop" && next && stem(next) && verbOf(stem(next)!)) continue;
    command = negated(t, i) ? OPPOSITE[v] : v;
  }
  return command === null ? null : { command, claimsLead };
}

// --- asking for a heal ----------------------------------------------------------------------------

export interface HeardHeal {
  /** The words after the heal word, for "heal optimus" — who the heal is FOR when that is somebody
   *  other than the speaker. Empty (or "me") means the speaker. */
  readonly after: string;
}

/** Words before a heal word that make it an OFFER or news rather than a request: "i heal", "ill
 *  heal", "i can heal", "thanks for the heals". */
const HEAL_NOT_ASKED: ReadonlySet<string> = new Set(["i", "ill", "im", "will", "for", "the", "nice", "good", "thanks", "thx", "ty", "great", "gj"]);
/** …and the negations: "dont heal", "no heal", "stop healing". */
const HEAL_NEGATED: ReadonlySet<string> = new Set(["dont", "don", "no", "not", "never", "cant", "wont", "stop", "without"]);
/** Before "healing" / "hp" / "health", the words that make it wanted: "need healing", "low hp". */
const HEAL_WANTED: ReadonlySet<string> = new Set(["need", "needs", "want", "some", "get", "low"]);
/** Filler after the heal word that names nobody. */
const HEAL_FILLER: ReadonlySet<string> = new Set(["me", "pls", "plz", "please", "now", "asap", "quick", "fast", "up", "on", "a", "bit", "us"]);

/**
 * Is this line somebody ASKING the party's healer for a heal, and for whom?
 *
 * "heal", "heal me", "heal pls", "need heal", "can i get a heal", "healz", "hael", "i need healing",
 * "need hp", "im low", "heal optimus" — and not "i heal", "ill heal you", "thanks for the heals",
 * "dont heal me", "no need to heal", "im healing" or "healing now", which are offers, thanks,
 * refusals and news. A request can share a line with an order ("wait i need heal"); the two are
 * read apart, and both are acted on.
 */
export function readHealRequest(text: string): HeardHeal | null {
  const t = words(text);
  let asked: HeardHeal | null = null;
  const tail = (i: number): string => t.slice(i + 1).filter((w) => !HEAL_FILLER.has(w)).join(" ");
  const negated = (i: number): boolean => {
    const p = t[i - 1];
    if (p && HEAL_NEGATED.has(p)) return true;
    // "dont need heal", "no need to heal", "i dont need healing"
    const needAt = p === "need" ? i - 1 : p === "to" && t[i - 2] === "need" ? i - 2 : -1;
    return needAt > 0 && HEAL_NEGATED.has(t[needAt - 1]);
  };
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    const prev = t[i - 1];
    const next = t[i + 1];
    if (w === "healing" || w === "healin") {
      // A gerund is news ("im healing", "healing now") unless something WANTS it.
      if (prev && HEAL_WANTED.has(prev) && !negated(i)) asked = { after: "" };
      continue;
    }
    if (w === "healer" || w === "healers") {
      if (prev === "need" && !negated(i)) asked = { after: "" };
      continue;
    }
    if (w === "hp" || w === "health") {
      // "need hp", "low hp", "im low on health", "hp pls" — and never "his hp", "the boss is low hp".
      const wanted = (prev === "need" && !negated(i)) || (prev === "low" && (!t[i - 2] || t[i - 2] === "im"))
        || (prev === "on" && t[i - 2] === "low" && t[i - 3] === "im") || next === "pls" || next === "plz" || next === "please";
      if (wanted && !(prev && ["his", "her", "its", "their", "boss", "the"].includes(prev))) asked = { after: "" };
      continue;
    }
    if (w === "low" && prev === "im" && (!next || next === "pls" || next === "plz")) {
      asked = { after: "" };
      continue;
    }
    if (!(w === "heal" || w === "heals" || w === "healz" || w === "heel" || (w.length >= 4 && w.length <= 6 && !NOT_A_COMMAND.has(w) && sounds(w, "heal")))) continue;
    if (negated(i)) {
      asked = null; // "heal me… no dont heal me" — the last word on it wins
      continue;
    }
    if (prev && HEAL_NOT_ASKED.has(prev)) continue;
    if (prev === "can" && t[i - 2] === "i") continue; // "i can heal"
    if (next === "you" || next === "u" || next === "yourself") continue; // "heal you" is an offer
    asked = { after: tail(i) };
  }
  return asked;
}

// --- naming a computer ----------------------------------------------------------------------------

/** A map string as words for matching — see `words`. */
function nameWords(raw: string): string[] {
  return words(raw).filter((w) => w.length >= 4);
}

/**
 * Does a line NAME this hero? — "optimus wait", "megotron follow me", "snake attack". Any word of
 * four letters or more of the hero's own name (as the map spells it) is enough, allowing the same
 * typos a command gets; the two-word names only need one of their words ("Beast Knight" answers to
 * "beast"). A line that names nobody is for every computer in the party.
 */
export function namesHero(text: string, heroName: string): boolean {
  const said = words(text);
  const own = nameWords(heroName);
  return own.some((n) => said.some((w) => w.length >= 4 && (w === n || (!verbOf(w) && typoDistance(w, n) <= allowance(n.length)))));
}

// --- what it says ---------------------------------------------------------------------------------

/** Ready — it is with the leader, and going. "right behind you", "im following you". */
export const READY_LINES = ["right behind you", "im following you", "ok im ready", "ready, lets go", "with you", "good to go"] as const;

/** Acknowledging an order. */
export const ACK_LINES: Readonly<Record<Command, readonly string[]>> = {
  wait: ["ok, waiting", "ok ill wait here", "holding here", "ok"],
  back: ["ok, backing off", "falling back", "ok, pulling back"],
  go: ["right behind you", "ok lets go", "coming", "im following you"],
  follow: ["right behind you", "im following you", "on you", "ok, following"],
  attack: ["attacking!", "on it", "going in", "ok, hitting them"],
};

/** Stopping for itself — out of life. */
export const REST_HP_LINES = [
  "wait i need a bit more health", "hold on, i need to heal", "wait, low hp", "give me a sec to heal up", "wait up, im hurt",
] as const;

/** …out of mana. */
export const REST_MANA_LINES = ["wait i need some mana", "hold on, low mana", "give me a sec, im oom"] as const;

/** Told to go while it is still hurt — it goes, and says so. */
export const GOING_HURT_LINES = ["ok, but im still low", "coming, careful im low on hp", "ok ok, coming"] as const;

/** Almost dead with no Ankh left — the one thing it will not obey an order into (see `WarChasersAi`). */
export const NO_ANKH_LINES = ["im almost dead and have no ankh, backing off", "no ankh and about to die, i have to pull back"] as const;

/** It has just taken the lead's word for who the leader is. */
export function leaderLines(heroName: string | null): readonly string[] {
  return heroName ? [`following ${heroName}`, `ok, following ${heroName}`] : ["ok, following you", "im following you"];
}

/** It picked a hero. */
export function pickLines(heroName: string): readonly string[] {
  return [`ill take ${heroName}`, `${heroName} for me`, `picking ${heroName}`];
}

export const ANKH_BOUGHT_LINES = ["bought an ankh", "got a new ankh"] as const;
export const ANKH_USED_LINES = ["ankh saved me", "phew, that was my ankh", "used my ankh"] as const;
export const DEAD_LINES = ["im dead for good, sorry", "out of ankhs, im gone. good luck"] as const;

/** Answering a heal request — it is coming now. */
export const HEAL_NOW_LINES = ["healing you", "on it, healing", "heal incoming"] as const;
/** …in a few seconds (the heal is on cooldown, or the mana is nearly there). */
export function healSoonLines(seconds: number): readonly string[] {
  const s = Math.max(1, Math.ceil(seconds));
  return [`heal in ${s} sec`, `ok, heal ready in ${s}s`, `hold on, heal in ${s} sec`];
}
/** …it cannot, and why. */
export const HEAL_COOLDOWN_LINES = ["my heal is on cooldown, sorry", "heal on cd"] as const;
export const HEAL_OOM_LINES = ["no mana for a heal", "im oom, cant heal"] as const;
export const HEAL_CANT_LINES = ["my heal cant target you", "cant heal you with that"] as const;
export const NO_HEAL_LINES = ["i dont have a heal"] as const;
export const FULL_HP_LINES = ["youre at full hp"] as const;

/** Seconds between two lines one computer says of its own accord (an answer to an order is not held
 *  to it — somebody asked). */
export const TALK_GAP = 8;
/** Seconds between two "wait i need health" lines from one computer while it keeps resting. */
export const REST_TALK_GAP = 14;
