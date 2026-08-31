// Computer+ — talking to its ALLIES, and hearing them (team games: 2v2, 3v3, 4v4, FFA teams).
//
// plus/chatter.ts is the manners file: glhf at the start, gg at the end, both said to everyone
// because that is who they are for. This is the other half — the running commentary a team game
// actually consists of, said on the ALLIES channel and only ever when there is somebody on it
// (`hasChatAllies`'s question, asked of the alliance matrix rather than of team numbers: a
// one-way passive grant is not an ally, see src/game/chat.ts).
//
// Four things happen here, and all four go through the ORDINARY chat path — `PlusHost.say` →
// `RtsController.onChatSaid` → `MapViewerScene.deliverChat` — so a computer's "omw" is routed,
// tagged `[Allies]`, coloured, logged and relayed to LAN clients exactly like a typed one, and a
// map with a chat trigger on it sees it the same way. There is no second channel, and there is
// no back door: what a computer hears is what `chatRecipients` decided it hears, so it cannot
// read a message that was not addressed to it any more than it can see through the fog.
//
//  1. **It states its build**, once, near the top of the game — "i'm going footmen and
//     riflemen". Off the STRATEGY it rolled at seat time (plus/races.ts), so it is a plan rather
//     than a report of what it has already made.
//  2. **It says when that changes.** Not a strategy SWITCH — Computer+ plays the one build for
//     the whole match — but the thing a player actually announces: what the top of its
//     production mix has just become, and whether the enemy's composition is why
//     (plus/counter.ts). "switching to knights", "going hippogryphs to counter their air units".
//  3. **It asks for help** when more than one opponent is in its towns at once, or when ONE of
//     them is overrunning it — see `OVERRUN_EDGE`.
//  4. **It answers a call for help** — its ally's or another computer's, since both arrive by
//     the same route. It comes on foot, or by Scroll of Town Portal when the walk is too long to
//     matter, and it says so if it cannot come at all.
//  5. **It says who it is about to hit** — "im going to hit blue" — when the wave sets off at a
//     PLAYER, naming them by the colour both players can see on the minimap (`COLOUR_NAMES`).
//  6. **It answers that** with "im coming with you", and then actually comes: the promise is
//     kept by committing its own wave to the same player. An ally that is not interested says
//     NOTHING, which is the ordinary answer to an attack call and keeps the channel readable.
//
// What is NOT here: SCOUTING INTELLIGENCE, which is the other half of playing as a team and is
// not chat at all — a sighting one Computer+ player makes is written into every allied Computer+
// player's `EnemyMemory` as it is made, so the team scouts once. It lives at the sighting
// instead, in `ComputerPlusAi.scoutEnemy` / `teammates`.
//
// The vocabulary is ladder shorthand and the speaker is anonymous, which is issue #124's rule
// for chatter.ts restated: no personalities, no names, no jokes. Every line is lowercase for the
// same reason the greetings are — that is how this is typed in a real game.

/**
 * What a heard line is asking for.
 *
 * Two of them move an army — `help` (come to my base) and `attack` (I am hitting that player,
 * come with me if you like). The other three are recognised so a computer does not read another
 * computer's ANSWER as a fresh request and answer the answer: `coming` and `joining` are the two
 * answers, `busy` is the decline.
 */
export type AllyCall = "help" | "coming" | "busy" | "attack" | "joining";

/**
 * What an ally just said, or null for anything this AI has no reading of.
 *
 * Caps-agnostic and punctuation-agnostic by construction: the text is folded to lowercase and
 * every non-letter becomes a space before anything is matched, so "HELP!!", "Help me.",
 * "help   me" and "help-me" are one message. Matching is on WORDS (`\b`), which is what keeps
 * "helped", "helping" and "helpful" out of it without a list of exceptions.
 *
 * Ordering matters, and every step of it is a line this file itself says being kept out of the
 * reading below it. The ANSWERS come first — `joining` before `coming`, because "im coming with
 * you" contains "coming"; then the DECLINES, because every one of them contains the word a
 * request is recognised by ("i can't help right now" is not a request for help); then the attack
 * announcement, which is additionally gated on a colour; and only then `help`. A computer that
 * read its own vocabulary as a call would answer itself for the rest of the match.
 */
export function readAllyCall(text: string): AllyCall | null {
  const said = ` ${text.toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
  if (!said.trim()) return null;
  if (JOINING.some((re) => re.test(said))) return "joining";
  if (COMING.some((re) => re.test(said))) return "coming";
  if (BUSY.some((re) => re.test(said))) return "busy";
  // …and the ATTACK announcement, which is the one reading that also needs a COLOUR (see
  // `ATTACK` for why that is a condition rather than a detail).
  if (namedColour(said) >= 0 && ATTACK.some((re) => re.test(said))) return "attack";
  if (HELP.some((re) => re.test(said))) return "help";
  return null;
}

/**
 * "I am coming WITH you" — the answer to an attack announcement rather than to a call for help,
 * and tested before `COMING` for exactly that reason: every line in `JOIN_LINES` contains the
 * word "coming", so without this a computer that said "im coming with you" would be heard by the
 * third teammate as somebody answering a call for help that nobody made.
 */
const JOINING: readonly RegExp[] = [
  /\b(coming|come|going|go|rolling|roll) with (you|u|ya)\b/,
  /\b(ill|i ll|i will|im|i m) (join|joining|coming|going) (you|with you|in with you)\b/,
  /\bcount me in\b/,
];

/**
 * "I am hitting that player."
 *
 * Gated on a COLOUR being named as well, in `readAllyCall`, and that gate is what keeps this
 * clause from eating the file's own calls for help: "i'm under attack from multiple sides, need
 * help" is one of `HELP_CALLS` and contains the word this is recognised by. A request for help
 * names no colour; an announcement always does, because naming who is the whole point of it.
 */
const ATTACK: readonly RegExp[] = [
  /\b(attack|attacking|hit|hitting|kill|killing|push|pushing|going in|rush|rushing)\b/,
];

/**
 * "I am on my way" in the forms a player types it. Tested BEFORE the request patterns — see
 * `readAllyCall` — which is also why "coming to help" lands here rather than as a call.
 *
 * `i m` sits beside `im` in every pattern in this file for the same reason `can t` does: the
 * fold turned the apostrophe into a space, so "I'm" and "im" arrive here differently.
 */
const COMING: readonly RegExp[] = [
  /\bomw\b/, /\bon my way\b/, /\bcoming\b/, /\b(im|i m) there\b/, /\btping\b/, /\btp ing\b/,
];

/** "I can't." Negations first, for the reason in `readAllyCall`: they all contain "help" or
 *  "come". `can t` is "can't" after the fold — see COMING. */
const BUSY: readonly RegExp[] = [
  /\b(cant|can t|cannot|wont|won t|dont|don t|not)\b[a-z ]{0,20}\b(come|coming|help|there)\b/,
  /\bno\b[a-z ]{0,6}\bhelp\b/,
  /\bbusy\b/,
];

/**
 * "Help."
 *
 * The whole point is that it is caps- and punctuation-agnostic and forgiving of how people
 * actually type under pressure — `help`, `HELP!!`, `help me`, `plz help`, `need help`, `halp`,
 * and the two calls that never use the word at all ("come here", "need backup"). It is
 * deliberately a short list: this is a computer reading chat, not a chat bot, and a wrong
 * positive marches an army across the map.
 */
const HELP: readonly RegExp[] = [
  /\b(help|halp|hlp|sos|hlep)\b/,
  /\bneed\b[a-z ]{0,10}\b(backup|assist|army|units|help)\b/,
  /\bcome\b[a-z ]{0,6}\b(here|to me|quick|now)\b/,
  /\b(im|i m|i am|am)\b[a-z ]{0,12}\b(dying|dead|losing|overrun)\b/,
];

// --- what it says ----------------------------------------------------------------------------

/** Asking. Said on the allies channel when more than one opponent is standing in our towns. */
export const HELP_CALLS = [
  "help me, i'm getting attacked by a lot",
  "need help at my base",
  "i'm under attack from multiple sides, need help",
] as const;

/** Answering, on foot. */
export const COMING_LINES = ["omw", "on my way", "coming"] as const;

/** …and answering by scroll, which is worth saying out loud: an ally who knows the reinforcement
 *  arrives in five seconds rather than in twenty plays the fight differently. */
export const PORTAL_LINES = ["coming, tping to you", "hold on, i'm tping in", "omw, tp"] as const;

/** Declining. One line per reason, because "why not" is the useful half of the answer — an ally
 *  who is told "i'm under attack too" knows nobody is coming and can run. */
export const BUSY_LINES = {
  attacked: [
    "i can't come there right now, i'm under attack too",
    "can't, they're in my base",
  ],
  fighting: [
    "i can't come there right now, i'm in a fight",
    "can't come, i'm busy",
  ],
  creeping: [
    "can't, i'm creeping",
    "i'm creeping, i can't come",
  ],
  broken: [
    "can't come, my army is dead",
    "i have nothing left to send",
  ],
  small: [
    "can't come yet, i don't have an army",
    "no army yet, sorry",
  ],
} as const;

// --- what it is building ---------------------------------------------------------------------

/**
 * "i'm going footmen and riflemen" — the BUILD, announced once, near the top of the game.
 *
 * The one line a team game actually opens with, and it is a different statement from
 * `switchLine`: that one reports what production has BECOME, this one states the plan before
 * there is any production to report. Both are worth having — an ally who knows on minute one
 * that you are going air plays the next ten minutes differently.
 *
 * Built from the strategy's own mix rather than from its `name`: a strategy's name is English
 * typed into plus/races.ts, where a unit's name is the GAME's (UnitStrings' `Name`), so this
 * says what the install says. Two units, because a mix with five entries in it announced in full
 * is a list rather than a plan — the two the build is actually about are the two heaviest.
 */
export function openerLine(unitNames: readonly string[]): string {
  const said = unitNames.filter(Boolean).map(plural);
  if (!said.length) return "";
  return `i'm going ${said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}` : said[0]}`;
}

/** How many of the strategy's units the opener names — see `openerLine`. */
export const OPENER_UNITS = 2;

/**
 * When it says it, in seconds.
 *
 * A FLOOR of fourteen seconds, and then only once EVERY seat's greeting has gone out — not just
 * this one's. The greetings are staggered per slot (`GREET_AT` + `GREET_STAGGER` × player,
 * plus/chatter.ts), so on a full map the last "glhf" lands well after the twelve seconds this
 * used to wait: the openers interleaved with the greetings and the opening of the game read as
 * one scrolling wall. `ComputerPlusAi.openerTalk` works the second half out from the seats that
 * actually exist rather than from a guess at how many there are.
 *
 * Still early enough that it is a plan rather than a report — nothing is producing at fourteen
 * seconds either.
 */
export const OPENER_AT = 14;

/** Why the top of the mix moved, which is the half of the announcement that is worth reading. */
export type SwitchReason = "air" | "counter" | null;

/**
 * "switching to knights", "going hippogryphs to counter their air units".
 *
 * `first` is the opener — the first time this computer has anything to announce at all, which
 * reads as "going X" rather than as a switch, because nothing has been switched from yet.
 */
export function switchLine(unitName: string, reason: SwitchReason, first: boolean): string {
  const what = `${first ? "going" : "switching to"} ${plural(unitName)}`;
  if (reason === "air") return `${what} to counter their air units`;
  if (reason === "counter") return `${what} to counter their army`;
  return what;
}

/**
 * A unit type's display name as a player says it in chat: lowercase and plural.
 *
 * The name itself is the GAME's (`UnitDef.name`, i.e. UnitStrings' `Name`), never typed here, so
 * a localized install and a custom map both say what they say. Only the shape is ours:
 *
 *  · "-man" → "-men", which is the only irregular the melee roster actually contains (Rifleman,
 *    Footman is "footmen", Swordsman in a custom map);
 *  · a sibilant ending takes "-es" (Huntress → huntresses);
 *  · consonant + "-y" takes "-ies" (Harpy → harpies);
 *  · and a name with "of" in it pluralizes its HEAD rather than its tail — "druids of the claw",
 *    not "druid of the claws", which is the one that reads as a machine wrote it.
 */
export function plural(name: string): string {
  const said = name.toLowerCase().trim();
  const of = said.indexOf(" of ");
  if (of > 0) return `${plural(said.slice(0, of))}${said.slice(of)}`;
  if (said.endsWith("man")) return `${said.slice(0, -3)}men`;
  if (/(s|x|z|ch|sh)$/.test(said)) return `${said}es`;
  if (/[^aeiou]y$/.test(said)) return `${said.slice(0, -1)}ies`;
  return `${said}s`;
}

// --- the clocks ------------------------------------------------------------------------------
// All ours. Nothing in the install describes a computer that talks, so — the standing rule for
// this whole directory (docs/computer-plus.md) — a number here is OURS unless it cites something.

/** Seconds between any two lines one computer says to its allies. A team game with three
 *  computers in it is three of these running at once, and the message area is small. */
export const TALK_GAP = 25;

/** …and between two calls for help. Longer: the situation that produces one lasts a while, and
 *  a computer that re-asked every time it looked would drown the channel it needs. */
export const HELP_CALL_GAP = 60;

/** How long an answered call stays answered — a second "help" from the same ally inside this is
 *  the same emergency, and the army is already walking to it. */
export const HELP_ANSWER_GAP = 30;

/**
 * Seconds between two computers ANSWERING the same call.
 *
 * One "help" is heard by every allied computer on the same frame, and without this every one of
 * them typed "omw" into the message area on that frame — three identical lines stacked on top of
 * each other, which reads as one player with a stuck key rather than as a team. It is the same
 * problem `GREET_STAGGER` solves for the greeting and it is solved the same way: the answer is
 * parked and each computer takes its turn.
 *
 * It is also the honest ORDER to answer in — the second computer decides whether to come while
 * the first one's army is already walking, which is what a team does.
 */
export const HELP_ANSWER_STAGGER = 2.5;

/**
 * How long a relief wave sticks to the job before the danger is re-checked at all.
 *
 * A grace period, and it exists because the check is made through THIS computer's eyes: an ally
 * calling from across the map is usually calling about a fight we cannot see yet, so a danger
 * test run the instant the army sets off would answer "no danger" and cancel the rescue on its
 * first step. Long enough to be most of the way there.
 */
export const HELP_GRACE = 20;

/**
 * …and how long the ally has to be OUT of danger before the rescue is called off.
 *
 * Not instant: a fight ebbs, and an army that turned around the moment the last visible enemy
 * stepped behind a tree would arrive nowhere twice. See `ComputerPlusAi.helpWave`, which is
 * where a cancelled rescue goes back to whatever the wave was doing before the call.
 */
export const HELP_CLEAR = 8;

/** How long a relief wave will keep trying before it gives up and goes home. An ally whose base
 *  fell while we were walking is an ally we cannot help, and standing in the wreckage of it is
 *  how the second base is lost too. */
export const HELP_TIMEOUT = 90;

/**
 * How far the ally has to be before the scroll is worth spending on the trip rather than walking.
 *
 * Stated as a walk, because that is what the decision is about: a Footman's `spd` is 270
 * (UnitBalance.slk), so 5400 is twenty seconds of open ground and rather more once the route
 * bends round a cliff. A fight that has been going for twenty seconds is a fight that has been
 * decided, which is exactly when a scroll is the difference and exactly what the item is for
 * (docs/items.md, and `PlusProfile.keepPortal` for who is carrying one).
 */
export const PORTAL_WALK = 5400;

/** How many distinct enemy PLAYERS have to be in our towns before it calls for help. Two: the
 *  request is "when its facing multiple opponents", and one opponent in your base is a melee
 *  game rather than an emergency. */
export const HELP_CALL_FOES = 2;

/**
 * How much better than what it last announced the new top of the mix has to be before it is
 * worth saying anything.
 *
 * Hysteresis, and it is not optional. `buildableMix` is a continuous re-weighting rather than a
 * decision (plus/plan.ts) — two rows within a few per cent of each other trade places every time
 * a producer finishes or a sighting ages out, and a computer that announced each of those would
 * be typing "switching to X" every `TALK_GAP` for the whole match. A quarter again is a real
 * change of plan; anything under it is the same plan breathing.
 */
export const SWITCH_MARGIN = 1.25;

/** …and how well the new unit has to answer what has been SEEN before the announcement says the
 *  enemy is the reason. `counterScore` is normalised so 1.0 is a plain trade (plus/counter.ts),
 *  so this is "noticeably better than an even fight" — below it the switch is the tech tree
 *  opening up, which needs no explaining to a teammate. */
export const COUNTER_TELL = 1.15;

// --- who it is hitting, and who is coming with it ---------------------------------------------

/**
 * The twelve melee player colours, by the game's OWN names for them.
 *
 * `UI\TriggerData.txt`'s `playercolor` enum — `Color00=…,PLAYER_COLOR_RED,…` through
 * `Color11=…,PLAYER_COLOR_BROWN,…` — lowercased and with the underscores opened out, which is
 * how a player types them. Nothing here is invented: red/blue/cyan/purple/yellow/orange/green/
 * pink/light gray/light blue/aqua/brown is the install's own list in the install's own order.
 *
 * A COLOUR is not a slot. `SetPlayerColor` can move one (`RtsController.playerColor`), which is
 * why the index into this list is asked of the host rather than assumed to be the seat number —
 * and it is also why the enemy is named by colour at all: a colour is what both players can see
 * on the minimap, and "hit player 4" is not something anybody says.
 */
export const COLOUR_NAMES = [
  "red", "blue", "cyan", "purple", "yellow", "orange",
  "green", "pink", "light gray", "light blue", "aqua", "brown",
] as const;

/**
 * The colour named in a line, as an index into `COLOUR_NAMES`, or -1.
 *
 * Longest match first, and that is not a tidiness rule: "light blue" contains "blue" and "light
 * gray" contains "gray", so a shortest-first scan reads every ally's call to hit light blue as a
 * call to hit blue — which is a different player, usually on a different side of the map.
 *
 * The spellings a player actually types are accepted alongside the install's ("grey" for gray,
 * "teal" for the two colours everybody calls teal), but nothing SAYS them: what goes out is
 * always `COLOUR_NAMES`, so the vocabulary this file reads and the vocabulary it writes stay one
 * list.
 */
export function namedColour(text: string): number {
  const said = ` ${text.toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
  const aliases: ReadonlyArray<readonly [string, number]> = [
    ...COLOUR_NAMES.map((c, i) => [c, i] as const),
    ["grey", 8], ["light grey", 8], ["gray", 8], ["teal", 2], ["dark green", 10],
  ];
  let best = -1;
  let bestLen = 0;
  for (const [word, index] of aliases) {
    if (word.length <= bestLen) continue;
    if (!said.includes(` ${word} `)) continue;
    best = index;
    bestLen = word.length;
  }
  return best;
}

/** "im going to hit blue." Said on the allies channel when the wave sets off at a PLAYER. */
export function attackLine(colour: string): readonly string[] {
  return [
    `im going to hit ${colour}`,
    `attacking ${colour}'s base`,
    `going in on ${colour}`,
    `im hitting ${colour} now`,
  ];
}

/**
 * "im coming with you."
 *
 * The only answer there is. An ally that is NOT interested says nothing at all — which is the
 * developer's own rule and is also how a team game reads: silence is the ordinary answer to
 * "im hitting blue", and a computer that typed "no" every time somebody attacked would be the
 * loudest thing on the channel.
 */
export const JOIN_LINES = ["im coming with you", "coming with you", "ill join you"] as const;

/** Seconds before the same wave announces a target again, so a wave that re-aims at the same
 *  player mid-push does not re-announce it. Longer than `TALK_GAP`: an attack is one event. */
export const ATTACK_TELL_GAP = 45;

/** …and between two of these computers ANSWERING one announcement, for the same reason
 *  `HELP_ANSWER_STAGGER` exists: every allied computer hears it on the same frame. */
export const JOIN_STAGGER = 2.5;

/** How long a computer that said "im coming with you" holds that objective before its own army
 *  manager is allowed to re-decide. A push across a melee map is about this long, and the point
 *  of the promise is that it is kept for the length of the trip rather than abandoned at the
 *  first thing the wave sees on the way. */
export const JOIN_TIMEOUT = 75;

/**
 * How much stronger than everything we have at home the enemy standing IN it has to be before
 * one opponent counts as OVERRUN.
 *
 * The second reason to call for help, beside `HELP_CALL_FOES`. Two opponents in your base is an
 * emergency by arithmetic; ONE opponent in your base is an ordinary melee game right up until
 * it is not, and the difference is not how many players there are — it is whether what is
 * standing in the base can answer what walked into it. Priced with plus/power.ts, the same
 * √Σ(dps × hp) the AI already uses to decide whether it can take a fight, so "overrun" means
 * the same thing here as "we would lose this" does everywhere else.
 *
 * A HALF again, rather than merely "more": a raid the defence is losing narrowly is a fight, and
 * a teammate walking across the map arrives after it. This is the bar at which the base goes.
 */
export const OVERRUN_EDGE = 1.5;

/** …and how many enemy BODIES have to be standing in the towns before the ratio is asked at all.
 *  Two, because a player with nothing at home is outweighed by any single unit that wanders in,
 *  and one Ghoul at a Ziggurat is a harasser rather than an overrun. */
export const OVERRUN_BODIES = 2;
