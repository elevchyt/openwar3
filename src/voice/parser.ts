// Voice Control's MAPPING: what the recogniser heard → the commands a player could have clicked.
//
// Deterministic, and deliberately so. The recogniser is told which words it may hear
// (src/voice/model.ts), so what arrives here is already a sentence in a closed vocabulary —
// "train three footmen", "storm bolt the enemy hero", "group two" — and turning a closed
// vocabulary into commands is a small grammar, not a model. A grammar is instant on the slowest
// machine, never invents an action the player did not say, and does the same thing every time;
// a language model would cost seconds per command on the PCs this has to run on.
//
// Kept pure (no DOM, no game): the NAMES it can match are handed in as a lexicon built from
// the game's own tables (src/voice/vocabulary.ts), and what comes out is a list of intents for
// the match to carry out through the very paths a click takes (render/mapViewer.ts). So the
// grammar can be pinned headlessly (tools/voice-parser-test.cjs).
//
// THE SENTENCE SHAPE is the one a player says out loud:
//
//     [verb] [count] [name] [preposition] [target]      "train 3 footmen", "attack the hero"
//     [name] [target]                                   "storm bolt that", "blizzard here"
//     … and … / … then …                                 several commands in one breath
//
// A sentence with no verb is a BUTTON's name — any button on the command card can be pressed
// by saying what it is called, which is what makes a map's custom abilities speakable without
// a line of code for them.

/** One name the player may say, and what it names. */
export interface LexEntry {
  /** What it is, for the intent that names it. */
  kind: "unit" | "building" | "ability" | "upgrade" | "item" | "button" | "hero";
  /** The game id (a unit type, an ability code, an upgrade id, an item id) or, for "button", the
   *  card's command id (`ability:AHtb`, `train:hfoo`, `move`…). */
  id: string;
  /** The phrase as the game spells it ("Storm Bolt", "Footman"). */
  phrase: string;
  /** A MISHEARING matched on purpose ("borough" for Burrow) — read, but never put in the
   *  recogniser's prompt, which would teach it the wrong spelling. */
  misheard?: boolean;
}

export type Side = "mine" | "enemy" | "ally" | "any";

/** A part of the MAP a target is looked for in — "a gold mine on the right side of the map",
 *  "the top left". Each axis is -1 (left / bottom), +1 (right / top), 0 (the middle third) or
 *  null (either). */
export interface Region {
  x: -1 | 0 | 1 | null;
  y: -1 | 0 | 1 | null;
}

/** Which of several matches: the nearest (the default), or "another"/"next" — the nearest one
 *  that is NOT the one the camera is already on, so saying it again walks through them. */
export type Pick = "nearest" | "next";

/** Where an order goes. */
export type VoiceTarget =
  | { kind: "screen" } // "here", "there", "this", "that" — the middle of the screen
  | { kind: "cursor" } // "the cursor", "the mouse" — only when the player says so
  | { kind: "unit"; entry: LexEntry; side: Side; region?: Region; pick?: Pick } // "the enemy footman"
  | { kind: "hero"; side: Side; region?: Region; pick?: Pick } // "the hero", "my hero", "their hero"
  | { kind: "base"; side: Side; region?: Region; pick?: Pick } // "home", "my base", "the enemy base"
  | { kind: "mine"; region?: Region; pick?: Pick } // "the gold mine", "another gold mine"
  | { kind: "trees" } // "the trees", "the forest"
  | { kind: "army" } // "my army"
  /** "the creep camp", "another camp", "a green camp" — `tier` is the minimap's own colour for
   *  the camp's combined level (game/minimapView.ts: green 1–9, orange 10–19, red 20+). */
  | { kind: "creeps"; region?: Region; pick?: Pick; tier?: "green" | "orange" | "red" }
  | { kind: "region"; region: Region } // "the top left", "the middle of the map"
  /** "move up", "go north west", "move left a bit": a WALK in a direction from where the units
   *  stand (screen up is north — the camera never turns), `scale` times the usual distance. */
  | { kind: "step"; dx: number; dy: number; scale: number };

/**
 * WHO an order is for, when the player names them instead of selecting them: "ALL PEASANTS on
 * gold", "select ONE WORKER FROM WOOD", "send two footmen there". `worker` is the race's
 * gatherers whatever the player calls them (a human saying "peon" means his peasants);
 * `count` is a number or "all", and `counted` says whether the player said it — "select peasant"
 * (said nothing, one) means an IDLE one, "select one peasant" any one. `from` keeps only those
 * gathering that resource.
 */
export interface Subject {
  entry?: LexEntry;
  worker: boolean;
  count: number | "all";
  counted: boolean;
  idle: boolean;
  from?: "gold" | "lumber";
  /** The NUMBER on a unit's voice label ("select fiend 4" — the "Fiend 4" floated over it while
   *  Voice Control is on, game/voiceLabels.ts). */
  index?: number;
}

export type OrderVerb = "move" | "attack" | "attackmove" | "patrol" | "attackground" | "rally" | "smart";

export type VoiceIntent =
  /** "Fall back", "retreat", "go home": the whole army ("-") walks home, or to the place said. */
  | { kind: "retreat"; target?: VoiceTarget }
  /** `source` is a rally's building TYPE ("the rally point of the barracks"), set on every one of
   *  ours without touching the selection. */
  | { kind: "order"; order: OrderVerb; target?: VoiceTarget; subject?: Subject; source?: LexEntry }
  | { kind: "stop" }
  | { kind: "hold" }
  | { kind: "cancel" }
  | { kind: "harvest"; res?: "gold" | "lumber"; target?: VoiceTarget; subject?: Subject }
  | { kind: "train"; entry: LexEntry; count: number }
  | { kind: "build"; entry: LexEntry; target?: VoiceTarget }
  /** "Finish the altar": put a worker back on a building of ours whose construction halted
   *  (its builder walked off). No `entry` = the nearest such building; `all` = every one. */
  | { kind: "finish"; entry?: LexEntry; all: boolean }
  | { kind: "research"; entry: LexEntry }
  | { kind: "learn"; entry: LexEntry }
  | { kind: "press"; entry: LexEntry; target?: VoiceTarget }
  | { kind: "autocast"; entry: LexEntry; on: boolean }
  | { kind: "useitem"; entry?: LexEntry; slot?: number; target?: VoiceTarget }
  | { kind: "select"; what: "army" | "idle" | "hero" | "subject"; subject?: Subject; index?: number }
  | { kind: "group"; n: number; mode: "recall" | "assign" | "add" }
  | { kind: "camera"; target: VoiceTarget }
  /** The console's four panels — F9 Quests, F10 Menu, F11 Allies, F12 the chat/message log.
   *  `open` null = toggle. */
  | { kind: "panel"; panel: "quests" | "menu" | "allies" | "chat"; open: boolean | null }
  | { kind: "pause"; on: boolean }
  /** A chat line, or with no text the chat input opened. `scope` null = the player's default. */
  | { kind: "chat"; text: string; scope: "all" | "allies" | null };

/** Number words → value. "a"/"an" count as one ("train a footman"). */
const NUMBERS: Record<string, number> = {
  zero: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6,
  seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1,
};
/** The digit forms a recogniser may print instead. */
for (let i = 0; i <= 12; i++) NUMBERS[String(i)] = i;

/** Words that carry nothing in a command ("please train the footman"). "the" is dropped
 *  everywhere; "a"/"an" are numbers until a count has been read. */
const FILLER = new Set(["please", "the", "now", "go", "ahead", "and", "then", "um", "uh", "some", "of", "with", "your", "you"]);

/** The words that make a TARGET out of the rest of the sentence. "Here" is the middle of the
 *  SCREEN — what the player is looking at — and the mouse only when they say the mouse: a player
 *  playing by voice may not have a hand on it at all. */
const SCREEN_WORDS = new Set(["here", "there", "this", "that", "it", "him", "her", "them", "screen"]);
const CURSOR_WORDS = new Set(["cursor", "mouse", "pointer"]);
/** "another gold mine", "the next one". */
const NEXT_WORDS = new Set(["another", "next", "other", "different", "second"]);
const NEAREST_WORDS = new Set(["nearest", "closest", "near", "close"]);
/** Compass and side words → an axis of `Region`. */
const REGION_WORDS: Record<string, Partial<Region>> = {
  left: { x: -1 }, west: { x: -1 }, western: { x: -1 },
  right: { x: 1 }, east: { x: 1 }, eastern: { x: 1 },
  top: { y: 1 }, north: { y: 1 }, northern: { y: 1 }, upper: { y: 1 },
  bottom: { y: -1 }, south: { y: -1 }, southern: { y: -1 }, lower: { y: -1 },
  middle: { x: 0, y: 0 }, center: { x: 0, y: 0 }, centre: { x: 0, y: 0 },
};
/** A DIRECTION said right after the verb, with no "to the" before it ("move up", "go north"):
 *  a walk from where the units are, not a part of the map ("move to the north" is a region). */
const DIRECTION_WORDS: Record<string, [number, number]> = {
  up: [0, 1], upward: [0, 1], upwards: [0, 1], north: [0, 1], northward: [0, 1], northwards: [0, 1], forward: [0, 1], forwards: [0, 1],
  down: [0, -1], downward: [0, -1], downwards: [0, -1], south: [0, -1], southward: [0, -1], southwards: [0, -1],
  left: [-1, 0], leftward: [-1, 0], leftwards: [-1, 0], west: [-1, 0], westward: [-1, 0], westwards: [-1, 0],
  right: [1, 0], rightward: [1, 0], rightwards: [1, 0], east: [1, 0], eastward: [1, 0], eastwards: [1, 0],
  northeast: [1, 1], northwest: [-1, 1], southeast: [1, -1], southwest: [-1, -1],
};

/** A direction at `at` ("up", "north east", "up and to the left", "left a bit"), or null. */
export function readDirection(ws: readonly string[], at: number): { dx: number; dy: number; scale: number; end: number } | null {
  let i = at;
  const first = DIRECTION_WORDS[ws[i] ?? ""];
  if (!first) return null;
  let [dx, dy] = first;
  i++;
  // A second direction on the other axis: "north east", "up and left", "up and to the right".
  let j = i;
  while (ws[j] === "and" || ws[j] === "to" || ws[j] === "the") j++;
  const second = DIRECTION_WORDS[ws[j] ?? ""];
  if (second && (second[0] === 0) !== (dx === 0)) {
    dx += second[0];
    dy += second[1];
    i = j + 1;
  }
  // "a bit", "a little", "slightly" — half; "a lot", "far", "more" — double.
  let scale = 1;
  const rest = ws.slice(i).join(" ");
  if (/^(a )?(bit|little|tad|touch)\b|^slightly\b/.test(rest)) scale = 0.5;
  else if (/^(a lot|far|much|more|further|way)\b/.test(rest)) scale = 2;
  return { dx, dy, scale, end: i };
}

const ENEMY_WORDS = new Set(["enemy", "enemies", "their", "hostile", "opponent", "opponents", "his"]);
const MINE_WORDS = new Set(["my", "our", "mine"]);
const ALLY_WORDS = new Set(["ally", "allied", "friendly"]);
const PREPOSITIONS = new Set(["on", "at", "to", "into", "onto", "toward", "towards", "near", "in"]);
/** The race's gatherers, by any race's word for them: a human who says "peon" means his
 *  peasants. (The undead's Ghoul gathers too, but is a soldier first and is named as one.) */
const WORKER_WORDS = new Set(["worker", "workers", "peasant", "peasants", "peon", "peons", "acolyte", "acolytes",
  "wisp", "wisps", "harvester", "harvesters", "gatherer", "gatherers", "builder", "builders", "slave", "slaves"]);
const ALL_WORDS = new Set(["all", "every", "each", "everyone", "everybody"]);
/** Words between a subject and the resource it is working ("one worker FROM wood", "peasants
 *  THAT ARE MINING gold"). */
const FROM_WORDS = new Set(["from", "on", "at", "in", "that", "are", "is", "who", "which", "currently",
  "gathering", "mining", "chopping", "harvesting", "working", "cutting", "collecting"]);
const GOLD_WORDS = new Set(["gold", "mine", "mines"]);
const LUMBER_WORDS = new Set(["wood", "lumber", "tree", "trees", "forest"]);
/** A count must not swallow a preposition the recogniser spelled as a number ("send TO gold"). */
const NOT_COUNTS = new Set(["to", "too", "for", "won", "ate"]);

/** Verb synonyms. The left word is what the player says; the right is what it means. Two-word
 *  verbs are matched first ("attack move" before "attack"). */
const VERBS2: Array<[string, string]> = [
  ["attack move", "attackmove"], ["a move", "attackmove"], ["attack ground", "attackground"],
  ["hold position", "hold"], ["set rally", "rally"], ["rally point", "rally"], ["control group", "group"],
  ["make group", "assign"], ["set group", "assign"], ["assign group", "assign"], ["bind group", "assign"],
  ["add to", "add"], ["turn on", "auto-on"], ["turn off", "auto-off"], ["never mind", "cancel"],
  ["look at", "camera"], ["go to", "move"], ["chop wood", "lumber"], ["cut wood", "lumber"],
  ["get gold", "gold"], ["get lumber", "lumber"], ["get wood", "lumber"], ["idle worker", "idle"],
  ["select army", "army"], ["rally point", "rally"],
  ["fall back", "retreat"], ["pull back", "retreat"], ["go home", "retreat"], ["run home", "retreat"],
  ["back off", "retreat"], ["head home", "retreat"], ["come home", "retreat"], ["get out", "retreat"],
  ["go back", "retreat"], ["get back", "retreat"], ["move back", "retreat"], ["run back", "retreat"],
  ["head back", "retreat"], ["come back", "retreat"], ["pull out", "retreat"], ["run away", "retreat"],
  ["back up", "retreat"], ["fall out", "retreat"],
  ["town portal", "teleport"], ["port out", "teleport"], ["port home", "teleport"], ["port back", "teleport"],
  ["go collect", "harvest"], ["go gather", "harvest"], ["go harvest", "harvest"], ["go mine", "harvest"],
];
const VERBS1: Record<string, string> = {
  move: "move", walk: "move", run: "move", retreat: "retreat", withdraw: "retreat", regroup: "retreat", come: "move",
  attack: "attack", hit: "attack", kill: "attack", fight: "attack", charge: "attack",
  amove: "attackmove", patrol: "patrol", rally: "rally", follow: "follow", escort: "follow", accompany: "follow",
  head: "move", march: "move", step: "move",
  // "put all peasants on gold", "send two footmen there", "put the rally point of the barracks
  // on my hero", "put a farm here": one verb whose meaning is read off the rest of the clause.
  put: "put", send: "put", set: "put", assign: "put", order: "put", tell: "put", have: "put",
  stop: "stop", halt: "stop", hold: "hold", cancel: "cancel", escape: "cancel", back: "cancel",
  gather: "harvest", harvest: "harvest", mine: "harvest", collect: "harvest", chop: "lumber",
  gathering: "harvest", harvesting: "harvest", collecting: "harvest", mining: "harvest",
  // The Scroll of Town Portal is "tp" to everyone who has played: "tp out", "teleport home".
  teleport: "teleport", tp: "teleport", tpe: "teleport", portal: "teleport",
  train: "train", make: "train", recruit: "train", hire: "train", produce: "train", summon: "train", create: "train",
  build: "build", construct: "build", place: "build",
  research: "research", upgrade: "research", improve: "research",
  finish: "finish", complete: "finish", resume: "finish", continue: "finish",
  learn: "learn", skill: "learn",
  cast: "press", use: "press", press: "press", click: "press", activate: "press", do: "press",
  autocast: "autocast",
  select: "select", choose: "select", pick: "select", grab: "select",
  group: "group", camera: "camera", view: "camera", show: "camera", jump: "camera", pan: "camera", scroll: "camera",
  everyone: "army", everybody: "army", army: "army", idle: "idle",
};

/** What the recogniser writes for a word it has rarely heard spoken, put back before anything
 *  reads it — matched on the CLEANED text (lower case, no punctuation, single spaces), so
 *  "T.P." arrives as "t p". "Acolyte" is the standing case: Whisper hears "a collide",
 *  "accolade", "acolite"; "tp" comes out "teepee"; "Priestess of the Moon" "priest is of the
 *  moon". */
const MISHEARD: Array<[RegExp, string]> = [
  [/\b(a collides|accolades|acolites|a colites|a collites|acolights)\b/g, "acolytes"],
  [/\b(a collide|accolade|acolite|a colite|a collite|acolight|a coli?ght|ecolite|acolyt)\b/g, "acolyte"],
  [/\b(t p|tee pee|teepee|tepee|tea pee|tipi|t pee|tee p)\b/g, "tp"],
  [/\bfallback\b/g, "fall back"],
  [/\b(priest is|priestess is|priests of|priest of|pristess|priestesses) (of )?(the )?moon\b/g, "priestess of the moon"],
  [/\bpriestess of (the )?(moon|mood|mon|moan|mun)\b/g, "priestess of the moon"],
];

/** Lower-case, strip WC3 markup and punctuation, put the known mishearings back, split. */
export function words(text: string): string[] {
  let t = ` ${text
    .toLowerCase()
    .replace(/\|c[0-9a-f]{8}|\|r|\|n/gi, " ")
    .replace(/[-_]/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/'/g, "")
    .replace(/\s+/g, " ")} `;
  for (const [re, to] of MISHEARD) t = t.replace(re, to);
  // "up and to the left" is ONE direction; the clause splitter would read the "and" as a second
  // command.
  t = t.replace(/\b(up|upward|upwards|down|downward|downwards|north|south|forward|forwards) and (to the )?(left|right|east|west)\b/g, "$1 $3");
  return t.split(/\s+/).filter(Boolean);
}

/** One word's DICTIONARY form, so "footmen" says "footman" and "wolves" "wolf". Applied to both
 *  sides of every comparison, so it only has to be consistent, not correct English. */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("men")) return w.slice(0, -3) + "man";
  if (w.endsWith("ves")) return w.slice(0, -3) + "f";
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ches") || w.endsWith("shes") || w.endsWith("xes") || w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

/** A phrase's comparison key: its words stemmed and run together ("Blade Master" and
 *  "blademasters" both read `blademaster`), so a recogniser's word split never matters. */
export function key(ws: readonly string[]): string {
  return ws.map(stem).join("");
}

/**
 * A word as it SOUNDS, roughly: the consonant skeleton after the first letter, doubled letters
 * single, the common same-sound spellings folded ("ph"/"f", "ck"/"k", "z"/"s", "c" before e/i
 * as "s"). A free-text recogniser's misses are mostly spellings of the right sound — "alter" for
 * Altar, "rifle men" for Riflemen, "goul" for Ghoul — and two keys that sound alike are a match
 * the edit distance alone would refuse for a short name.
 */
export function sound(k: string): string {
  const s = k
    .replace(/ph/g, "f").replace(/ck/g, "k").replace(/gh/g, "g").replace(/z/g, "s")
    .replace(/c([eiy])/g, "s$1").replace(/c/g, "k").replace(/q/g, "k").replace(/x/g, "ks");
  const head = s[0] ?? "";
  return (head + s.slice(1).replace(/[aeiouyhw]/g, "")).replace(/(.)\1+/g, "$1");
}

/** Levenshtein distance, capped (the caller only ever asks "within k?"). */
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The lexicon, indexed once per vocabulary (a match changes it when the card changes). */
export class Lexicon {
  readonly entries: ReadonlyArray<{ entry: LexEntry; key: string; len: number }>;
  constructor(entries: readonly LexEntry[]) {
    const seen = new Set<string>();
    const out: Array<{ entry: LexEntry; key: string; len: number }> = [];
    for (const e of entries) {
      const ws = words(e.phrase);
      if (!ws.length) continue;
      const k = key(ws);
      const dedupe = `${e.kind}|${e.id}|${k}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ entry: e, key: k, len: ws.length });
    }
    this.entries = out;
  }

  /**
   * The best entry spelled by the words starting at `at` — trying every span up to four words
   * longer than the entry (a recogniser may split "blademaster" into "blade master"), preferring
   * an EXACT key over a near one and a longer span over a shorter, so "storm bolt" never stops
   * at "storm". `kinds` narrows the search ("train" only wants units).
   */
  match(ws: readonly string[], at: number, kinds?: ReadonlyArray<LexEntry["kind"]>): { entry: LexEntry; end: number } | null {
    let best: { entry: LexEntry; end: number; score: number } | null = null;
    for (let end = Math.min(ws.length, at + 5); end > at; end--) {
      const k = key(ws.slice(at, end));
      for (const e of this.entries) {
        if (kinds && !kinds.includes(e.entry.kind)) continue;
        // A near miss is allowed one edit per five letters — enough for "riflemen"/"rifleman"
        // that survived stemming and for a plural the recogniser spelled oddly, not enough to
        // turn "farm" into "arm".
        const cap = e.key.length >= 6 ? Math.floor(e.key.length / 5) : 0;
        let d = k === e.key ? 0 : distance(k, e.key, cap);
        // …or the same SOUND (a free-text recogniser spells the right sound wrongly), from four
        // letters up — under that a skeleton is too short to mean anything ("orc" and "ark").
        if (d > cap && e.key.length >= 4 && sound(k) === sound(e.key)) d = cap + 1;
        else if (d > cap) continue;
        const score = (end - at) * 10 - d * 15;
        if (!best || score > best.score) best = { entry: e.entry, end, score };
      }
    }
    return best ? { entry: best.entry, end: best.end } : null;
  }
}

/** What `parse` needs besides the words. */
export interface ParseContext {
  lexicon: Lexicon;
}


/** Parse what was heard. An empty list means nothing in it was a command. */
export function parse(text: string, ctx: ParseContext): VoiceIntent[] {
  const ws = words(text);
  // A chat line is ONE thing however many "and"s it has: they are the message's own.
  const chat = parseChat(ws);
  if (chat) return [chat];
  const out: VoiceIntent[] = [];
  // Split on the joins a player uses between two commands. A clause with no verb of its own
  // inherits the previous one ("select footmen and riflemen").
  const clauses: string[][] = [[]];
  for (const w of ws) {
    if (w === "and" || w === "then") clauses.push([]);
    else clauses[clauses.length - 1].push(w);
  }
  let lastVerb: string | null = null;
  for (const c of clauses) {
    if (!c.length) continue;
    const r = parseClause(c, ctx, lastVerb);
    if (r) {
      out.push(r.intent);
      lastVerb = r.verb;
    }
  }
  return out;
}

/** Read the verb at the head of a clause: [meaning, words consumed]. */
function readVerb(ws: readonly string[]): [string, number] | null {
  if (ws.length >= 2) {
    const two = `${ws[0]} ${ws[1]}`;
    for (const [p, v] of VERBS2) if (p === two) return [v, 2];
  }
  const v = VERBS1[ws[0]];
  return v ? [v, 1] : null;
}

/** The count at `at`, if there is one: [value, next index]. */
function readCount(ws: readonly string[], at: number): [number, number] {
  const n = NUMBERS[ws[at] ?? ""];
  return n === undefined ? [1, at] : [n, at + 1];
}

/** The region and the pick a target phrase carries anywhere in it ("another gold mine on the
 *  right side of the map": pick next, region x +1). */
function readModifiers(ws: readonly string[], from: number): { region?: Region; pick?: Pick } {
  let region: Region | undefined;
  let pick: Pick | undefined;
  for (let i = from; i < ws.length; i++) {
    const r = REGION_WORDS[ws[i]];
    if (r) {
      region ??= { x: null, y: null };
      if (r.x !== undefined && !(r.x === 0 && region.x !== null)) region.x = r.x;
      if (r.y !== undefined && !(r.y === 0 && region.y !== null)) region.y = r.y;
    }
    if (NEXT_WORDS.has(ws[i])) pick = "next";
    else if (NEAREST_WORDS.has(ws[i]) && !pick) pick = "nearest";
  }
  return { region, pick };
}

/** Read a target phrase out of `ws` from `at` on. Prepositions, "the" and the modifier words
 *  are skipped, and the modifiers are read off the whole rest of the clause. */
export function readTarget(ws: readonly string[], at: number, lex: Lexicon): VoiceTarget | undefined {
  let i = at;
  let side: Side = "any";
  const mods = readModifiers(ws, at);
  const skippable = (w: string): boolean =>
    PREPOSITIONS.has(w) || FILLER.has(w) || w === "a" || w === "an" || NEXT_WORDS.has(w) || NEAREST_WORDS.has(w) ||
    w === "camera" || w === "back" || w === "over" || w === "up" || w === "view";
  // A camp's COLOUR on the minimap ("a green camp", "the red creeps"), said before the camp.
  const tierAt = (j: number): "green" | "orange" | "red" | undefined =>
    ws[j] === "green" || ws[j] === "easy" ? "green" : ws[j] === "orange" || ws[j] === "yellow" || ws[j] === "medium" ? "orange" : ws[j] === "red" || ws[j] === "hard" ? "red" : undefined;
  while (i < ws.length && skippable(ws[i])) i++;
  if (i >= ws.length) return undefined;
  if (CURSOR_WORDS.has(ws[i])) return { kind: "cursor" };
  if (SCREEN_WORDS.has(ws[i])) return { kind: "screen" };
  if (ENEMY_WORDS.has(ws[i])) { side = "enemy"; i++; }
  else if (MINE_WORDS.has(ws[i]) && ws[i] !== "mine") { side = "mine"; i++; }
  else if (ALLY_WORDS.has(ws[i])) { side = "ally"; i++; }
  while (i < ws.length && skippable(ws[i])) i++;
  const w = ws[i];
  if (w === undefined) return side === "enemy" ? { kind: "base", side, ...mods } : undefined;
  const s = stem(w);
  if (s === "hero") return { kind: "hero", side, ...mods };
  if (s === "base" || s === "home" || (s === "town" && ws[i + 1] === "hall")) return { kind: "base", side: side === "any" ? "mine" : side, ...mods };
  if ((s === "gold" && (ws[i + 1] === "mine" || ws[i + 1] === undefined)) || (s === "mine" && side === "any")) return { kind: "mine", ...mods };
  if (s === "tree" || s === "forest" || s === "wood" || s === "lumber") return { kind: "trees" };
  if (s === "army") return { kind: "army" };
  {
    // "a green camp", "the red creeps", "an orange creep camp"
    const tier = tierAt(i);
    const next = stem(ws[i + 1] ?? "");
    if (tier && (next === "camp" || next === "creep")) return { kind: "creeps", tier, ...mods };
  }
  if (s === "creep" || s === "camp" || (s === "neutral" && stem(ws[i + 1] ?? "") === "camp")) return { kind: "creeps", ...mods };
  const m = lex.match(ws, i, ["unit", "building", "hero"]);
  if (m) return { kind: "unit", entry: m.entry, side, ...mods };
  // Nothing but a part of the map: "the top left", "the middle of the map".
  if (mods.region) return { kind: "region", region: mods.region };
  return undefined;
}

/** The console's panels by what players call them. */
const PANELS: Array<[RegExp, "quests" | "menu" | "allies" | "chat"]> = [
  [/\b(quests?|quest log|objectives?|missions?)\b/, "quests"],
  [/\b(menu|game menu|pause menu|main menu|options|escape menu)\b/, "menu"],
  [/\b(allies|alliance|alliances|diplomacy|ally menu|ally panel)\b/, "allies"],
  [/\b(message log|chat log|log|chat panel|chat history|messages)\b/, "chat"],
];

/**
 * A CHAT line: "say good game", "tell allies push mid", "type gg to all", "send message attack
 * now to everyone", or "chat" / "open chat" alone for the input. The message is the rest of the
 * sentence as said — the recogniser's free half fills it in (src/voice/control.ts) — less the
 * words that say WHO it is for ("to all", "to allies", "all chat", "team").
 */
export function parseChat(ws: readonly string[]): VoiceIntent | null {
  let i = 0;
  if (ws[0] === "send" && /^(message|msg|text|chat)$/.test(ws[1] ?? "")) i = 2;
  else if (ws[0] === "send" && ws[1] === "a" && /^(message|msg|text|chat)$/.test(ws[2] ?? "")) i = 3;
  else if (/^(say|tell|type|write|chat|message)$/.test(ws[0] ?? "")) i = 1;
  else if (/^(open|start)$/.test(ws[0] ?? "") && ws[ws.length - 1] === "chat" && ws.length <= 3) return { kind: "chat", text: "", scope: null };
  else return null;
  const rest = ws.slice(i);
  let scope: "all" | "allies" | null = null;
  const take = (n: number, sc: "all" | "allies", at: number): void => { rest.splice(at, n); scope = sc; };
  const tail = rest.join(" ");
  // Who, at the end ("… to all") or at the start ("tell allies …", "all chat …").
  if (/ (to|for) (all|everyone|everybody|every one)$/.test(` ${tail}`)) take(2, "all", rest.length - 2);
  else if (/ (to|for) (allies|ally|team|my team|teammates|the team)$/.test(` ${tail}`)) take(rest[rest.length - 2] === "my" || rest[rest.length - 2] === "the" ? 3 : 2, "allies", rest.length - (rest[rest.length - 2] === "my" || rest[rest.length - 2] === "the" ? 3 : 2));
  else if (/^(all|everyone|everybody)\b/.test(tail)) take(rest[1] === "chat" ? 2 : 1, "all", 0);
  else if (/^(allies|team|ally)\b/.test(tail)) take(rest[1] === "chat" ? 2 : 1, "allies", 0);
  return { kind: "chat", text: rest.join(" ").trim(), scope };
}

function parseClause(ws: string[], ctx: ParseContext, inherited: string | null): { intent: VoiceIntent; verb: string } | null {
  const lex = ctx.lexicon;
  // A chat line is not a command at all: everything after the verb is the message.
  const chat = parseChat(ws);
  if (chat) return { intent: chat, verb: "chat" };
  // The console's panels: "open the quest log", "close the menu", "show allies", "menu".
  const text = ws.join(" ");
  const opener = /^(open|show|toggle|bring|display|view|check|go)\b/.test(text) ? true : /^(close|hide|exit|leave|dismiss)\b/.test(text) ? false : undefined;
  if (opener !== undefined || ws.length <= 3) {
    for (const [re, panel] of PANELS) {
      if (!re.test(text)) continue;
      if (opener === undefined && ws.length > 2) break;
      return { intent: { kind: "panel", panel, open: opener === undefined ? null : opener }, verb: "panel" };
    }
  }
  // "pause the game", "pause", "unpause", "resume the game".
  if (/^(pause)( the)?( game)?$/.test(text)) return { intent: { kind: "pause", on: true }, verb: "pause" };
  if (/^(unpause|resume|continue)( the)? game$|^unpause$/.test(text)) return { intent: { kind: "pause", on: false }, verb: "pause" };
  // "move the camera to another gold mine", "take the camera to my base", "camera top left":
  // a clause that names the CAMERA is about the camera, whichever verb it opens with — "move"
  // above all, which would otherwise order the army there.
  const cam = ws.indexOf("camera");
  if (cam >= 0) {
    // "move the camera up", "pan the camera left a bit": a step from where it looks now.
    const dir = readDirection(ws, cam + 1);
    if (dir) return { intent: { kind: "camera", target: { kind: "step", dx: dir.dx, dy: dir.dy, scale: dir.scale } }, verb: "camera" };
    const t = readTarget(ws, cam + 1, lex);
    return t ? { intent: { kind: "camera", target: t }, verb: "camera" } : null;
  }
  // "go north", "go up and left": "go" is filler everywhere else ("go ahead"), a MOVE here.
  if (ws[0] === "go" && DIRECTION_WORDS[ws[1] ?? ""]) ws = ["move", ...ws.slice(1)];
  const head = readVerb(ws);
  const verb = head?.[0] ?? null;
  let i = head?.[1] ?? 0;
  const rest = (): VoiceTarget | undefined => readTarget(ws, i, lex);
  const done = (intent: VoiceIntent, v: string = verb ?? inherited ?? ""): { intent: VoiceIntent; verb: string } => ({ intent, verb: v });

  switch (verb) {
    case "rally":
      return done(readRally(ws, i, lex), "rally");
    case "move": case "attack": case "attackmove": case "patrol": case "attackground": case "smart": {
      // "move two footmen here", "attack with all footmen" — a subject may follow the verb.
      while (ws[i] === "with") i++;
      const sub = readSubject(ws, i, lex, false);
      if (sub && (sub.subject.counted || sub.subject.worker || sub.plural)) i = sub.end;
      const subject = sub && i === sub.end ? sub.subject : undefined;
      // "move up", "attack move north west", "move left a bit".
      const dir = readDirection(ws, i);
      if (dir) return done({ kind: "order", order: verb, target: { kind: "step", dx: dir.dx, dy: dir.dy, scale: dir.scale }, subject });
      return done({ kind: "order", order: verb, target: rest(), subject });
    }
    case "follow": {
      // "follow the archmage", "follow my hero": a MOVE onto a friendly unit, which is a follow.
      const t = rest();
      return t ? done({ kind: "order", order: "smart", target: t }, "smart") : null;
    }
    case "put": {
      // The rally point: "put the rally point of the barracks on my hero".
      const r = ws.indexOf("rally");
      if (r >= 0) return done(readRally(ws, ws[r + 1] === "point" ? r + 2 : r + 1, lex), "rally");
      // A building: "put a farm here".
      let j = i;
      while (ws[j] === "a" || ws[j] === "an" || ws[j] === "the") j++;
      const b = lex.match(ws, j, ["building"]);
      if (b) { i = b.end; return done({ kind: "build", entry: b.entry, target: rest() }, "build"); }
      // Somebody, somewhere: "put all peasants on gold", "send two footmen there".
      const sub = readSubject(ws, i, lex, false);
      if (sub) i = sub.end;
      const res = resourceAhead(ws, i);
      if (res) return done({ kind: "harvest", res, subject: sub?.subject }, "harvest");
      const t = rest();
      return t || sub ? done({ kind: "order", order: "move", target: t, subject: sub?.subject }, "move") : null;
    }
    case "retreat": return done({ kind: "retreat", target: rest() });
    case "teleport": {
      // "tp out", "teleport back to the base", "tp out of there": the Town Portal, aimed at a
      // town hall of ours — the one said, else the main one (game/voiceActions.ts).
      const tp = lex.match(["tp"], 0, ["item"]) ?? lex.match(["town", "portal"], 0, ["item"]);
      // "Out of THERE" is where the army is leaving, not where it is going: only a named place
      // (a base, a unit) aims it.
      const t = rest();
      const to = t && t.kind !== "screen" && t.kind !== "cursor" ? t : undefined;
      return done({ kind: "useitem", entry: tp?.entry ?? { kind: "item", id: "stwp", phrase: "Scroll of Town Portal" }, target: to }, "press");
    }
    case "stop": return done({ kind: "stop" });
    case "hold": return done({ kind: "hold" });
    case "cancel": return done({ kind: "cancel" });
    case "gold": return done({ kind: "harvest", res: "gold", target: rest() });
    case "lumber": return done({ kind: "harvest", res: "lumber", target: rest() });
    case "harvest": {
      const sub = readSubject(ws, i, lex, false);
      if (sub) {
        const res = resourceAhead(ws, sub.end);
        if (res) return done({ kind: "harvest", res, subject: sub.subject });
      }
      const t = rest();
      const res = t?.kind === "mine" ? "gold" : t?.kind === "trees" ? "lumber" : ws.slice(i).some((w) => w === "gold") ? "gold" : undefined;
      return done({ kind: "harvest", res, target: t });
    }
    case "army": return done({ kind: "select", what: "army" });
    case "idle": return done({ kind: "select", what: "idle" });
    case "group": case "assign": case "add": {
      while (ws[i] === "group" || ws[i] === "to") i++;
      const n = NUMBERS[ws[i] ?? ""];
      if (n === undefined || n > 10) return null;
      return done({ kind: "group", n: n === 10 ? 0 : n, mode: verb === "group" ? "recall" : verb === "assign" ? "assign" : "add" });
    }
    case "camera": {
      const t = rest();
      return t ? done({ kind: "camera", target: t }) : null;
    }
    case "select": {
      while (i < ws.length && (FILLER.has(ws[i]) || MINE_WORDS.has(ws[i]))) i++;
      const w = ws[i];
      // "select army", "select all", "select everyone" — the "-" key's army.
      if (w === undefined || w === "army" || ((ALL_WORDS.has(w)) && (ws[i + 1] === undefined || ws[i + 1] === "army" || ws[i + 1] === "units"))) {
        return done({ kind: "select", what: "army" });
      }
      if (stem(w) === "hero") {
        const n = NUMBERS[ws[i + 1] ?? ""];
        return done({ kind: "select", what: "hero", index: n ? n - 1 : 0 });
      }
      const sub = readSubject(ws, i, lex, true);
      return sub ? done({ kind: "select", what: "subject", subject: sub.subject }) : null;
    }
    case "train": {
      while (ws[i] === "the") i++;
      const [count, j] = readCount(ws, i);
      i = j;
      const m = lex.match(ws, i, ["unit", "hero"]);
      if (m) return done({ kind: "train", entry: m.entry, count: Math.max(1, Math.min(count, 12)) });
      // "make a farm": the player said make, the game calls it build.
      const b = lex.match(ws, i, ["building"]);
      if (b) { i = b.end; return done({ kind: "build", entry: b.entry, target: rest() }, "build"); }
      return pressByName(ws, i, lex, done);
    }
    case "build": {
      while (ws[i] === "a" || ws[i] === "an") i++;
      const b = lex.match(ws, i, ["building"]);
      if (b) { i = b.end; return done({ kind: "build", entry: b.entry, target: rest() }); }
      // "build three footmen" — said build, meant train.
      const [count, j] = readCount(ws, i);
      const u = lex.match(ws, j, ["unit", "hero"]);
      if (u) return done({ kind: "train", entry: u.entry, count }, "train");
      return null;
    }
    case "finish": {
      // "finish the altar", "finish building the farm", "complete all buildings", "resume construction".
      let all = false;
      while (i < ws.length && (FILLER.has(ws[i]) || MINE_WORDS.has(ws[i]) || ALL_WORDS.has(ws[i]) || ws[i] === "building" || ws[i] === "constructing" || ws[i] === "construction" || ws[i] === "a")) {
        if (ALL_WORDS.has(ws[i])) all = true;
        i++;
      }
      const b = lex.match(ws, i, ["building"]);
      return done({ kind: "finish", entry: b?.entry, all });
    }
    case "research": {
      const m = lex.match(ws, i, ["upgrade", "button"]);
      return m ? done({ kind: "research", entry: m.entry }) : null;
    }
    case "learn": {
      const m = lex.match(ws, i, ["ability", "button"]);
      return m ? done({ kind: "learn", entry: m.entry }) : null;
    }
    case "auto-on": case "auto-off": case "autocast": {
      let on = verb !== "auto-off";
      const m = lex.match(ws, i, ["ability", "button"]);
      if (!m) return null;
      if (ws[m.end] === "off") on = false;
      return done({ kind: "autocast", entry: m.entry, on });
    }
    case "press": {
      // "use slot two" / "use item one" — the inventory by number.
      if (ws[i] === "item" || ws[i] === "slot") {
        const n = NUMBERS[ws[i + 1] ?? ""];
        if (n !== undefined && n >= 1 && n <= 6) { i += 2; return done({ kind: "useitem", slot: n - 1, target: rest() }); }
      }
      return pressByName(ws, i, lex, done);
    }
    default:
      break;
  }

  // No verb of its own. A clause after "and" carries the previous one on ("select footmen and
  // riflemen", "train two footmen and a priest").
  if (inherited === "select" || inherited === "train") {
    const kinds: LexEntry["kind"][] = ["unit", "hero", "building"];
    const [count, j] = inherited === "train" ? readCount(ws, 0) : [1, 0];
    const m = lex.match(ws, j, kinds);
    if (m) {
      if (inherited === "train") return done({ kind: "train", entry: m.entry, count }, inherited);
    }
    if (inherited === "select") {
      const sub = readSubject(ws, 0, lex, true);
      if (sub) return done({ kind: "select", what: "subject", subject: sub.subject }, inherited);
    }
  }
  // A SUBJECT first: "all peasants on gold", "two peasants to wood", "footmen attack move here".
  const sub = readSubject(ws, 0, lex, false);
  if (sub && (sub.subject.counted || sub.subject.worker || sub.plural)) {
    const res = resourceAhead(ws, sub.end);
    if (res) return done({ kind: "harvest", res, subject: sub.subject }, "harvest");
    const after = parseClause(ws.slice(sub.end), ctx, null);
    if (after && (after.intent.kind === "order" || after.intent.kind === "harvest")) {
      after.intent.subject ??= sub.subject;
      return after;
    }
  }
  // …and otherwise it is a BUTTON's name: "storm bolt the hero", "blizzard here", "footman".
  return pressByName(ws, 0, lex, done);
}

/**
 * Read a SUBJECT — who an order is for — from `at`: [all | a count] [idle] (worker word | unit
 * name) [from gold | wood]. `allowFrom` reads the trailing resource as a FILTER ("select one
 * worker from wood"); without it the resource is left for the verb ("put all peasants ON GOLD"
 * is a destination). `plural` says the name was said in the plural ("peasants").
 */
export function readSubject(
  ws: readonly string[],
  at: number,
  lex: Lexicon,
  allowFrom: boolean,
): { subject: Subject; end: number; plural: boolean } | null {
  let i = at;
  let count: number | "all" | undefined;
  let idle = false;
  const skip = (): void => { while (ws[i] === "the" || ws[i] === "my" || ws[i] === "our" || ws[i] === "of") i++; };
  skip();
  // "A"/"an" is the singular, not a count: "select a peasant" means the same as "select
  // peasant" — an idle one — and only a NUMBER ("one peasant") means any one.
  if (ws[i] === "a" || ws[i] === "an") i++;
  else if (ALL_WORDS.has(ws[i] ?? "")) { count = "all"; i++; }
  else if (ws[i] !== undefined && !NOT_COUNTS.has(ws[i]) && NUMBERS[ws[i]] !== undefined) { count = NUMBERS[ws[i]]; i++; }
  skip();
  if (ws[i] === "idle" || ws[i] === "lazy" || ws[i] === "free") { idle = true; i++; }
  let entry: LexEntry | undefined;
  let worker = false;
  let plural = false;
  const w = ws[i];
  if (w === undefined) return null;
  if (WORKER_WORDS.has(w)) {
    worker = true;
    plural = stem(w) !== w;
    i++;
  } else {
    // SELECTING may name a building ("select altar", "select my main building"); an order's
    // subject is somebody who walks.
    const m = lex.match(ws, i, allowFrom ? ["unit", "hero", "building"] : ["unit", "hero"]);
    if (!m) return null;
    entry = m.entry;
    const last = ws[m.end - 1];
    plural = stem(last) !== last;
    i = m.end;
  }
  // "fiend 4", "fiend number four", "footman #2": the number on its voice label. The homophones a
  // count refuses ("to", "for") are numbers here only at the end of the sentence, where no
  // preposition can follow.
  let index: number | undefined;
  {
    let j = i;
    if (ws[j] === "number" || ws[j] === "no" || ws[j] === "num") j++;
    const n = ws[j] !== undefined && ws[j] !== "a" && ws[j] !== "an" && (!NOT_COUNTS.has(ws[j]) || j === ws.length - 1) ? NUMBERS[ws[j]] : undefined;
    if (n !== undefined && n >= 1) { index = n; i = j + 1; plural = false; }
  }
  let from: "gold" | "lumber" | undefined;
  if (allowFrom) {
    let j = i;
    while (j < ws.length && FROM_WORDS.has(ws[j])) j++;
    if (j > i || j === i) {
      if (GOLD_WORDS.has(ws[j] ?? "") || (ws[j] === "gold" && ws[j + 1] === "mine")) from = "gold";
      else if (LUMBER_WORDS.has(ws[j] ?? "")) from = "lumber";
      if (from) i = j + 1 + (ws[j + 1] === "mine" ? 1 : 0);
    }
  }
  return {
    subject: { entry, worker, count: count ?? (plural ? "all" : 1), counted: count !== undefined, idle, from, index },
    end: i,
    plural,
  };
}

/** A resource named anywhere after `at` ("on gold", "to the gold mine", "chop wood"). */
function resourceAhead(ws: readonly string[], at: number): "gold" | "lumber" | undefined {
  for (let i = at; i < ws.length; i++) {
    if (ws[i] === "gold" || ws[i] === "mine" || ws[i] === "mines" || ws[i] === "mining") return "gold";
    if (LUMBER_WORDS.has(ws[i]) || ws[i] === "chop" || ws[i] === "chopping") return "lumber";
  }
  return undefined;
}

/** The rest of a rally clause, after "rally (point)": [of | for] [the] <building> <target>.
 *  Without a building it is the selected building's rally. */
function readRally(ws: readonly string[], at: number, lex: Lexicon): VoiceIntent {
  let i = at;
  while (ws[i] === "point" || ws[i] === "of" || ws[i] === "for" || ws[i] === "from" || ws[i] === "the" || ws[i] === "my" || ws[i] === "our") i++;
  const b = lex.match(ws, i, ["building"]);
  if (b) i = b.end;
  return { kind: "order", order: "rally", target: readTarget(ws, i, lex), source: b?.entry };
}

function pressByName(
  ws: readonly string[],
  at: number,
  lex: Lexicon,
  done: (intent: VoiceIntent, v?: string) => { intent: VoiceIntent; verb: string },
): { intent: VoiceIntent; verb: string } | null {
  let i = at;
  while (i < ws.length && FILLER.has(ws[i])) i++;
  const m = lex.match(ws, i, ["button", "ability", "item"]);
  if (!m) return null;
  const target = readTarget(ws, m.end, lex);
  if (m.entry.kind === "item") return done({ kind: "useitem", entry: m.entry, target }, "press");
  return done({ kind: "press", entry: m.entry, target }, "press");
}

/** A one-line reading of an intent, for the echo the player sees ("Train 3 × Footman"). */
export function describe(i: VoiceIntent): string {
  const t = (x?: VoiceTarget): string => {
    if (!x) return "";
    switch (x.kind) {
      case "screen": return " → here";
      case "cursor": return " → cursor";
      case "region": return ` → ${regionWords(x.region)}`;
      case "step": return ` → ${[x.dy > 0 ? "north" : x.dy < 0 ? "south" : "", x.dx > 0 ? "east" : x.dx < 0 ? "west" : ""].join("")}${x.scale < 1 ? " a bit" : x.scale > 1 ? " far" : ""}`;
      case "unit": return ` → ${x.side === "enemy" ? "enemy " : x.side === "mine" ? "my " : ""}${x.entry.phrase}`;
      case "hero": return ` → ${x.side === "enemy" ? "enemy " : x.side === "mine" ? "my " : ""}hero`;
      case "base": return ` → ${x.side === "enemy" ? "enemy" : "my"} base`;
      case "mine": return ` → ${x.pick === "next" ? "another " : ""}gold mine${x.region ? ` (${regionWords(x.region)})` : ""}`;
      case "trees": return " → trees";
      case "army": return " → army";
      case "creeps": return ` → ${x.pick === "next" ? "another " : ""}${x.tier ? `${x.tier} ` : ""}creep camp${x.region ? ` (${regionWords(x.region)})` : ""}`;
    }
  };
  switch (i.kind) {
    case "order": return `${i.subject ? `${who(i.subject)}: ` : ""}${i.source ? `${i.source.phrase} ` : ""}${{ move: "Move", attack: "Attack", attackmove: "Attack-move", patrol: "Patrol", attackground: "Attack ground", rally: "Rally", smart: "Follow" }[i.order]}${t(i.target)}`;
    case "retreat": return `Fall back${t(i.target) || " → home"}`;
    case "stop": return "Stop";
    case "hold": return "Hold position";
    case "cancel": return "Cancel";
    case "harvest": return `${i.subject ? `${who(i.subject)}: ` : ""}Gather${i.res ? ` ${i.res}` : ""}${t(i.target)}`;
    case "train": return `Train ${i.count > 1 ? `${i.count} × ` : ""}${i.entry.phrase}`;
    case "build": return `Build ${i.entry.phrase}${t(i.target)}`;
    case "finish": return `Finish ${i.entry?.phrase ?? (i.all ? "all buildings" : "building")}`;
    case "research": return `Research ${i.entry.phrase}`;
    case "learn": return `Learn ${i.entry.phrase}`;
    case "press": return `${i.entry.phrase}${t(i.target)}`;
    case "autocast": return `Autocast ${i.entry.phrase} ${i.on ? "on" : "off"}`;
    case "useitem": return `Use ${i.entry?.phrase ?? `item ${(i.slot ?? 0) + 1}`}${t(i.target)}`;
    case "select": return i.what === "army" ? "Select army" : i.what === "idle" ? "Select idle worker" : i.what === "hero" ? `Select hero ${(i.index ?? 0) + 1}` : `Select ${who(i.subject)}`;
    case "group": return `${i.mode === "recall" ? "Group" : i.mode === "assign" ? "Assign group" : "Add to group"} ${i.n}`;
    case "camera": return `Camera${t(i.target)}`;
    case "panel": return `${i.open === false ? "Close" : "Open"} ${i.panel}`;
    case "pause": return i.on ? "Pause" : "Unpause";
    case "chat": return i.text ? `Chat${i.scope ? ` (${i.scope})` : ""}: ${i.text}` : "Open chat";
  }
}

function regionWords(r: Region): string {
  const y = r.y === 1 ? "top" : r.y === -1 ? "bottom" : r.y === 0 ? "middle" : "";
  const x = r.x === 1 ? "right" : r.x === -1 ? "left" : r.x === 0 && r.y !== 0 ? "middle" : "";
  return [y, x].filter(Boolean).join(" ") || "map";
}

/** A subject in words: "all Peasants", "1 idle worker", "1 worker from lumber". */
function who(sub?: Subject): string {
  if (!sub) return "";
  const name = sub.worker ? "worker" : sub.entry?.phrase ?? "unit";
  if (sub.index !== undefined) return `${name} ${sub.index}`;
  const n = sub.count === "all" ? "all" : String(sub.count);
  return `${n}${sub.idle ? " idle" : ""} ${name}${sub.from ? ` from ${sub.from}` : ""}`;
}
