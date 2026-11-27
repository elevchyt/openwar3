// The bone a `SetUnitLookAt` names (issue #376). Pure, so the matching rule is tested headless
// (tools/sim-unit-news-test.cjs); RtsController applies it to a model's skeleton and the viewer
// patch turns the bone (`ow3AimBone` in mdx/modelinstance.js).

/**
 * Which bone `SetUnitLookAt`'s name means, by jassdoc's own rule: the name is a set of
 * space-separated, case-insensitive TOKENS out of alternate, bone_chest, bone_foot, bone_hand,
 * bone_head, bone_turret, left, mount, right, smart — anything else counts as "bone_head" —
 * and the bone that matches the MOST of them wins, a tie going to the one with the FEWEST
 * tokens of its own the request did not name, then to the first found. No match is -1 and
 * nothing is locked. A node's name is read as tokens the same way ("Bone_Head" is bone_head,
 * "Bone_Hand_R" is bone_hand + right — the models spell the sides `_L`/`_R`), which is ours:
 * jassdoc states the matching, not how a name is cut.
 */
export function lookAtBone(names: ArrayLike<string>, tokens: string[]): number {
  const KNOWN = ["alternate", "bone_chest", "bone_foot", "bone_hand", "bone_head", "bone_turret", "left", "mount", "right", "smart"];
  const want = new Set(tokens.map((t) => (KNOWN.includes(t) ? t : "bone_head")));
  if (!want.size) want.add("bone_head");
  let best = -1;
  let bestHit = 0;
  let bestExtra = Infinity;
  for (let i = 0; i < names.length; i++) {
    const words = names[i].toLowerCase().split(/[\s_]+/).filter(Boolean);
    const own = new Set<string>();
    for (let w = 0; w < words.length; w++) {
      if (words[w] === "bone" && w + 1 < words.length) own.add(`bone_${words[++w]}`);
      else own.add(words[w] === "l" ? "left" : words[w] === "r" ? "right" : words[w]);
    }
    let hit = 0;
    for (const t of want) if (own.has(t)) hit++;
    const extra = own.size - hit;
    if (hit > bestHit || (hit === bestHit && hit > 0 && extra < bestExtra)) {
      best = i;
      bestHit = hit;
      bestExtra = extra;
    }
  }
  return bestHit > 0 ? best : -1;
}
