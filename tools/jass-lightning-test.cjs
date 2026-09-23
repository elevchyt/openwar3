// The script LIGHTNING natives' JASS half (src/jass/natives/lightning.ts — docs/map-compatibility.md
// pass 10): that each reaches the engine with the right points, the right HEIGHT rule and the
// right visibility flag, and that a bolt the engine refused is a null handle every other native
// answers false/0 for.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-lightning-test.cjs
//
// The height rule is the one worth pinning: plain `AddLightning` "attaches to the ground"
// (hiveworkshop 278746), while the Ex form's z is ABSOLUTE — blizzard.j's own `AddLightningLoc`
// passes `GetLocationZ` straight through, so it is run here too.
//
// Reads only the developer's own local install (gitignored; zero shipped assets).

const { readFileSync, existsSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const BUILD = join(REPO, '.jass-build', 'src');
if (!existsSync(join(BUILD, 'jass', 'headless.js'))) {
  console.error('Build first:  npx tsc -p tools/tsconfig.jass.json');
  process.exit(2);
}
writeFileSync(join(REPO, '.jass-build', 'package.json'), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, 'jass', 'headless.js'));

const SCRIPTS = join(REPO, 'Warcraft III', 'ExtractedData', 'merged', 'Scripts');
if (!existsSync(join(SCRIPTS, 'common.j'))) {
  console.error("Run `pnpm data:extract` first — this test reads the install's own common.j and Blizzard.j.");
  process.exit(2);
}
const decode = (b) => new TextDecoder('windows-1252').decode(b);
const common = decode(readFileSync(join(SCRIPTS, 'common.j')));
const blizzard = decode(readFileSync(join(SCRIPTS, 'Blizzard.j')));

let failures = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (want ${want})`}`);
};
const J = (x) => JSON.stringify(x);

// A stand-in engine: it knows two rows, keeps each bolt's colour, and records every call.
const calls = [];
const bolts = new Map();
let next = 1;
const hooks = {
  addLightning: (code, vis, x1, y1, z1, x2, y2, z2, absZ) => {
    calls.push(['add', code, vis, x1, y1, z1, x2, y2, z2, absZ]);
    if (code !== 'CLPB' && code !== 'DRAM') return -1;
    const id = next++;
    bolts.set(id, [1, 1, 1, 1]);
    return id;
  },
  moveLightning: (id, vis, x1, y1, z1, x2, y2, z2, absZ) => { calls.push(['move', id, vis, x1, y1, z1, x2, y2, z2, absZ]); return bolts.has(id); },
  destroyLightning: (id) => { calls.push(['destroy', id]); return bolts.delete(id); },
  setLightningColor: (id, r, g, b, a) => { if (!bolts.has(id)) return false; bolts.set(id, [r, g, b, a]); return true; },
  lightningColor: (id) => bolts.get(id) ?? null,
};

const SRC = `
globals
    lightning bolt = null
    lightning bad = null
endglobals
function Ground takes nothing returns nothing
    set bolt = AddLightning("CLPB", true, 1.0, 2.0, 3.0, 4.0)
endfunction
function Air takes nothing returns nothing
    set bolt = AddLightningEx("CLPB", false, 1.0, 2.0, 300.0, 4.0, 5.0, 600.0)
endfunction
function Unknown takes nothing returns nothing
    set bad = AddLightning("ZZZZ", true, 0.0, 0.0, 1.0, 1.0)
endfunction
function MoveGround takes nothing returns boolean
    return MoveLightning(bolt, false, 10.0, 20.0, 30.0, 40.0)
endfunction
function MoveAir takes nothing returns boolean
    return MoveLightningEx(bolt, true, 10.0, 20.0, 5.0, 30.0, 40.0, 6.0)
endfunction
function Tint takes nothing returns boolean
    return SetLightningColor(bolt, 0.0, 0.7, 1.0, 0.5)
endfunction
function G takes nothing returns real
    return GetLightningColorG(bolt)
endfunction
function A takes nothing returns real
    return GetLightningColorA(bolt)
endfunction
function Kill takes nothing returns boolean
    return DestroyLightning(bolt)
endfunction
function BadMove takes nothing returns boolean
    return MoveLightning(bad, true, 0.0, 0.0, 1.0, 1.0)
endfunction
function BadColour takes nothing returns real
    return GetLightningColorR(bad)
endfunction
function BadKill takes nothing returns boolean
    return DestroyLightning(bad)
endfunction
function ViaLoc takes nothing returns nothing
    call AddLightningLoc("DRAM", Location(100.0, 0.0), Location(200.0, 0.0))
endfunction
`;

const quiet = [console.info, console.warn];
console.info = () => {};
console.warn = () => {};
const interp = buildInterpreter([common, blizzard, SRC], { hooks });
[console.info, console.warn] = quiet;
const call = (fn) => interp.callFunction(fn, []);

console.log('--- where the ends are ---');
call('Ground');
check('plain AddLightning puts both ends ON THE GROUND (z 0, not absolute)', J(calls[0]), J(['add', 'CLPB', true, 1, 2, 0, 3, 4, 0, false]));
call('Air');
check('AddLightningEx carries its z as ABSOLUTE heights', J(calls[1]), J(['add', 'CLPB', false, 1, 2, 300, 4, 5, 600, true]));
check('MoveLightning keeps to the ground', call('MoveGround').b, true);
check('…with its own visibility flag and points', J(calls[2]), J(['move', 2, false, 10, 20, 0, 30, 40, 0, false]));
call('MoveAir');
check('MoveLightningEx moves the heights too', J(calls[3]), J(['move', 2, true, 10, 20, 5, 30, 40, 6, true]));

console.log('\n--- colour ---');
check('SetLightningColor answers true for a live bolt', call('Tint').b, true);
check('GetLightningColorG reads back what was set', Math.round(call('G').n * 10) / 10, 0.7);
check('…and the alpha', call('A').n, 0.5);

console.log('\n--- a refused bolt is a null handle ---');
call('Unknown');
check('a row the table does not have gives no bolt', call('BadMove').b, false);
check('…its colour reads 0', call('BadColour').n, 0);
check('…and destroying it is legal and false', call('BadKill').b, false);

console.log('\n--- destroying ---');
check('DestroyLightning answers true once', call('Kill').b, true);
check('…and the bolt is gone from the engine', bolts.has(2), false);

console.log('\n--- blizzard.j over the natives ---');
calls.length = 0;
call('ViaLoc');
const loc = calls[0];
check('AddLightningLoc goes through the Ex form', loc && loc[9], true);
check('…with checkVisibility on, as blizzard.j writes it', loc && loc[2], true);

console.log(failures ? `\n${failures} failure(s).` : '\nAll lightning native checks passed.');
process.exit(failures ? 1 : 0);
