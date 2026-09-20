// Lua map scripts (src/compat/lua/, docs/map-compatibility.md step 6).
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-lua-test.cjs
//
// A Lua map is the SAME API in a different language, so what has to be proved is the bridge:
// that the script reaches the engine's natives, the install's own blizzard.j, and common.j's
// constants; that a handle is still a handle when it comes back; that Lua's integers and
// floats survive as JASS's; that a wait suspends the way a JASS one does; and that a Lua
// function handed to TriggerAddAction is a trigger action like any other.
//
// Reads only the developer's own local install (gitignored; zero shipped assets).

const { readFileSync, existsSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const BUILD = join(REPO, '.jass-build', 'src');
if (!existsSync(join(BUILD, 'compat', 'lua', 'host.js'))) {
  console.error('Build first:  npx tsc -p tools/tsconfig.jass.json');
  process.exit(2);
}
writeFileSync(join(REPO, '.jass-build', 'package.json'), '{"type":"commonjs"}');
const { buildInterpreter } = require(join(BUILD, 'jass', 'headless.js'));
const { createLuaMapScript } = require(join(BUILD, 'compat', 'lua', 'host.js'));
const { COMPAT_PRELUDE } = require(join(BUILD, 'compat', 'prelude.js'));

const SCRIPTS = join(REPO, 'Warcraft III', 'ExtractedData', 'merged', 'Scripts');
if (!existsSync(join(SCRIPTS, 'common.j'))) {
  console.error('Run `pnpm data:extract` first — this test reads the install\'s own common.j.');
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

const notes = [];
const realInfo = console.info, realWarn = console.warn;
console.info = (...a) => notes.push(a.join(' '));
console.warn = console.info;
const interp = buildInterpreter([common, COMPAT_PRELUDE, blizzard], {});
const lua = createLuaMapScript(interp, 1);

const CHUNK = [
  'arr = __jarray(0)',
  'arr[3] = 7',
  '',
  'function config()',
  '  SetMapName("A Lua map")',
  '  SetPlayers(2)',
  '  SetTeams(2)',
  '  DefineStartLocation(0, 100.0, 200.0)',
  '  DefineStartLocation(1, -100.0, -200.0)',
  '  SetPlayerStartLocation(Player(0), 0)',
  '  SetPlayerStartLocation(Player(1), 1)',
  'end',
  '',
  'function arrays() return arr[3] * 100 + arr[4] end',
  '',
  'function handles()',
  '  local p0, p0b, p1 = Player(0), Player(0), Player(1)',
  '  local seen = {}',
  '  seen[p0] = "zero"',
  '  return (p0 == p0b) and (p0 ~= p1) and (seen[p0b] == "zero") and (type(p0) == "userdata")',
  'end',
  '',
  'function bjcall() return StringLength("abcd") + StringLength("xy") end',
  'function nums() return I2S(7 // 2) .. "/" .. R2S(7 / 2) end',
  'function readsGlobal() return bj_MAX_PLAYERS end',
  'function writesGlobal() bj_isSinglePlayer = true return bj_isSinglePlayer end',
  'function sandbox() return (io == nil) and (os == nil) and (load == nil) and (require == nil) end',
  '',
  'slept = 0',
  'function sleeper()',
  '  slept = slept + 1',
  '  TriggerSleepAction(2.0)',
  '  slept = slept + 10',
  '  PolledWait(1.0)',
  '  slept = slept + 100',
  'end',
  'function sleptSoFar() return slept end',
  '',
  'fired = 0',
  'function onEvent() fired = fired + 1 end',
  'function makeTrigger()',
  '  local t = CreateTrigger()',
  '  TriggerAddAction(t, onEvent)',
  '  return t',
  'end',
  'function fireIt(t) TriggerExecute(t) end',
  'function firedCount() return fired end',
  'function sameFunctionTwice() return onEvent == onEvent end',
].join('\n');

lua.load(CHUNK, 'test.lua');
console.info = realInfo;
console.warn = realWarn;

const call = (fn, args = []) => interp.callFunction(fn, args);

console.log('--- the bridge ---');
check('the map\'s own functions are published', lua.hasFunction('config'), true);
check('…and the library\'s are not', lua.hasFunction('pairs'), false);
check('__jarray reads its default at an unwritten index', call('arrays').n, 700);
check('a handle is one value, comparable and keyable', call('handles').b, true);
check('a blizzard.j BJ runs from Lua', call('bjcall').n, 6);
// `7 // 2` is Lua's floor division and stays an INTEGER; `7 / 2` is a float, and R2S
// prints WC3's three decimals. Both sides of the bridge keep the distinction.
check('Lua integers and floats arrive as JASS\'s', call('nums').s, '3/3.500');
check('a common.j constant reads through', call('readsGlobal').n, 12); // bj_MAX_PLAYERS
check('a JASS global written from Lua…', call('writesGlobal').b, true);
check('…is the same variable JASS sees', interp.rt.globals.get('bj_isSinglePlayer').b, true);
check('the sandbox has no doors out', call('sandbox').b, true);

console.log('\n--- config() ---');
interp.run('config', []);
check('the map name reached the setup', interp.rt.setup.mapName, 'A Lua map');
check('the player count did too', interp.rt.setup.numPlayers, 2);
check('and start location 0', JSON.stringify(interp.rt.setup.startLocations.get(0)), JSON.stringify({ x: 100, y: 200 }));

console.log('\n--- waits are coroutine yields ---');
interp.run('sleeper', []);
check('the thread ran up to its first wait', call('sleptSoFar').n, 1);
interp.advanceTime(1.0);
check('still asleep after 1 s', call('sleptSoFar').n, 1);
interp.advanceTime(1.5);
check('awake after 2 s, and asleep again', call('sleptSoFar').n, 11);
interp.advanceTime(1.5);
check('finished after the second wait', call('sleptSoFar').n, 111);

console.log('\n--- a Lua function is a `code` value ---');
check('the same function is the same value', call('sameFunctionTwice').b, true);
const trig = call('makeTrigger');
call('fireIt', [trig]);
check('a Lua trigger action fired', call('firedCount').n, 1);
call('fireIt', [trig]);
check('…and fires again', call('firedCount').n, 2);

if (notes.length) {
  console.log('\nnotes while loading:');
  for (const n of [...new Set(notes)].slice(0, 10)) console.log('   ' + n);
}
console.log(failures ? `\n${failures} failure(s).` : '\nAll Lua checks passed.');
process.exit(failures ? 1 : 0);
