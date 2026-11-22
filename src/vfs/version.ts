import { buildInfoVersion, isCascInstall } from "./casc";
import type { PickedInstall } from "../assets/opfs";
import { isMpqEraInstall } from "./mpqEra";

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
// What that used to mean was "everybody installs 1.30.4". It no longer does (issue #319): the
// mount turns the object tables of every build it knows INTO 1.30.4's (src/vfs/normalize.ts)
// and lays the later patches over those, so players on different builds still read one set of
// numbers. The gate is therefore "is this a build the mount can do that for":
//
//   • any MPQ-era install with The Frozen Throne (1.21 … 1.29.2) — among them the Legacy
//     install Battle.net ships beside Reforged, which is the one we RECOMMEND: it is the
//     original game, still downloadable by anyone who owns it;
//   • a 1.30.4 store, which needs nothing done to it;
//   • a 1.31.1 store, turned back.
//
// Reforged itself (1.32+) is not one of them: its store is laid out for another renderer.

/** The build whose tables OpenWar3 is written against, and that every other build is turned
 *  into. Matched on the first three components — `.build.info` carries a fourth (the build
 *  number, 11274 here) that varies with the download and says nothing about the data. MUST
 *  equal `REQUIRED_VERSION` in electron/install.mjs; `pnpm app:test` compares them. */
export const REQUIRED_VERSION = "1.30.4";

/** CASC builds the mount turns BACK into REQUIRED_VERSION: the Internet Archive's 1.31.1, which
 *  "Download game files" falls back on (src/assets/downloadInstall.ts). MUST equal
 *  `DOWNGRADE_VERSIONS` in electron/install.mjs; `pnpm app:test` compares them. */
export const DOWNGRADE_VERSIONS: readonly string[] = ["1.31.1"];

/** What the player is told to bring. One wording, used by the gate and by every refusal. */
export const RECOMMENDED_INSTALL = "Warcraft III 1.29 — the \"Warcraft III (Legacy)\" install Battle.net offers beside Reforged";

/** Is this a build the mount downgrades to REQUIRED_VERSION? */
export const isDowngradable = (version: string | null): boolean =>
  !!version && DOWNGRADE_VERSIONS.includes(version.split(".").slice(0, 3).join("."));

/** What to say about a folder that is the wrong build. One sentence, naming BOTH versions, so
 *  the player can see what they have as well as what is wanted. Shared by the load gate and by
 *  the desktop app's remembered-folder check, which reach the same conclusion by different
 *  routes and must not word it differently. */
export const wrongVersionMessage = (version: string | null): string =>
  version
    ? `That folder is Warcraft III ${version}, which OpenWar3 cannot read${/^([2-9]|1\.3[2-9])/.test(version) ? " (Reforged keeps its files differently)" : ""}. Use ${RECOMMENDED_INSTALL} — or any classic install up to 1.31.1.`
    : `That folder does not say which Warcraft III it is. Use ${RECOMMENDED_INSTALL} — or any classic install up to 1.31.1.`;

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
  const names = [...install.files.keys()];
  if (isMpqEraInstall(names)) {
    // The archives are the game, whatever a `.build.info` beside them says (the Legacy install
    // has one: "1.29.2.9232-legacy-tft"). WHICH build it is is read off its tables at the mount.
    return { ok: true, version: install.casc ? buildInfoVersion(install.casc.buildInfo) : null, message: "" };
  }
  if (!isCascInstall(install.casc)) {
    if (names.some((k) => k.toLowerCase() === "war3.mpq")) {
      // Reign of Chaos alone. The engine plays both editions out of ONE install's tables
      // (docs/editions.md), and those are The Frozen Throne's.
      return {
        ok: false,
        version: null,
        message: `That folder is Reign of Chaos without The Frozen Throne. OpenWar3 plays both out of a Frozen Throne install — use ${RECOMMENDED_INSTALL}.`,
      };
    }
    // Neither a content store nor an archive: not a Warcraft III at all (or one whose data has
    // gone).
    return {
      ok: false,
      version: null,
      message: `That folder has no Warcraft III game data in it. Select the Warcraft III folder itself — the one with Warcraft III.exe in it. We recommend ${RECOMMENDED_INSTALL}.`,
    };
  }
  const version = buildInfoVersion(install.casc.buildInfo);
  if (isRequiredVersion(version) || isDowngradable(version)) return { ok: true, version, message: "" };
  return { ok: false, version, message: wrongVersionMessage(version) };
}
