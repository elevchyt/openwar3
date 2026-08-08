// Single-player profiles (issue #80).
//
// A profile is the game's own answer to "whose campaign is this?" — the Single Player screen's
// left half (UI\FrameDef\Glue\SinglePlayerMenu.fdf's ProfilePanel) says exactly what one holds:
//
//     "Each profile will hold information for your campaign progress as well as a personal
//      saved games list. Please note that when deleting a profile, all of the above will be
//      deleted as well."                            — GlobalStrings.fdf, PROFILE_MESSAGE
//
// So a profile owns no data of its own here. It is a NAMESPACE: everything that belongs to a
// player rather than to the install is stored under `<key>.<profile>` (see `profileKey`), and
// deleting a profile is deleting every key in its namespace. Campaign progress is the first
// thing that moved (data/campaignProgress.ts); the saved-games list joins it when saving
// exists, under the same rule and with no change here.
//
// The store itself is the one the Options screen uses — localStorage, one JSON blob
// (data/options.ts) — and reads are best-effort for the same reason: a disabled or corrupt
// store should leave a player at the "no profiles yet" screen, not break the menu.

const STORAGE_KEY = "openwar3.profiles";

/** Every key whose value belongs to a PROFILE rather than to the install. `deleteProfile`
 *  clears all of them for the profile it removes, which is what PROFILE_MESSAGE promises.
 *  Add a key here the moment something new is stored per profile. */
const PROFILE_OWNED = ["openwar3.campaigns", "openwar3.campaignDifficulty", "openwar3.saves"];

/**
 * How long a profile name may be.
 *
 * OURS, not the game's: nothing in the FDF or GlobalStrings states a limit — `NewProfileEditBox`
 * declares only a size (0.18 × 0.04) and inherits StandardEditBoxTemplate, which sets no
 * `EditTextLength`. This is the width of that box in characters at its own font size, so a name
 * that fits the field is a name that fits the list under it.
 */
export const MAX_PROFILE_NAME = 24;

export interface Profile {
  name: string;
  /** When it was created, ms since the epoch — the list's order, oldest first. */
  created: number;
}

interface ProfileStore {
  profiles: Profile[];
  /** The name of the profile in play, or null when none has been selected yet. */
  active: string | null;
}

/** A FUNCTION, not a shared constant: the caller may push onto `profiles`, and a spread of a
 *  shared object would hand every "nothing stored" read the same array to grow. */
const empty = (): ProfileStore => ({ profiles: [], active: null });

function read(): ProfileStore {
  const ls = typeof localStorage !== "undefined" ? localStorage : null;
  if (!ls) return empty();
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<ProfileStore>;
    const profiles: Profile[] = [];
    for (const p of Array.isArray(parsed.profiles) ? parsed.profiles : []) {
      const name = typeof p?.name === "string" ? p.name.trim() : "";
      if (!name || profiles.some((q) => sameName(q.name, name))) continue;
      profiles.push({ name, created: typeof p.created === "number" ? p.created : 0 });
    }
    const active = typeof parsed.active === "string" && profiles.some((p) => p.name === parsed.active)
      ? parsed.active
      : null;
    return { profiles, active };
  } catch {
    return empty(); // private mode, corrupt JSON — "no profiles yet" is the right answer
  }
}

function write(store: ProfileStore): void {
  const ls = typeof localStorage !== "undefined" ? localStorage : null;
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota exceeded / storage disabled — the session still works, it just won't be remembered */
  }
}

/** Names are compared case-insensitively: "Arthas" and "arthas" are one profile, as two
 *  folders of the same name would be on the disk the reference keeps its profiles in. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Every profile, oldest first — the order the Profile List shows them in. */
export function loadProfiles(): Profile[] {
  return read().profiles.sort((a, b) => a.created - b.created);
}

/** The profile in play, or null when none has been selected (or none exists). */
export function activeProfile(): string | null {
  return read().active;
}

/** Put `name` in play. Silently ignored for a profile that doesn't exist. */
export function selectProfile(name: string): void {
  const store = read();
  if (!store.profiles.some((p) => p.name === name)) return;
  store.active = name;
  write(store);
}

/** Is `name` usable for a NEW profile? Empty names and duplicates are the two the screen
 *  guards against — PROFILE_NEEDS_A_NAME is the game's own word for the first. */
export function canCreateProfile(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && !read().profiles.some((p) => sameName(p.name, trimmed));
}

/**
 * Create a profile and put it in play — the reference selects what you just made, which is
 * also what makes the "no profiles yet" case resolve itself: the screen you are stuck on is
 * the one that gets you out of it.
 *
 * Returns the stored name (trimmed), or null if it was empty or already taken.
 */
export function createProfile(name: string, now = Date.now()): string | null {
  const trimmed = name.trim().slice(0, MAX_PROFILE_NAME);
  if (!trimmed || !canCreateProfile(trimmed)) return null;
  const store = read();
  store.profiles.push({ name: trimmed, created: now });
  store.active = trimmed;
  write(store);
  return trimmed;
}

/**
 * Delete a profile AND everything it owns (PROFILE_MESSAGE: "all of the above will be deleted
 * as well"). If it was the one in play, the next profile takes over — or none, which puts the
 * screen back to its "create one first" state.
 */
export function deleteProfile(name: string): void {
  const store = read();
  const index = store.profiles.findIndex((p) => p.name === name);
  if (index < 0) return;
  store.profiles.splice(index, 1);
  if (store.active === name) store.active = store.profiles[0]?.name ?? null;
  write(store);

  const ls = typeof localStorage !== "undefined" ? localStorage : null;
  if (!ls) return;
  for (const base of PROFILE_OWNED) {
    try {
      ls.removeItem(`${base}.${name}`);
    } catch {
      /* storage disabled — there was nothing stored to remove either */
    }
  }
}

/**
 * The storage key `base` takes for the profile in play.
 *
 * With no profile selected it is `base` itself, unchanged. That is deliberate rather than a
 * fallback: it is where campaign progress lived before profiles existed, so a player who had
 * played the campaign without ever making a profile still finds it there — and `adoptOrphaned`
 * hands it to the first profile they create.
 */
export function profileKey(base: string, profile = activeProfile()): string {
  return profile ? `${base}.${profile}` : base;
}

/**
 * Hand any pre-profile data to `profile`, once.
 *
 * Progress made before this issue landed sits under the bare keys (`openwar3.campaigns`), and
 * a player who had half a campaign done would otherwise watch it vanish the moment they made
 * the profile the screen now insists on. Called by `createProfile`'s caller for the FIRST
 * profile only — after that the bare keys are gone and there is nothing to adopt.
 */
export function adoptOrphanedData(profile: string): void {
  const ls = typeof localStorage !== "undefined" ? localStorage : null;
  if (!ls) return;
  for (const base of PROFILE_OWNED) {
    try {
      const raw = ls.getItem(base);
      if (raw === null) continue;
      if (ls.getItem(`${base}.${profile}`) === null) ls.setItem(`${base}.${profile}`, raw);
      ls.removeItem(base);
    } catch {
      /* storage disabled — nothing to adopt */
    }
  }
}
