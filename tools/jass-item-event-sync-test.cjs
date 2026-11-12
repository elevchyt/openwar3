// Item events an INVENTORY native causes fire from inside the native (NativeCtx.flushItemEvents),
// a script function that WAITS suspends the expression that called it (Interpreter.evalG), and
// an item's player is the item's own (GetItemPlayer / SetItemPlayer).
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-item-event-sync-test.cjs
//
// The three together are DotA AI's shopping, and each alone left its computers on the six
// items they started with:
//
//     call DisableTrigger(pickup)                     -- the dummy -> real item swap
//     set it = UnitAddItemById(hero, realItem)
//     call EnableTrigger(pickup)
//
//     set ok = Buy(hero, item)                        -- Buy() hands the dummy over, then
//                                                     -- polls a flag with TriggerSleepAction
//     if GetItemPlayer(it) == buyer then              -- "have I already paid for this?"
//
// Run against a stand-in sim that queues item events the way SimWorld does.
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

// The stand-in sim: items are numbers, a pickup queues an event, as SimWorld.noteItem does.
const unit = (id) => ({ id, typeId: 'Hpal', owner: 1, x: 0, y: 0, facing: 0 });
let nextItem = 100;
const types = new Map();
let queue = [];
const hooks = {
  createItem: (typeId) => { const id = nextItem++; types.set(id, typeId); return id; },
  itemInfo: (id) => (types.has(id) ? { id, typeId: types.get(id), charges: 0, x: 0, y: 0, holder: 0, slot: -1, owner: 15, life: 1 } : null),
  getUnitX: () => 0,
  getUnitY: () => 0,
  unitAddItem: (u, itemId) => { queue.push({ unit: unit(u), item: { id: itemId, typeId: types.get(itemId), charges: 0 }, phase: 'pickup' }); return true; },
  drainItemEvents: () => { const out = queue; queue = []; return out; },
};
const src = `
globals
    trigger pickup = null
    unit hero = null
    integer picked = 0
    integer flag = 0
    integer seenInside = -1
    integer bought = 0
    boolean ok = false
    item last = null
endglobals
function OnPickup takes nothing returns nothing
    set picked = picked + 1
    set flag = 1
    if GetItemTypeId(GetManipulatedItem()) == 'I001' then
        // the dummy: swap it for the real item, behind the guard
        call DisableTrigger(pickup)
        set last = UnitAddItemById(hero, 'I002')
        call EnableTrigger(pickup)
    endif
endfunction
function Setup takes unit h returns nothing
    set hero = h
    set pickup = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(pickup, Player(1), EVENT_PLAYER_UNIT_PICKUP_ITEM, null)
    call TriggerAddAction(pickup, function OnPickup)
endfunction
function AddThenLook takes nothing returns nothing
    call UnitAddItem(hero, CreateItem('I003', 0, 0))
    set seenInside = picked
endfunction
function Buy takes integer id returns boolean
    set flag = 0
    call UnitAddItem(hero, CreateItem(id, 0, 0))
    call TriggerSleepAction(0.1)
    return flag != 0
endfunction
function Shop takes nothing returns nothing
    set ok = Buy('I001')
    set bought = bought + 1
endfunction
function StartShop takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerAddAction(t, function Shop)
    call TriggerExecute(t)
endfunction
function Stamp takes nothing returns integer
    local item it = CreateItem('I004', 0, 0)
    local integer before = GetPlayerId(GetItemPlayer(it))
    call SetItemPlayer(it, Player(3), true)
    call UnitAddItem(hero, it)
    return before * 100 + GetPlayerId(GetItemPlayer(it))
endfunction
`;
const interp = buildInterpreter([common, src], { hooks });
const rt = interp.rt;
const g = (n) => { const v = rt.globals.get(n); return v?.n ?? v?.b; };
interp.callFunction('Setup', [rt.unitForSim(unit(21))]);

console.log('the event precedes the native\'s return');
interp.callFunction('AddThenLook', []);
check('EVENT_PLAYER_UNIT_PICKUP_ITEM had fired by the line after UnitAddItem', g('seenInside'), 1);
check('…and nothing is left for the frame to raise', queue.length, 0);

console.log('\na guarded swap');
const before = g('picked');
// The dummy's pickup hands over the real item with the trigger off: one pickup, not two.
hooks.unitAddItem(21, hooks.createItem('I001'));
interp.pumpItemEvents(hooks.drainItemEvents());
check('the real item\'s pickup arrived while the trigger was disabled', g('picked') - before, 1);

console.log('\na function that waits, called from an expression');
interp.callFunction('StartShop', []);
check('the caller is suspended with it — the line after `set ok = Buy()` has not run', [g('bought'), g('ok')], [0, false]);
for (let i = 0; i < 3; i++) interp.advanceTime(0.2);
check('…and runs, with the function\'s own answer, once it returns', [g('bought'), g('ok')], [1, true]);

console.log('\nan item\'s player');
const stamp = interp.callFunction('Stamp', []);
check('Neutral Passive from birth, the stamp afterwards, whoever holds it', stamp?.n, 15 * 100 + 3);

console.log(failures ? `\n${failures} FAILED` : '\nall item-event checks passed');
process.exit(failures ? 1 : 0);
