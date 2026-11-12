// A WATCHER is in the audience of anything said to more than one player (Runtime.watchers).
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-watcher-audience-test.cjs
//
// In WC3 an observer is a SLOT, so a map's own audience code reaches it. Ours sits one past
// the last slot — in no force a map builds and in no `for i = 0 to 11` loop — so it is given
// the membership by rule instead. The shapes below are DotA 6.77b AI's own:
//
//     if IsPlayerInForce(GetLocalPlayer(), f) then                  -- every kill line
//         call DisplayTimedTextToPlayer(GetLocalPlayer(), 0, 0, t, s)
//
// against a force its AI setup has emptied of every computer seat, and its "team is OWNING"
// line, handed to five seats one by one.
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
  console.error("Run `pnpm data:extract` first — this test reads the install's own common.j.");
  process.exit(2);
}
const common = new TextDecoder('windows-1252').decode(readFileSync(join(SCRIPTS, 'common.j')));

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
};

const src = `
globals
    force everyone = null
    force alone = null
endglobals
function Setup takes nothing returns nothing
    set everyone = CreateForce()
    call ForceAddPlayer(everyone, Player(1))
    call ForceAddPlayer(everyone, Player(2))
    call ForceAddPlayer(everyone, Player(7))
    set alone = CreateForce()
    call ForceAddPlayer(alone, Player(1))
endfunction
function ToForce takes force f, string s returns nothing
    if IsPlayerInForce(GetLocalPlayer(), f) then
        call DisplayTimedTextToPlayer(GetLocalPlayer(), 0, 0, 10, s)
    endif
endfunction
function Kill takes nothing returns nothing
    call ToForce(everyone, "pwned")
endfunction
function Whisper takes nothing returns nothing
    call ToForce(alone, "psst")
endfunction
function Prune takes nothing returns nothing
    call ForceRemovePlayer(everyone, Player(1))
    call ForceRemovePlayer(everyone, Player(2))
    call ForceRemovePlayer(everyone, Player(7))
endfunction
function Loop takes string s returns nothing
    local integer i = 1
    loop
        exitwhen i > 5
        call DisplayTimedTextToPlayer(Player(i), 0, 0, 10, s)
        set i = i + 1
    endloop
endfunction
function Owning takes nothing returns nothing
    call Loop("OWNING")
endfunction
function Private takes nothing returns nothing
    call DisplayTimedTextToPlayer(Player(3), 0, 0, 10, "not enough gold")
    call DisplayTimedTextToPlayer(Player(3), 0, 0, 10, "not enough gold")
endfunction
`;

const WATCHER = 16;
const boot = (watchers) => {
  const shown = [];
  const interp = buildInterpreter([common, src], { hooks: { displayText: (p, m) => void shown.push([p, m]) } });
  interp.rt.applyLobby([1, 2, 3, 4, 5, 7].map((index) => ({ index, raceIndex: 1, controller: 1, team: 0, startLocation: -1 })), WATCHER, watchers);
  interp.callFunction('Setup', []);
  const run = (fn) => { shown.length = 0; interp.callFunction(fn, []); return shown.filter(([p]) => p === WATCHER).map(([, m]) => m); };
  return { interp, run, shown };
};

console.log('a watcher');
{
  const { run, interp } = boot([WATCHER]);
  check('is told what a group force is told', run('Kill'), ['pwned']);
  check('…and not what one player is told', run('Whisper'), []);
  interp.callFunction('Prune', []);
  check('a force the map has emptied of its computers is still a group', run('Kill'), ['pwned']);
  check('a line handed out seat by seat is read once', run('Owning'), ['OWNING']);
  interp.rt.gameTime += 1;
  check('…and again when it is said again later', run('Owning'), ['OWNING']);
  interp.rt.gameTime += 1;
  check('a line repeated to ONE seat stays that seat\'s', run('Private'), []);
}

console.log('\nnobody watching');
{
  // The same machine as a seat that is simply not in the force: no membership by rule.
  const { run, shown } = boot([]);
  check('a player outside the force is outside it', run('Kill'), []);
  run('Owning');
  check('a seat-by-seat line reaches its five seats and nobody else', shown.map(([p]) => p), [1, 2, 3, 4, 5]);
}

console.log(failures ? `\n${failures} FAILED` : '\nall watcher-audience checks passed');
process.exit(failures ? 1 : 0);
