#!/usr/bin/env node
// Strips AI-assistant attribution out of a commit message: a `Co-authored-by:` trailer naming
// Claude or an anthropic.com address (that trailer is what makes GitHub list "claude" as a
// participant / contributor), and the "Generated with [Claude Code]" footer. Every other
// line — a human co-author included — is left exactly as written.
//
// One script, three callers, so they can never disagree about what counts:
//   .husky/commit-msg                  `node tools/strip-ai-attribution.mjs "$1"` (in place)
//   git filter-branch --msg-filter     `node tools/strip-ai-attribution.mjs` (stdin → stdout)
//   .github/workflows/attribution.yml  `--check` over a PR's commits (exit 1 on a match)
import { readFileSync, writeFileSync } from "node:fs";

const TRAILER = /^\s*co-authored-by:.*(claude|anthropic\.com)/i;
const FOOTER = /^\s*(🤖\s*)?generated with \[?claude code\]?/i;

export function isAttribution(line) {
  return TRAILER.test(line) || FOOTER.test(line);
}

export function strip(msg) {
  const lines = msg.split("\n").filter((l) => !isAttribution(l));
  // A squash message separates the PR's commits from GitHub's trailer block with a "---------"
  // rule; with nothing left under it, drop the rule too.
  let out = lines.join("\n").replace(/\s+$/, "");
  out = out.replace(/\n+-{3,}$/, "").replace(/\s+$/, "");
  return out.replace(/\n{3,}/g, "\n\n") + "\n";
}

const args = process.argv.slice(2);
if (args[0] === "--check") {
  // stdin: any text (a PR's commit messages, author lines); prints each match, exit 1 if any.
  const hits = readFileSync(0, "utf8").split("\n").filter(isAttribution);
  for (const h of hits) console.log(h.trim());
  process.exit(hits.length ? 1 : 0);
} else if (args[0]) {
  const before = readFileSync(args[0], "utf8");
  const after = strip(before);
  if (after !== before) writeFileSync(args[0], after);
} else {
  process.stdout.write(strip(readFileSync(0, "utf8")));
}
