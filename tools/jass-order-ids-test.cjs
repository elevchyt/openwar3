// Order ids are the ENGINE's (src/jass/orders.ts, src/jass/orderIds.ts).
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-order-ids-test.cjs
//
// `OrderId("blizzard")` is 852089 in every Warcraft III, and a script may write the number
// instead of the name. Hand-written and optimised scripts do: the install's own
// `Maps\Download\DotA v6.77b AI` issues orders by raw id more than a thousand times and drives
// its whole AI off comparisons like `GetUnitCurrentOrder(u) < 852000`. While every ability
// order was a number we MINTED, each of those was an order nobody recognised — a point order
// degraded to a plain move, so the computers' heroes walked at whatever they meant to cast on
// — and each comparison was against a number from the wrong space.
//
// What is pinned here:
//   • the vocabulary: names ↔ the real ids, both ways, with a string the engine never numbered
//     still getting a stable id of its own;
//   • the ISSUE natives hand the bridge the order's STRING for a raw id, which is what the sim
//     matches an ability by;
//   • the inventory's string-less orders (852008–852013 use a slot, 852002–852007 drag to one);
//   • `IssueNeutralImmediateOrderById` — a purchase on a player's behalf — reaches its hook
//     with the buyer, the shop and the ware, and answers what the hook answers;
//   • `GetOrderTargetItem` for an order aimed at an item.
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
const orders = require(join(BUILD, 'jass', 'orders.js'));

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

console.log('the vocabulary');
check('attack keeps its id', orders.orderStringToId('attack'), 851983);
check('smart keeps its id', orders.orderStringToId('smart'), 851971);
check('blizzard is the engine\'s 852089', orders.orderStringToId('blizzard'), 852089);
check('channel is 852600', orders.orderStringToId('channel'), 852600);
check('…case and padding do not matter', orders.orderStringToId('  ThunderBolt '), 852095);
check('852089 reads back as blizzard', orders.orderIdToString(852089), 'blizzard');
check('852218 is carrionswarm', orders.orderIdToString(852218), 'carrionswarm');
check('a number that names no order has no string', orders.orderIdToString(852008), '');
const minted = orders.orderStringToId('amapsownorder');
check('a string the engine never numbered is minted above the engine\'s block', minted > 0xd0fff, true);
check('…stably', orders.orderStringToId('amapsownorder'), minted);
check('…and reads back', orders.orderIdToString(minted), 'amapsownorder');
check('an ability order is one', orders.isAbilityOrder(852089), true);
check('…a generic order is not', orders.isAbilityOrder(851983), false);
check('…nor is a number that names nothing', orders.isAbilityOrder(852008), false);
check('852008 uses slot 0', orders.itemUseSlot(852008), 0);
check('852013 uses slot 5', orders.itemUseSlot(852013), 5);
check('852014 uses no slot', orders.itemUseSlot(852014), -1);
check('852002 drags to slot 0', orders.itemDragSlot(852002), 0);
check('852008 is not a drag', orders.itemDragSlot(852008), -1);

console.log('\nthe natives');
const issued = [];
const neutral = [];
const hooks = {
  issueUnitOrder: (unitId, orderId, order, kind, x, y, targetId) => (issued.push({ unitId, orderId, order, kind, x, y, targetId }), order !== 'refuseme'),
  issueNeutralOrder: (player, shopId, orderId, kind) => (neutral.push({ player, shopId, orderId, kind }), orderId === 0x68666f6f /* 'hfoo' */),
};
const src = `
globals
    integer seenOrder = 0
    integer seenItemType = 0
    boolean seenWidget = false
endglobals
function Ids takes nothing returns boolean
    return OrderId("blizzard") == 852089 and OrderId("attack") == 851983 and OrderId2String(852600) == "channel"
endfunction
function PointById takes unit u returns boolean
    return IssuePointOrderById(u, 852089, 10., 20.)
endfunction
function ImmediateById takes unit u returns boolean
    return IssueImmediateOrderById(u, 852008)
endfunction
function ByName takes unit u, unit t returns boolean
    return IssueTargetOrder(u, "thunderbolt", t)
endfunction
function Buy takes unit shop returns boolean
    return IssueNeutralImmediateOrderById(Player(3), shop, 'hfoo')
endfunction
function BuyRefused takes unit shop returns boolean
    return IssueNeutralImmediateOrderById(Player(3), shop, 'hpea')
endfunction
function OnOrder takes nothing returns nothing
    set seenOrder = GetIssuedOrderId()
    set seenItemType = GetItemTypeId(GetOrderTargetItem())
    set seenWidget = GetOrderTarget() != null
endfunction
function Listen takes nothing returns nothing
    local trigger t = CreateTrigger()
    call TriggerRegisterPlayerUnitEvent(t, Player(1), EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER, null)
    call TriggerAddAction(t, function OnOrder)
endfunction
`;
const interp = buildInterpreter([common, src], { hooks });
const rt = interp.rt;
const g = (n) => rt.globals.get(n);
const u = rt.unitForSim({ id: 11, typeId: 'Hpal', owner: 1, x: 0, y: 0, facing: 0 });
const t = rt.unitForSim({ id: 12, typeId: 'hfoo', owner: 2, x: 5, y: 5, facing: 0 });
const shop = rt.unitForSim({ id: 13, typeId: 'ngme', owner: 15, x: 9, y: 9, facing: 0 });

check('OrderId / OrderId2String answer with the engine\'s numbers', interp.callFunction('Ids', []).b, true);
check('a raw-id point order is issued', interp.callFunction('PointById', [u]).b, true);
check('…carrying the order\'s STRING for the sim to match an ability by', issued.at(-1), { unitId: 11, orderId: 852089, order: 'blizzard', kind: 'point', x: 10, y: 20, targetId: 0 });
interp.callFunction('ImmediateById', [u]);
check('a string-less order travels by its number alone', issued.at(-1), { unitId: 11, orderId: 852008, order: '', kind: 'immediate', x: 0, y: 0, targetId: 0 });
interp.callFunction('ByName', [u, t]);
check('an order by NAME carries the same number a script would write', issued.at(-1), { unitId: 11, orderId: 852095, order: 'thunderbolt', kind: 'target', x: 0, y: 0, targetId: 12 });

check('a neutral purchase answers what the sale answered', interp.callFunction('Buy', [shop]).b, true);
check('…and was asked of the shop, for the buyer, for that ware', neutral.at(-1), { player: 3, shopId: 13, orderId: 0x68666f6f, kind: 'immediate' });
check('a refused sale answers false', interp.callFunction('BuyRefused', [shop]).b, false);

console.log('\nan order aimed at an item');
interp.callFunction('Listen', []);
interp.pumpOrderEvents([{
  unit: { id: 11, typeId: 'Hpal', owner: 1, x: 0, y: 0, facing: 0 }, orderId: 851971, kind: 'target', x: 0, y: 0, target: null,
  item: { id: 77, typeId: 'ratc', charges: 0, x: 3, y: 4 },
}]);
check('GetIssuedOrderId is smart', g('seenOrder')?.n, 851971);
check('GetOrderTargetItem is the item', g('seenItemType')?.n, 0x72617463 /* 'ratc' */);
check('…and GetOrderTarget, the widget, is it too', g('seenWidget')?.b, true);

console.log(failures ? `\n${failures} FAILED` : '\nall order-id checks passed');
process.exit(failures ? 1 : 0);
