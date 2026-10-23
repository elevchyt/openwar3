/**
 * `pnpm hive:post [version]` — the Hive Workshop announcement for a release, ready to post.
 *
 *   pnpm hive:post            # the version in package.json
 *   pnpm hive:post 0.3.60     # …or any published release
 *   pnpm hive:post --print    # write the post to stdout only: no clipboard, no browser
 *
 * Reads the release's notes off GitHub (`gh release view`), turns their Markdown into the BBCode
 * Hive's XenForo editor takes, copies that to the clipboard and opens the thread's reply page.
 * The last step is the developer's: paste, check Preview, press Post Reply.
 *
 * **Why not post it from here.** Hive is XenForo behind Cloudflare: its REST API needs a key only
 * the forum's admins can issue, and a script posting off a saved login is challenged by the same
 * bot check that 403s plain fetchers (docs/REFERENCES.md) — and is a bot posting under a person's
 * name. A reply box filled by a paste is all of the work with none of that.
 *
 * Run it AFTER `gh release edit vX.Y.Z --draft=false …`: a draft's page is a 404 to everybody
 * else, so it refuses one (and refuses empty notes, which is what electron-builder leaves).
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const THREAD = "https://www.hiveworkshop.com/threads/what-is-openwar3.375387/";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const version =
  args.find((a) => !a.startsWith("--"))?.replace(/^v/, "") ??
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const tag = `v${version}`;

const gh = (...a) => execFileSync("gh", a, { cwd: root, encoding: "utf8" }).trim();

const release = JSON.parse(gh("release", "view", tag, "--json", "body,isDraft"));
if (release.isDraft) fail(`${tag} is still a draft — publish it first (gh release edit ${tag} --draft=false …).`);
if (!release.body.trim()) fail(`${tag} has no release notes yet.`);
const repo = gh("repo", "view", "--json", "url", "-q", ".url");
// The TAG's page, not the API's `url`: a release that was ever a draft keeps an
// `untagged-…` url there, and that one is dead the moment it is published.
const page = `${repo}/releases/tag/${tag}`;

const post = [
  `[B][SIZE=5]OpenWar3 ${version} is out[/SIZE][/B]`,
  "",
  toBBCode(release.body),
  "",
  `[B]Already playing?[/B] Just launch OpenWar3 — it offers the update by itself the next time it starts.`,
  `[B]New here?[/B] Download it from the [URL='${page}']release page[/URL].`,
].join("\n");

if (printOnly) {
  process.stdout.write(post + "\n");
  process.exit(0);
}

console.log(post);
console.log("\n" + "─".repeat(60));
console.log(copy(post) ? "Copied to the clipboard." : "No clipboard tool found — copy the post above by hand.");
console.log("Opening the reply page: paste into the editor, check Preview, press Post Reply.");
console.log(`(If the page has no editor, the quick-reply box is at the bottom of ${THREAD}latest)`);
open(`${THREAD}reply`);

/** The release notes' Markdown (bold headings, `-` lists, links, inline code) as XenForo BBCode. */
function toBBCode(md) {
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, "[ICODE]$1[/ICODE]")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "[URL='$2']$1[/URL]")
      .replace(/\*\*([^*]+)\*\*/g, "[B]$1[/B]")
      .replace(/(^|[^*\w])[*_]([^*_\s][^*_]*)[*_](?![*\w])/g, "$1[I]$2[/I]");

  const out = [];
  let list = null; // "" for a bullet list, "=1" for a numbered one
  const closeList = () => {
    if (list !== null) out.push("[/LIST]");
    list = null;
  };
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const kind = item[1] ? "" : "=1";
      if (list !== kind) {
        closeList();
        out.push(`[LIST${kind}]`);
        list = kind;
      }
      out.push(`[*]${inline(item[2])}`);
      continue;
    }
    closeList();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    out.push(heading ? `[B]${inline(heading[1])}[/B]` : inline(line));
  }
  closeList();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The first clipboard tool this machine has, fed on stdin. */
function copy(text) {
  const tools =
    process.platform === "win32"
      ? [["powershell", ["-NoProfile", "-Command", "$input | Set-Clipboard"]]]
      : process.platform === "darwin"
        ? [["pbcopy", []]]
        : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [cmd, a] of tools) {
    try {
      execFileSync(cmd, a, { input: text, stdio: ["pipe", "ignore", "ignore"] });
      return true;
    } catch {
      // not installed (or no display for it) — try the next one
    }
  }
  return false;
}

function open(url) {
  const [cmd, a] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  spawn(cmd, a, { stdio: "ignore", detached: true }).unref();
}

function fail(msg) {
  console.error(`hive:post: ${msg}`);
  process.exit(1);
}
