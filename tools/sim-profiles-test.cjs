// Headless check of the single-player profile model (issue #80): the store round-trip, and the
// rule the game's own PROFILE_MESSAGE states — "when deleting a profile, all of the above will
// be deleted as well". The SCREEN is verified in the real browser (it's FDF chrome and 3D panel
// clips, so it's a screenshot); what a screenshot cannot see is which localStorage keys a
// profile owns and whether deleting one really takes them, so that is pinned here against a
// stub localStorage.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const P = require(join(REPO, ".sim-build", "src", "data", "profiles.js"));
const C = require(join(REPO, ".sim-build", "src", "data", "campaignProgress.js"));

console.log("a fresh install has no profiles and none in play");
{
  check("no profiles", P.loadProfiles(), []);
  check("none active", P.activeProfile(), null);
  // With none, a key is un-suffixed — where progress lived before profiles existed.
  check("bare key", P.profileKey("openwar3.campaigns"), "openwar3.campaigns");
}

console.log("\ncreating one puts it in play");
{
  check("created", P.createProfile("Arthas", 1), "Arthas");
  check("in play", P.activeProfile(), "Arthas");
  check("listed", P.loadProfiles().map((p) => p.name), ["Arthas"]);
  check("its key is suffixed", P.profileKey("openwar3.campaigns"), "openwar3.campaigns.Arthas");
}

console.log("\nnames are trimmed, capped, and unique case-insensitively");
{
  check("a duplicate is refused", P.createProfile("arthas", 2), null);
  check("…and the button knows in advance", P.canCreateProfile("ARTHAS"), false);
  check("an empty name is refused", P.createProfile("   ", 2), null);
  check("…and so is the empty string", P.canCreateProfile(""), false);
  check("surrounding space is trimmed", P.createProfile("  Jaina  ", 2), "Jaina");
  const long = "x".repeat(P.MAX_PROFILE_NAME + 10);
  check("a long name is capped", P.createProfile(long, 3).length, P.MAX_PROFILE_NAME);
  P.deleteProfile("x".repeat(P.MAX_PROFILE_NAME));
  check("listed oldest first", P.loadProfiles().map((p) => p.name), ["Arthas", "Jaina"]);
}

console.log("\ncampaign progress follows the profile in play");
{
  P.selectProfile("Arthas");
  C.markMissionComplete("human", 2); // three chapters of the human campaign done
  C.saveDifficulty("hard");
  P.selectProfile("Jaina");
  check("a fresh profile starts fresh", C.loadProgress(), {});
  check("…and on the game's own default difficulty", C.loadDifficulty(), "normal");
  C.markMissionComplete("human", 0);
  check("its own progress", C.loadProgress(), { human: 1 });
  P.selectProfile("Arthas");
  check("the other profile is untouched", C.loadProgress(), { human: 3 });
  check("…difficulty too", C.loadDifficulty(), "hard");
}

console.log("\ndeleting a profile deletes everything it owns (PROFILE_MESSAGE)");
{
  P.deleteProfile("Arthas");
  check("gone from the list", P.loadProfiles().map((p) => p.name), ["Jaina"]);
  check("the next one takes over", P.activeProfile(), "Jaina");
  check("its progress key is gone", store.has("openwar3.campaigns.Arthas"), false);
  check("its difficulty key too", store.has("openwar3.campaignDifficulty.Arthas"), false);
  check("the survivor's is not", C.loadProgress(), { human: 1 });

  P.deleteProfile("Jaina");
  check("the last one leaves none in play", P.activeProfile(), null);
  check("and nothing of its own behind", [...store.keys()], ["openwar3.profiles"]);
}

console.log("\nthe first profile adopts what was played before profiles existed");
{
  store.clear();
  store.set("openwar3.campaigns", JSON.stringify({ human: 4 }));
  store.set("openwar3.campaignDifficulty", "easy");
  const name = P.createProfile("Thrall", 9);
  P.adoptOrphanedData(name);
  check("progress came across", C.loadProgress(), { human: 4 });
  check("difficulty too", C.loadDifficulty(), "easy");
  check("the bare key is gone", store.has("openwar3.campaigns"), false);
}

console.log("\na corrupt store reads as a fresh install rather than throwing");
{
  store.clear();
  store.set("openwar3.profiles", "{not json");
  check("no profiles", P.loadProfiles(), []);
  check("none in play", P.activeProfile(), null);
  // An `active` naming a profile that isn't in the list is not a profile in play.
  store.set("openwar3.profiles", JSON.stringify({ profiles: [{ name: "A", created: 1 }], active: "B" }));
  check("a dangling active is dropped", P.activeProfile(), null);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
