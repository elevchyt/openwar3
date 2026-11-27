// JASS language semantics the interpreter has to get exactly right (src/jass/interpreter.ts,
// values.ts, lexer.ts, parser.ts) — each one a case where JavaScript's own arithmetic, string
// or boolean rule differs from the game's VM, and a map that depends on it is quietly wrong
// rather than broken.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-semantics-test.cjs
//
// Needs no game data: every program is written here.

const { existsSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const BUILD = join(REPO, '.jass-build', 'src', 'jass');
if (!existsSync(join(BUILD, 'headless.js'))) {
  console.error('Build first:  npx tsc -p tools/tsconfig.jass.json');
  process.exit(2);
}
writeFileSync(join(REPO, '.jass-build', 'package.json'), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, 'headless.js'));

let failures = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (want ${want})`}`);
};
/** A JassValue as the plain value a check compares: a number, a string, a boolean, or "null". */
const plain = (v) => (v.k === 'int' || v.k === 'real' ? v.n : v.k === 'string' ? v.s : v.k === 'bool' ? v.b : v.k);
const boot = (src, opts = {}) => {
  const interp = buildInterpreter([src], opts);
  return { interp, call: (fn, args = []) => plain(interp.callFunction(fn, args)), raw: (fn) => interp.callFunction(fn, []) };
};

// --- #372: integer * integer wraps at 32 bits --------------------------------------------------
{
  console.log('--- integer multiplication wraps at 32 bits (#372) ---');
  const { call } = boot(`
function Lcg takes nothing returns integer
    return 1103515245 * 2147483647
endfunction
function Big takes nothing returns integer
    local integer a = 2147483647
    return a * a
endfunction
function Neg takes nothing returns integer
    return -2147483647 * 65537
endfunction
function Small takes nothing returns integer
    return 1234 * -5678
endfunction
function RealStaysReal takes nothing returns real
    return 2147483647 * 2.0
endfunction
`);
  check('1103515245 * 2147483647', call('Lcg'), Math.imul(1103515245, 2147483647));
  check('the exact 32-bit wrap', call('Lcg'), 1043968403);
  check('(2^31-1)^2 wraps to 1', call('Big'), 1);
  check('a negative product wraps', call('Neg'), Math.imul(-2147483647, 65537));
  check('a small product is unchanged', call('Small'), -7006652);
  check('a real operand does not wrap', call('RealStaysReal'), 4294967294);
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll JASS semantics checks passed.');
process.exit(failures ? 1 : 0);
