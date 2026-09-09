// No circular imports in `src/` — checked before every build (`pnpm build`), because a build is
// where this bug class is otherwise first SEEN.
//
// A cycle costs nothing under Vite's dev server: native ESM evaluates each module separately and
// a live binding is filled in by the time anybody reads it. Rollup has to pick ONE order for the
// bundle, and if it picks the wrong one a shared `const` is still in its temporal dead zone when
// a function reads it — "Cannot access 'z' before initialization", in minified code, from a
// stack of one-letter names. That is what shipped in 0.1.0: `fdfLan` needed the Join Server
// dialog and the dialog needed `fdfLan`'s LABEL_GOLD, so the game lobby threw while building,
// the screen before it was never disposed, and both were drawn at once. The developer found it
// in the AppImage.
//
// So the check runs in dev, on the source, where the answer is a file name rather than a letter.
//
// TYPE-ONLY imports are ignored, and that is not an optimisation: `import type` is erased by the
// compiler, so it cannot form a runtime cycle at all. Refusing them would forbid the ordinary
// shape of two modules that describe each other's data.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ROOT = "src";

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
})(ROOT);

/** Only VALUE imports of RELATIVE paths can form a runtime cycle within our own source. */
function valueImports(file) {
  const src = readFileSync(file, "utf8");
  const deps = new Set();
  const re = /(?:^|\n)\s*import\s+(type\s+)?([^;]*?)\s*from\s*["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) continue; // `import type { … } from`
    const inner = m[2].match(/^\{([\s\S]*)\}$/);
    // `import { type A, type B }` is erased too — every specifier is a type.
    if (inner && inner[1].split(",").every((s) => !s.trim() || /^type\s/.test(s.trim()))) continue;
    const target = resolve(dirname(file), m[3]);
    for (const candidate of [`${target}.ts`, join(target, "index.ts"), target]) {
      try {
        if (statSync(candidate).isFile()) { deps.add(candidate.replace(`${process.cwd()}/`, "")); break; }
      } catch { /* not this one */ }
    }
  }
  return [...deps];
}

const graph = new Map(files.map((f) => [f, valueImports(f)]));

// Plain colour-marking depth-first search: grey means "on the stack", so an edge to a grey node
// is a cycle and the stack from that node is the loop to print.
const GREY = 1, BLACK = 2;
const colour = new Map();
const stack = [];
const found = new Map();
function visit(node) {
  colour.set(node, GREY);
  stack.push(node);
  for (const dep of graph.get(node) ?? []) {
    if (colour.get(dep) === GREY) {
      const loop = [...stack.slice(stack.indexOf(dep)), dep];
      found.set([...loop].sort().join("|"), loop);
    } else if (!colour.has(dep)) visit(dep);
  }
  stack.pop();
  colour.set(node, BLACK);
}
for (const file of files) if (!colour.has(file)) visit(file);

if (found.size === 0) {
  console.log(`import cycles: none (${files.length} files)`);
  process.exit(0);
}
console.error(`import cycles: ${found.size} FOUND — a bundle would have to pick an order for these\n`);
for (const loop of found.values()) console.error(`  ${loop.join("\n    → ")}\n`);
console.error("Move what they share into a module that imports nothing (e.g. src/ui/glueColors.ts).");
process.exit(1);
