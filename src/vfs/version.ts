import { buildInfoVersion, isCascInstall } from "./casc";
import type { PickedInstall } from "../assets/opfs";

// Which Warcraft III an install has to be, and why the answer is not "any of them".
//
// **Every player must be running the same game DATA.** A match's units, abilities, costs and
// timings are read out of each machine's own install (that is the whole asset-compatible
// design), so two players on different patches are two players playing different games: the
// authority resolves an order against ITS Footman and the client draws the one in its own SLKs.
// Nothing in the wire protocol can catch that — `PROTOCOL_VERSION` says the two CLIENTS agree,
// which is a different question and answered in a different place (src/net/protocol.ts).
//
// So the version is a gate rather than a note, and it is checked on EVERY launch and not only
// when the folder is first picked: the desktop app remembers a folder and reads it again next
// time (src/assets/nativeInstall.ts), and a player can patch Warcraft III between one launch and
// the next without touching OpenWar3 at all.
//
// **1.30.4** is the target because it is the last build of the pre-Reforged client, and the one
// this engine is written against — see CLAUDE.md and docs/casc.md. A pre-1.30 install is an MPQ
// one, which has no `.build.info` and is therefore not 1.30.4 by construction.

/** The build OpenWar3 plays. Matched on the first three components — `.build.info` carries a
 *  fourth (the build number, 11274 here) that varies with the download and says nothing about
 *  the data. MUST equal `REQUIRED_VERSION` in electron/install.mjs, which asks the same question
 *  of the folder dialog before the answer can be remembered; `pnpm app:test` compares them. */
export const REQUIRED_VERSION = "1.30.4";

/** What to say about a folder that is the wrong build. One sentence, naming BOTH versions, so
 *  the player can see what they have as well as what is wanted. Shared by the load gate and by
 *  the desktop app's remembered-folder check, which reach the same conclusion by different
 *  routes and must not word it differently. */
export const wrongVersionMessage = (version: string | null): string =>
  version
    ? `That folder is Warcraft III ${version}. OpenWar3 plays ${REQUIRED_VERSION} — every player has to be on the same game data, so this is checked every launch.`
    : `That folder does not say which Warcraft III it is. OpenWar3 plays ${REQUIRED_VERSION} (The Frozen Throne).`;

export interface VersionVerdict {
  ok: boolean;
  /** What the install says it is, when it says anything at all. */
  version: string | null;
  /** Empty when `ok`. Shown to the player verbatim, so it names both versions. */
  message: string;
}

/** Does this version string name the build we play? */
export const isRequiredVersion = (version: string | null): boolean =>
  !!version && version.split(".").slice(0, 3).join(".") === REQUIRED_VERSION;

/** Check a picked folder before it is mounted. */
export function checkVersion(install: PickedInstall): VersionVerdict {
  if (!isCascInstall(install.casc)) {
    // No content store: this is an MPQ-era folder, i.e. older than 1.30 by construction. Said
    // that way round because "no .build.info" means nothing to a player.
    return {
      ok: false,
      version: null,
      message: `That folder is a Warcraft III older than ${REQUIRED_VERSION}. OpenWar3 plays ${REQUIRED_VERSION} (The Frozen Throne) — every player has to be on the same game data, so this is checked every launch.`,
    };
  }
  const version = buildInfoVersion(install.casc.buildInfo);
  if (isRequiredVersion(version)) return { ok: true, version, message: "" };
  return { ok: false, version, message: wrongVersionMessage(version) };
}
