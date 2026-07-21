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
  build: number; // "Stand Work" — the hammering pose while constructing
  decayFlesh: number; // corpse decay — flesh rots (heroes lack this)
  decayBone: number; // corpse decay — bones linger, then vanish
  /** "Morph" — the clip a unit plays while CHANGING form. -1 for almost everything; the
   *  Ancients author it as a pair, and which of the pair this index lands on depends on the
   *  animProps the set was built with: the plain set's "Morph" is the Ancient hauling its
   *  roots up, and under `alternate` the renamed "Morph Alternate" is it planting again. So
   *  building the set for the state being moved TO always yields the right transition. */
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
export function applyAnimProps(seqs: Array<{ name: string }>, animProps: string[] = []): Array<{ name: string }> {
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
  const isMine = (n: string) => {
    const p = propsOf(n);
    return p.length > 0 && tier.every((t) => p.includes(t));
  };
  return seqs.map((s) => {
    if (isMine(s.name)) return { name: baseOf(s.name).join(" ") };
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
  const standVariants = indices(PLAIN_STAND);
  const attackVariants = indices(PLAIN_ATTACK);
  const stand = standVariants.length
    ? standVariants[0]
    : find(/^stand(\s|$|-)/i) >= 0
      ? find(/^stand(\s|$|-)/i)
      : find(/^stand/i);
  // The plain "Walk" must not match "Walk Fast" (a distinct gait, chosen by speed) — hence
  // the anchored test first, with the loose one only as a last-resort fallback.
  const walk = find(/^walk(\s*-?\s*\d+)?\s*$/i) >= 0 ? find(/^walk(\s*-?\s*\d+)?\s*$/i) : find(/^walk(?! fast)/i);
  const walkFast = find(/^walk fast/i);
  const attack = attackVariants.length
    ? attackVariants[0]
    : find(/^attack\s*$/i) >= 0
      ? find(/^attack\s*$/i)
      : find(/attack/i);
  // Carry-attack swings, chosen by the worker's carried resource (issue #35). "* Swim"
  // is excluded here too so a laden worker never swings a swim clip.
  const carryAttack = seqs
    .map((s, i) => ({ n: s.name, i }))
    .filter(({ n }) => /attack/i.test(n) && !/defend|alternate|slam|swim/i.test(n));
  const attackGold = carryAttack.filter(({ n }) => /gold/i.test(n)).map(({ i }) => i);
  const attackLumber = carryAttack.filter(({ n }) => /lumber/i.test(n)).map(({ i }) => i);
  const or = (a: number, b: number) => (a >= 0 ? a : b);
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
    build: or(find(/stand work(?! gold| lumber)/i), or(find(/^stand work/i), attack)),
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
  if (moving) return carry === "gold" ? a.walkGold : carry === "lumber" ? a.walkLumber : a.walk;
  if (u.constructing || u.repair?.active) return a.build; // hammering (build/repair)
  // A building actively producing (a unit in its queue) runs its "Stand Work"
  // clip — the blacksmith hammers, the barracks stirs, etc. `build` resolves to
  // that clip for structures (and is -1 → no-op for ones that lack it).
  if (u.building && u.building.queue.length > 0) return a.build;
  // Only the ACTIVE chop plays the harvest swing — a worker merely holding
  // lumber while standing (its tree fell and it's about to return, so `working`
  // isn't cleared yet) shows the Stand Lumber pose, not the chop.
  if (u.working && u.order === "harvest") return a.chopLumber;
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

