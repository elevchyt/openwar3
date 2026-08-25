import type { RenderUnit } from "../game/renderUnit";

// Animation RESOLUTION: which of a model's sequences a unit should be playing, and how
// fast. Pure CLIENT (docs/multiplayer.md Phase B) — a headless authority runs the same
// match without ever asking these questions, because nothing here feeds back into game
// state. Every function is a pure function of its arguments; the only mutation is
// `setAnimRate`, which writes the rate it computed onto the instance it was handed.
//
// The unit parameter is `RenderUnit`, not `SimUnit` (Phase E item 10c-2b): a client draws
// the snapshot it was SENT, so the picker has to answer the same for a `UnitSnapshot` as for
// the `SimUnit` the host holds. Typing it against the sim struct was never a requirement of
// this file — it was just what the first caller happened to have.
//
// Kept out of `rts.ts` so the sequence-name matching (which is most of the volume, and
// all of the WC3 archaeology) can be read on its own.

/** The mdx-m3-viewer bits `seqDuration` needs — an instance's model sequence list. */
export interface SeqSource {
  model: { sequences: Array<{ name: string; interval?: ArrayLike<number> }> };
}

/** What `setAnimRate` and `walkAnim` read off a render entry. The controller's `Entry`
 *  satisfies this structurally; narrowed so this file needs no render record of its own. */
export interface AnimEntry {
  unit: { instance: { timeScale: number } };
  anims: AnimSet;
  timeScale: number;
  curRate: number;
  animWalkSpeed: number;
  animRunSpeed: number;
  baseScale: number;
}

// Resolved animation-sequence indices for a unit. Worker carry/chop variants
// fall back to the base clip when a model lacks them.
export interface AnimSet {
  stand: number;
  standVariants: number[]; // all plain idle stands ("Stand"/"Stand - N"); the idle fidget cycles them
  walk: number;
  /** "Walk Fast" — the second gait a handful of models author (Kodo Beast, Pit Lord, the
   *  dragon spawns). -1 when absent, which is the overwhelmingly common case. Picked over
   *  `walk` once the unit's speed passes the midpoint of the two gaits; see walkAnim(). */
  walkFast: number;
  attack: number;
  attackVariants: number[]; // empty-handed combat-attack clips; a random one plays per swing
  attackGold: number[]; // "Attack Gold" — the swing while carrying gold (fallback: base attack)
  attackLumber: number[]; // "Attack Lumber" — the swing while carrying lumber (fallback: base attack)
  /** "Attack Slam" — the big strike a proc'd swing shows (SimUnit.swingSlam: a Critical
   *  Strike, or the blow that breaks Wind Walk). -1 when the model authors none, which is
   *  most of them — only units with a proc-on-attack passive carry one. */
  attackSlam: number;
  death: number;
  standGold: number;
  walkGold: number;
  standLumber: number;
  walkLumber: number;
  chopLumber: number; // "Attack Lumber" — the chopping swing
  /** "Stand Work" — a BUILDING's production pose (the Blacksmith hammering, the Ancient of
   *  Lore stirring). -1 when the model authors none, and that -1 is the answer rather than a
   *  gap: most structures have no work clip and simply keep standing.
   *
   *  Distinct from `build` because the OTHER form's clip must never be borrowed. The Ancients
   *  author their production pose as "Stand Work Alternate" — they train only while planted —
   *  and applyAnimProps has already renamed it to a plain "Stand Work" when the alternate
   *  props are on. So a name that still says "alternate" by the time it reaches here belongs
   *  to the form the unit is NOT in: an uprooted Ancient (whose queue is halted, not
   *  cancelled) was standing in the planted tree's working pose while it walked. */
  standWork: number;
  /** "Stand Work Gold" — a worker MINING, in place. Exactly one unit in the game authors it,
   *  and its clip list is the argument for the whole Undead economy:
   *
   *      Acolyte.mdx: Stand · Stand 2 · Walk · Attack · **Stand Work Gold** · Death · Decay …
   *
   *  There is no "Stand Gold" and no "Walk Gold" — an Acolyte never CARRIES gold, so no pose
   *  for carrying it was ever drawn — and in their place is one clip for kneeling at a mine
   *  and working it where it stands. -1 for everyone else, including the Peasant and Peon,
   *  whose mining happens out of sight inside the shaft and needs no pose at all. */
  standWorkGold: number;
  build: number; // a WORKER's hammering pose: its "Stand Work", else its attack swing
  decayFlesh: number; // corpse decay — flesh rots (heroes lack this)
  decayBone: number; // corpse decay — bones linger, then vanish
  /** "Morph" — the clip a unit plays while CHANGING form. -1 for almost everything; the
   *  Ancients author it as a pair, and which of the pair this index lands on depends on the
   *  animProps the set was built with. A form's Morph is the clip it plays to LEAVE that
   *  form: under `alternate` the renamed "Morph Alternate" is the planted Ancient hauling
   *  its roots up, and the plain set's "Morph" is the walking one settling back down. So the
   *  transition is read off the state being moved FROM (see RtsController.applyFormAnims). */
  morph: number;
  seqNames: string[]; // raw sequence names (for cast-animation tag matching)
}

// The `Animprops` tokens that select a tiered building's LOOK. A tiered structure is a single
// model carrying every tier as sequences — TownHall.mdx holds "Stand" (Town Hall), "Stand
// Upgrade First" (Keep) and "Stand Upgrade Second" (Castle); HumanTower.mdx holds the Scout,
// Guard, Cannon and Arcane towers the same way — and the unit's Animprops name its own set.
// This is the whole closed vocabulary used for tiers across the 1.27a data.
//
// `swim` is also an Animprops but is STATE, not identity (a unit plays it only in water — never
// here, water is unwalkable), so it's not handled — the pickers exclude swim clips outright
// (issue #38). `alternate`/`alternateex`, HOWEVER, when they sit in a unit's OWN static Animprops,
// name that unit's PERMANENT alternate look: the Troll Berserker (otbk, Animprops=alternate) is
// the Headhunter model's alternate animation set. So they ARE identity here, handled just like a
// tier — the picker sees the "* Alternate" clips renamed to their base action.
const TIER_PROPS = new Set(["upgrade", "first", "second", "third", "fourth", "fifth", "alternate", "alternateex"]);

/** The two props that mean "the other HALF of a two-state model" rather than "a tier". The
 *  difference matters when picking a stand: an alternate half is a COMPLETE set of poses for a
 *  form the unit is genuinely in (planted / burrowed / Avatar), so a plain clip left over from
 *  the other half is never a legitimate fallback for it. A tier's clips are not like that —
 *  Death and Decay routinely have no per-tier variant and every tier shares one. */
const STATE_PROPS = new Set(["alternate", "alternateex"]);

/** A sequence name as `applyAnimProps` hands it back: `mine` marks the clips that carried the
 *  unit's OWN tier/state props and were renamed to their base action, which is what lets a
 *  lookup tell "the form I am in" from "what is left of the other one". */
export interface PropSeq {
  name: string;
  mine?: boolean;
}

/** Rewrite the sequence names a unit is ALLOWED to see, so every lookup below can stay
 *  tier-blind: a tiered unit's own clips are renamed to their base action ("Stand Upgrade
 *  First" simply becomes the Keep's "Stand"), and clips belonging to other tiers are blanked
 *  so nothing can match them. Indices are preserved throughout — they index the live model's
 *  sequence array — and an untiered unit gets its list back untouched.
 *
 *  Three things about real WC3 sequence names make this fiddlier than it sounds, all of them
 *  visible in HumanTower.mdx (the Scout/Guard/Cannon/Arcane towers are one model):
 *
 *    "Stand Ready Attack"                 the Scout Tower — no tier tokens at all
 *    "Stand Upgrade First Ready Attack"   the Guard Tower
 *    "Attack Stand  Ready Upgrade Second" the Cannon Tower — tokens REORDERED, double space
 *    "Stand Upgrade Third Attack Ready"   the Arcane Tower — reordered again
 *    "Birth Upgrade First Second third"   ONE birth clip SHARED by all three upgraded tiers
 *
 *  So: (1) a clip is mine when my tier tokens are all present in it — a superset test, which is
 *  what lets the shared "First Second third" birth serve the Guard, Cannon and Arcane towers
 *  alike; (2) a clip with no tier tokens stays available as a fallback (Death and Decay have no
 *  per-tier variant, so every tier shares them); and (3) that fallback is blanked only when my
 *  tier has its own version of the same action — compared as an unordered SET of base tokens,
 *  because "Stand Ready Attack" and "Stand Upgrade Third Attack Ready" name the same action in
 *  a different word order, and an order-sensitive test leaves the Arcane Tower wearing the
 *  Scout Tower's model. */
export function applyAnimProps(seqs: Array<{ name: string }>, animProps: string[] = []): Array<PropSeq> {
  const tier = animProps.filter((p) => TIER_PROPS.has(p));
  if (!tier.length) return seqs;
  const BLANK = "(none)"; // matches none of the sequence patterns below
  const tokens = (n: string) => n.toLowerCase().split(/[\s\-_]+/).filter(Boolean);
  const propsOf = (n: string) => tokens(n).filter((t) => TIER_PROPS.has(t));
  const baseOf = (n: string) => tokens(n).filter((t) => !TIER_PROPS.has(t)); // original order kept
  // The ACTION a clip names, for override matching: base tokens minus the identity props AND the
  // numeric variant suffix, compared unordered. Dropping the number is what lets the alternate
  // "Stand Alternate - 1/2/3" override the plain "Stand"/"Stand - 2" (same action, different
  // numbering) — without it the Berserker kept falling back to the Headhunter's non-alt stand.
  const baseKey = (n: string) => baseOf(n).filter((t) => !/^\d+$/.test(t)).sort().join(" ");
  // A STATE prop is EXCLUSIVE, where a tier prop is inclusive, and conflating the two is the
  // Tree of Ages bug. `isMine` is a superset test — "my tokens are all present" — which is
  // exactly right for tiers: "Birth Upgrade First Second third" serves the Guard, Cannon and
  // Arcane towers at once. But a Tree of Ages walks around carrying `upgrade,first`, and
  // TreeOfLife.mdx names BOTH of its stands with the same tier tokens:
  //
  //     "Stand Upgrade First Second"            the walking form
  //     "Stand Alternate Upgrade First Second"  the planted one
  //
  // — so the superset test claimed both, both were renamed to a plain "Stand", and an uprooted
  // Tree of Ages fidgeted between its walking pose and its planted one. The two halves of a
  // two-state model are mutually exclusive by definition: a clip carrying a state prop I do
  // not have is the OTHER form's, whatever else it carries.
  const wantState = tier.filter((t) => STATE_PROPS.has(t));
  const isMine = (n: string) => {
    const p = propsOf(n);
    if (p.some((t) => STATE_PROPS.has(t) && !wantState.includes(t))) return false;
    return p.length > 0 && tier.every((t) => p.includes(t));
  };
  return seqs.map((s) => {
    if (isMine(s.name)) return { name: baseOf(s.name).join(" "), mine: true };
    if (propsOf(s.name).length) return { name: BLANK }; // some other tier's clip
    // A tier-less clip: shared (Death/Decay) unless my tier overrides this same action.
    const overridden = seqs.some((o) => isMine(o.name) && baseKey(o.name) === baseKey(s.name));
    return overridden ? { name: BLANK } : s;
  });
}

/** The animProps a unit should be RENDERED with right now — its static ones from UnitFunc,
 *  plus `alternate` while it is showing the other half of its model (SimUnit.altModel).
 *
 *  These are the cases where the alternate set is a STATE rather than an identity. For the
 *  Troll Berserker the props sit in its own UnitFunc row and never change; a rooted Ancient
 *  and a burrowed Crypt Fiend carry no Animprops at all, and it is the ABILITY that decides
 *  which half of the model they wear, moment to moment.
 *
 *  Which half is which is settled by AncientOfWar.mdx's own sequence list, and it is the
 *  reverse of the obvious guess: the PLAIN clips are the walking form ("Walk" has no alternate
 *  twin — only the uprooted Ancient walks) and the ALTERNATE ones are the planted tree, which
 *  is why the training pose is "stand work alternate" — an Ancient trains only while planted.
 *  A rooted Ancient therefore renders `alternate`, and uprooting takes the props away. Getting
 *  this backwards renders a planted Ancient in its walker pose, which is what it did before
 *  this existed (the Ancients carry NO static Animprops, so nothing chose for them).
 *
 *  Verified on the Ancient of War, and the other three growing Ancients plus the Trees follow
 *  the same naming. AncientProtector.mdx is the one I am NOT sure of: it has no "work" clip to
 *  settle it, and its alternate stand is "Stand Walk Alternate" — a name that reads like the
 *  MOBILE form, which would make its two sets the other way round. In practice the mapping
 *  barely reaches it: with no plain "* Alternate" stand to match, its rooted stand falls back
 *  to the same "Stand" it used before this function existed, so only its attack clip can be
 *  affected. Left as-is rather than special-cased on a guess; wants a look at the real client. */
export function animPropsFor(def: { animProps?: string[] } | undefined, rooted: boolean): string[] | undefined {
  if (!rooted) return def?.animProps;
  return [...(def?.animProps ?? []), "alternate"];
}

export function buildAnimSet(raw: Array<{ name: string }>, animProps: string[] = []): AnimSet {
  const seqs = applyAnimProps(raw, animProps);
  const find = (re: RegExp): number => seqs.findIndex((s) => re.test(s.name));
  const indices = (re: RegExp): number[] =>
    seqs.map((s, i) => ({ n: s.name, i })).filter(({ n }) => re.test(n)).map(({ i }) => i);
  // The "plain" idle-stand / auto-attack clips: the base name or a numbered variant
  // ("Stand", "Stand - 2", "Attack -1"), with NO trailing word. Everything with a WORD
  // after it is a context/state clip and is deliberately excluded: "* Swim" (only while
  // swimming — which never happens here, water is unwalkable; a land unit playing its swim
  // swing/idle is the bug in issue #38), "* Gold"/"* Lumber" (carry pose, chosen by carry
  // state), "Stand Ready"/"Stand Victory"/"Stand Defend"/"Stand Work" and "Attack Defend"
  // /"Attack Alternate"/"Attack Slam" (ability/stance clips, not the idle/attack loop).
  // `standVariants` is the full plain-stand set; the idle fidget cycles through it (we drive
  // that ourselves — our units are raw MdxComplexInstances, NOT mdx-m3-viewer Widgets, so its
  // Widget.update → randomStandSequence never runs). `stand` is the FIRST plain stand, the
  // canonical idle (never a swim/carry clip). Attack swings ARE randomized here (swing-driven,
  // below). Verified against real 1.27a models — Footman "Stand - 1/2/4", Peasant
  // "Stand/-2/-3/-4", Naga "Stand"+"Stand - 2" alongside its Swim/Ready variants (issue #38).
  const PLAIN_STAND = /^stand(\s*-?\s*\d+)?\s*$/i;
  const PLAIN_ATTACK = /^attack(\s*-?\s*\d+)?\s*$/i;
  /**
   * The idle stands — and, while the unit is wearing the ALTERNATE half of its model, only the
   * stands that belong to that half.
   *
   * `applyAnimProps` blanks a plain clip when the alternate half names the same action, and for
   * four of the five Ancients that is the end of it: AncientOfWar.mdx's "stand alternate"
   * overrides its "Stand - 1"/"Stand- 2" and the planted tree stands correctly. AncientProtector
   * .mdx is the exception the docs flagged and could not settle without looking: its planted
   * stand is authored **"Stand Walk Alternate"**, which no plain-stand pattern matches and whose
   * base tokens ("stand walk") match none of the four mobile "Stand"/"Stand 2-4" clips — so
   * those survived, won this lookup, and a ROOTED tower stood in its walking pose. It reads
   * exactly like a misplaced model: the walker's pose sits forward of the root patch it is
   * planted in.
   *
   * A state half is a COMPLETE set of poses for a form the unit is genuinely in, so anything
   * left over from the other half is never a legitimate stand for it — hence the fallback to
   * "any clip of MINE whose name starts with stand" before the plain ones. Tiers are
   * deliberately excluded (STATE_PROPS): a tier routinely shares clips with the base model.
   */
  const alternateForm = animProps.some((p) => STATE_PROPS.has(p));
  const plainStands = indices(PLAIN_STAND);
  const ownStands = alternateForm && !plainStands.some((i) => seqs[i].mine)
    ? indices(/^stand/i).filter((i) => seqs[i].mine)
    : [];
  const standVariants = ownStands.length ? ownStands : plainStands;
  /**
   * The SWING clips, for a model that authors no plain "Attack" at all.
   *
   * 102 of the 835 unit models in 1.27a are in that position, and picking "the first sequence
   * whose name contains attack" is wrong for the biggest group of them: the Owlbear
   * (nowb/nowe/nowk — the Wildkin, the Enraged and the Berserk), the sasquatches and the
   * furbolgs all author
   *
   *     "Attack Spell Slam" | "Attack Slam" | "Attack Slam -2"
   *
   * in that order, so the melee swing resolved to the WAR STOMP — a two-armed ground pound the
   * unit played at every blow, while its two real slams never ran. Rise of the Naga puts a
   * Berserk Wildkin in a cinematic swinging at a Watcher, which is where it shows.
   *
   * A `spell` clip is a CAST, and casts are chosen by the cast-tag matcher off `seqNames`, not
   * here. The other exclusions are the ones the carry-attack list already makes for the same
   * reason: a stance ("defend"), a state we never enter ("swim"), a carry pose ("gold"/
   * "lumber"), or another form's clip ("alternate" — already renamed or blanked by
   * applyAnimProps when the props are on, so this only catches the case where they are off).
   */
  const MELEE_ATTACK = /attack/i;
  const NOT_A_SWING = /spell|defend|swim|gold|lumber|alternate/i;
  const allSwings = indices(PLAIN_ATTACK).length
    ? indices(PLAIN_ATTACK)
    : indices(MELEE_ATTACK).filter((i) => !NOT_A_SWING.test(seqs[i].name));
  /**
   * …and while the unit wears the ALTERNATE half of its model, only that half's swings —
   * the same sentence `ownStands` is written from, for the same reason: an alternate half is
   * a COMPLETE set of poses for a form the unit is genuinely in, so anything left over from
   * the other half is never a legitimate swing for it.
   *
   * HeroGoblinAlchemist.mdx is what needs it said out loud. Its two halves name the same
   * action three and two times over —
   *
   *     "attack one alternate" | "Attack One alternate - 2" | "Attack One Alternate - 3"
   *     "attack one -1 NEW"    | "attack one - 2 NEW"
   *
   * — but that stray "NEW" is a BASE token the alternate names have not got, so
   * applyAnimProps' override test (an unordered set of base tokens, deliberately blind to the
   * numbering) could not see the pair as one action and left the walking form's two standing.
   * They then won a place in the swing pool alongside the alternate's three, and a raging
   * Alchemist threw punches with his goblin-form arms every other blow.
   */
  const attackVariants = alternateForm && allSwings.some((i) => seqs[i].mine)
    ? allSwings.filter((i) => seqs[i].mine)
    : allSwings;
  const stand = standVariants.length
    ? standVariants[0]
    : find(/^stand(\s|$|-)/i) >= 0
      ? find(/^stand(\s|$|-)/i)
      : find(/^stand/i);
  // The plain "Walk" must not match "Walk Fast" (a distinct gait, chosen by speed) — hence
  // the anchored test first, with the loose one only as a last-resort fallback.
  const walk = find(/^walk(\s*-?\s*\d+)?\s*$/i) >= 0 ? find(/^walk(\s*-?\s*\d+)?\s*$/i) : find(/^walk(?! fast)/i);
  const walkFast = find(/^walk fast/i);
  // …and if a model authors nothing but cast clips, that IS its attack: a Priest's only
  // "attack" is its "Spell Attack" (12 models, all of them casters), so the loose match stays
  // as the last resort rather than leaving them with no swing at all.
  const attack = attackVariants.length ? attackVariants[0] : find(/attack/i);
  // Carry-attack swings, chosen by the worker's carried resource (issue #35). "* Swim"
  // is excluded here too so a laden worker never swings a swim clip.
  const carryAttack = seqs
    .map((s, i) => ({ n: s.name, i }))
    .filter(({ n }) => /attack/i.test(n) && !/defend|alternate|slam|swim/i.test(n));
  const attackGold = carryAttack.filter(({ n }) => /gold/i.test(n)).map(({ i }) => i);
  const attackLumber = carryAttack.filter(({ n }) => /lumber/i.test(n)).map(({ i }) => i);
  const or = (a: number, b: number) => (a >= 0 ? a : b);
  /**
   * The work pose, matched by TOKENS rather than by the phrase "stand work".
   *
   * That distinction is the whole of it, and TreeOfLife.mdx is why: its production clip is
   * authored
   *
   *     "stand birth alternate work upgrade first second"
   *
   * — the words in an order nobody would guess, which a substring test for "stand work"
   * cannot see. So a Tree of Life training a Wisp or teching up found no work clip, the
   * picker returned -1, and the tree simply held whatever it had been playing. (The Ancients
   * spell theirs "stand work alternate" and were fine; this is the same trap
   * `applyAnimProps` already handles by comparing token SETS, for the same reason.)
   *
   * Excluded the same way the swings are: a carry variant is a worker's laden pose, and an
   * "alternate" that survived applyAnimProps belongs to the form the unit is NOT in — an
   * uprooted Ancient's queue is halted, not cancelled, so the picker still asks for a work
   * clip while it walks and must be told there is none.
   */
  const workTokens = (n: string): string[] => n.toLowerCase().split(/[\s\-_]+/).filter(Boolean);
  const standWork = seqs.findIndex((s) => {
    const t = workTokens(s.name);
    return t.includes("stand") && t.includes("work") && !t.includes("gold") && !t.includes("lumber") && !t.includes("alternate");
  });
  return {
    stand,
    standVariants: standVariants.length ? standVariants : stand >= 0 ? [stand] : [],
    walk,
    walkFast,
    attack,
    attackVariants: attackVariants.length ? attackVariants : attack >= 0 ? [attack] : [],
    attackGold,
    attackLumber,
    // Anchored, so this is the model's OWN slam and never some other tier's: the Mountain
    // King authors "Attack Slam" and "Attack Slam Alternate" (Avatar), and applyAnimProps
    // has already renamed the alternate to a bare "Attack Slam" — or blanked it — by here.
    attackSlam: find(/^attack slam\s*$/i),
    death: find(/^death/i),
    standGold: or(find(/stand gold/i), stand),
    walkGold: or(find(/walk gold/i), walk),
    standLumber: or(find(/stand lumber/i), stand),
    walkLumber: or(find(/walk lumber/i), walk),
    chopLumber: or(find(/attack lumber/i), attack),
    standWork,
    // Anchored on the whole phrase: "Stand Work Gold" is deliberately excluded from
    // `standWork` above (it is a mining pose, not a production one) and must be found here
    // instead. See the field's own note for why only the Acolyte has one.
    standWorkGold: find(/^stand work gold\s*$/i),
    // A worker with no work clip hammers with its attack swing — which is exactly what a
    // Peasant does, and why this fallback cannot be shared with `standWork` above.
    build: or(standWork, attack),
    decayFlesh: find(/decay flesh/i),
    decayBone: find(/decay bone/i),
    // Anchored: "Morph" must not pick up "Morph Alternate", which is the OTHER direction's
    // clip and is already renamed to a plain "Morph" whenever the alternate props are on.
    morph: find(/^morph(\s*-?\s*\d+)?\s*$/i),
    seqNames: seqs.map((s) => s.name),
  };
}

/** The "Birth" construction sequence + its frame interval, if the model has one. */
export function findBirthFields(
  seqs: Array<{ name: string; interval?: ArrayLike<number> }>,
  animProps: string[] = [],
): {
  birthSeq: number;
  birthStart: number;
  birthEnd: number;
} {
  // A tiered building has its OWN birth clip ("Birth Upgrade First" is the Keep rising out of
  // the Town Hall), so the construction animation has to be picked per tier too.
  const named = applyAnimProps(seqs, animProps);
  const birthSeq = named.findIndex((s) => /^birth$/i.test(s.name));
  const iv = birthSeq >= 0 ? seqs[birthSeq].interval : undefined;
  return { birthSeq, birthStart: iv ? iv[0] : 0, birthEnd: iv ? iv[1] : 0 };
}

/** Choose the animation sequence for a unit's current state, using the
 *  worker's carried resource so peasants walk/stand/chop with the right
 *  gold- and lumber-carrying clips. */
/** Apply an animation playback rate to a unit's model. WC3 re-rates the attack and walk
 *  clips from the unit's live attack/move speed; everything else (stand, cast, death,
 *  birth) plays at its authored rate. JASS SetUnitTimeScale is an INDEPENDENT override
 *  multiplied on top (TriggerStrings "Change Unit Animation Speed"), not a replacement. */
export function setAnimRate(e: AnimEntry, rate: number): void {
  const r = rate * e.timeScale;
  if (Math.abs(r - e.curRate) < 1e-3) return;
  e.curRate = r;
  e.unit.instance.timeScale = r;
}


/** The attack clip's playback rate: the unit's attack-speed factor, and nothing else. An
 *  unhasted unit swings at the rate its clip was authored at; a Bloodlusted Grunt swings
 *  40% faster and its strike lands 40% sooner, staying in phase with the damage-point-
 *  timed hit. Since attack speed divides `damagePoint`/`backswing` from their baselines
 *  by exactly that factor, the live/base ratio recovers it without the sim having to
 *  publish it.
 *
 *  It is NOT `clip length / (damagePoint + backswing)`. That pair looks like the clip's
 *  authored length on the units one checks first (Footman 0.5+0.5 = his 1000ms
 *  "Attack - 1"; Archmage 0.55+0.85 = 1400ms), but across every 1.27a model only 377 of
 *  706 plain-attack clips land within 10% of it — 265 are LONGER, so fitting them to the
 *  pair played them up to 2.5x too fast while their cooldown stayed right (Frost/Fire
 *  Treant 1.5s clips against a 0.6 pair). The giveaway is a unit whose own variants
 *  disagree: the Peasant's "Attack" is 1000ms and his "Attack -2" 1270ms under ONE
 *  dmgpt1/backSw1 pair, so no rate fitted to that pair can be right for both — the
 *  engine simply plays each at its authored length. */
export function attackAnimRate(u: RenderUnit): number {
  const w = u.swingWeapon ?? u.weapon;
  if (!w) return 1;
  const swing = w.damagePoint + w.backswing;
  const base = w.baseDamagePoint + w.baseBackswing;
  if (swing <= 0 || base <= 0) return 1; // no authored timing (a summon with no weapons row)
  return base / swing;
}


/** The walk clip and its playback rate for a unit's CURRENT move speed. `walk`/`run`
 *  (unitUI) are the speeds the model's "Walk"/"Walk Fast" clips were authored for, so the
 *  rate is simply speed/gait — which is what keeps a slowed unit's feet from skating and
 *  makes an Endurance Aura visibly quicken the stride. A model with a distinct "Walk Fast"
 *  switches to it once past the midpoint of the two gaits (Kodo Beast walk=100/run=240 →
 *  midpoint 170; at spd 220 it runs, rated 220/240 = 0.92). Scaling by `modelScale` is
 *  Warsmash's reading and physically sound — a model drawn 1.75x larger takes a 1.75x
 *  longer stride per cycle, so it must play slower to cover the same ground (the four
 *  Quillbeast tiers share one model and one 90/300 gait, differing only in modelScale) —
 *  but it is the one part of this I could not verify against the real client. */
export function walkAnim(e: AnimEntry, u: RenderUnit, seq: number): { seq: number; rate: number } {
  const { animWalkSpeed: walk, animRunSpeed: run } = e;
  if (walk <= 0) return { seq, rate: 1 }; // no gait data — leave the clip at its authored rate
  let gait = walk;
  let clip = seq;
  // Only the plain walk has a Fast variant; a laden worker's "Walk Gold"/"Walk Lumber"
  // keeps its own clip and is simply re-rated against the base gait.
  if (seq === e.anims.walk && run > walk && e.anims.walkFast >= 0 && u.speed >= (walk + run) / 2) {
    gait = run;
    clip = e.anims.walkFast;
  }
  return { seq: clip, rate: u.speed / (gait * (e.baseScale || 1)) };
}


export function pickSequence(a: AnimSet, u: RenderUnit, moving: boolean): number {
  const carry = u.worker
    ? u.worker.carryGold > 0
      ? "gold"
      : u.worker.carryLumber > 0
        ? "lumber"
        : null
    : null;
  // Movement wins over everything: a worker ordered to move mid-harvest walks
  // (with the right carry clip) instead of staying stuck in the chop pose.
  // `moving` is the *effective* move flag — a unit inching along in a crowd
  // reads as standing so it doesn't run in place (see the tick loop).
  //
  // …and a model with NO walk clip travels in its stand. The Wisp is the one that matters:
  // it authors five clips and not one of them is a Walk, because it hovers — the idle IS its
  // travel pose, and WC3 shows exactly that. Falling through to `a.walk` = -1 meant the caller
  // had no sequence to apply and simply left whatever was playing on the model, so a wisp
  // recalled off a tree flew the whole way there still wearing "Stand Lumber".
  if (moving) {
    const clip = carry === "gold" ? a.walkGold : carry === "lumber" ? a.walkLumber : a.walk;
    return clip >= 0 ? clip : a.stand;
  }
  if (u.constructing || u.repair?.active) return a.build; // hammering (build/repair)
  // A building actively producing (a unit in its queue) runs its "Stand Work"
  // clip — the blacksmith hammers, the barracks stirs, the Ancient of Lore's
  // "Stand Work Alternate" (it trains only while planted, so the pose lives on the
  // alternate half of its model). -1 → no-op for the structures that lack one, which
  // is most of them, and for an UPROOTED Ancient: its queue is halted rather than
  // cancelled, and a walking tree must not play the planted one's working pose.
  if (u.building && u.building.queue.length > 0) return a.standWork;
  // Only the ACTIVE chop plays the harvest swing — a worker merely holding
  // lumber while standing (its tree fell and it's about to return, so `working`
  // isn't cleared yet) shows the Stand Lumber pose, not the chop.
  //
  // …and a gatherer with no SWING to play holds the LUMBER pose. Wisp.mdx authors exactly five
  // clips — stand / Birth / Death / Stand Lumber / Stand Work — and no attack of any kind,
  // because a wisp does not hit the tree: it bonds to it and the lumber arrives. "Stand Lumber"
  // is the pose authored for exactly that, and the two are not interchangeable: "Stand Work" is
  // the hammering it does to build and to Renew (a repair — see the `u.repair` line above), and
  // wearing that one in the canopy is what made the harvest read as an animation of our own
  // rather than the one the model ships.
  // An Acolyte kneeling in a Haunted Gold Mine's ring works the mine WHERE IT STANDS, and
  // Acolyte.mdx authors the pose for exactly that ("Stand Work Gold"). Asked before the chop
  // below because the two are different jobs: the chop is a swing at a tree, this is a
  // channel at a mine, and the Acolyte has no swing to lend.
  if (u.working && u.order === "harvest" && u.ringSlot > 0 && a.standWorkGold >= 0) return a.standWorkGold;
  if (u.working && u.order === "harvest") return a.chopLumber >= 0 ? a.chopLumber : a.standLumber;
  // NOTE: no `inCombat → attack` here. The attack clip is owned entirely by the
  // swing-driven block above (triggered per swing). Reaching pickSequence while in
  // combat means the swing was broken by walking (backswing move-canceled), so the
  // unit stands out the recovery until its next real swing — it does not attack.
  return carry === "gold" ? a.standGold : carry === "lumber" ? a.standLumber : a.stand;
}


export function seqDuration(inst: SeqSource, idx: number, fallback: number): number {
  if (idx < 0) return fallback;
  const iv = inst.model.sequences[idx]?.interval;
  if (!iv || iv.length < 2) return fallback;
  const dur = (iv[1] - iv[0]) / 1000;
  return dur > 0 ? dur : fallback;
}

