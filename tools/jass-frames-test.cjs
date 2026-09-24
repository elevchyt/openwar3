// The map's own FRAMES — the model (compat/frames.ts) and the tree the drawing is built from
// (ui/scriptFrameTree.ts) — driven the way Test of Balance's InitMB drives them.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-frames-test.cjs
//
// The map's own .toc/.fdf pair is reproduced here as text (it is the stock "BoxedText" tooltip
// box the Hive's UI tutorials hand out), so the test needs nothing from any archive. It pins:
// a stamped template's NAMED children are frames the script finds by name; SetAllPoints covers
// a frame without reparenting it; a registered frame event fires with the frame and the player
// in scope; and the tree puts every frame where the API says — absolute points in the centred
// 4:3 box, a scale applied to size, font and offsets, the template's own anchors renamed per
// instance.
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
const { COMPAT_PRELUDE } = require(join(BUILD, 'compat', 'prelude.js'));
const { frameModel } = require(join(BUILD, 'compat', 'frames.js'));
const { buildScriptFrameTree, SCRIPT_UI_43 } = require(join(BUILD, 'ui', 'scriptFrameTree.js'));

const SCRIPTS = join(REPO, 'Warcraft III', 'ExtractedData', 'merged', 'Scripts');
if (!existsSync(join(SCRIPTS, 'common.j'))) {
  console.error("Run `pnpm data:extract` first — this test reads the install's own common.j.");
  process.exit(2);
}
const decode = (b) => new TextDecoder('windows-1252').decode(b);
const common = decode(readFileSync(join(SCRIPTS, 'common.j')));
const blizzard = decode(readFileSync(join(SCRIPTS, 'Blizzard.j')));

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
};

const FILES = {
  'BoxedText.toc': 'BoxedText.fdf\r\n\r\n',
  'BoxedText.fdf': `
Frame "BACKDROP" "BoxedTextBackgroundTemplate" {
    DecorateFileNames,
    BackdropBackground "ToolTipBackground",
    BackdropCornerSize 0.008,
    BackdropEdgeFile "ToolTipBorder",
}
Frame "BACKDROP" "BoxedText" INHERITS "BoxedTextBackgroundTemplate" {
    UseActiveContext,
    Frame "TEXT" "BoxedTextTitle" {
        UseActiveContext,
        SetPoint TOPLEFT, "BoxedText", TOPLEFT, 0.005, -0.005,
        SetPoint TOPRIGHT, "BoxedText", TOPRIGHT, -0.005, -0.005,
        FrameFont "MasterFont", 0.014, "",
    }
    Frame "TEXT" "BoxedTextValue" {
        UseActiveContext,
        SetPoint TOPLEFT, "BoxedText", TOPLEFT, 0.005, -0.02,
    }
}
`,
};
const hides = [];
const hooks = {
  readMapFile: (p) => (p in FILES ? new TextEncoder().encode(FILES[p]) : null),
  hideOriginFrames: (h) => hides.push(['origin', h]),
  setConsoleBackdropVisible: (v) => hides.push(['backdrop', v]),
};

const SRC = `
globals
    framehandle panel = null
    framehandle icon = null
    framehandle hover = null
    framehandle tip = null
    framehandle title = null
    framehandle button = null
    integer clicks = 0
    integer clicker = -1
    boolean sameFrame = false
endglobals
function Setup takes nothing returns boolean
    local boolean loaded = BlzLoadTOCFile("BoxedText.toc")
    set panel = BlzCreateFrameByType("BACKDROP", "", BlzGetFrameByName("ConsoleUIBackdrop", 0), "", 0)
    call BlzFrameSetAbsPoint(panel, FRAMEPOINT_TOPLEFT, 0.601, 0.512)
    call BlzFrameSetSize(panel, 0.33, 0.1)
    call BlzFrameSetTexture(panel, "Textures/Black32", 0, true)
    set icon = BlzCreateFrameByType("BACKDROP", "", panel, "", 0)
    call BlzFrameSetAbsPoint(icon, FRAMEPOINT_TOPLEFT, 0.686, 0.486)
    call BlzFrameSetSize(icon, 0.013, 0.013)
    set hover = BlzCreateFrameByType("FRAME", "", icon, "", 0)
    call BlzFrameSetAllPoints(hover, icon)
    set tip = BlzCreateFrame("BoxedText", icon, 0, 0)
    call BlzFrameSetTooltip(hover, tip)
    call BlzFrameSetPoint(tip, FRAMEPOINT_RIGHT, icon, FRAMEPOINT_LEFT, -0.002, 0)
    call BlzFrameSetScale(tip, 0.85)
    set title = BlzGetFrameByName("BoxedTextTitle", 0)
    call BlzFrameSetText(title, "Wind Walk Lvl 1")
    set button = BlzCreateFrameByType("BUTTON", "", BlzGetFrameByName("ConsoleUIBackdrop", 0), "", 0)
    return loaded
endfunction
function OnClick takes nothing returns nothing
    set clicks = clicks + 1
    set clicker = GetPlayerId(GetTriggerPlayer())
    set sameFrame = BlzGetTriggerFrame() == button
endfunction
function Wire takes nothing returns nothing
    local trigger t = CreateTrigger()
    call BlzTriggerRegisterFrameEvent(t, button, FRAMEEVENT_CONTROL_CLICK)
    call TriggerAddAction(t, function OnClick)
endfunction
function TitleIsChild takes nothing returns boolean
    return title != null and title != tip and BlzFrameGetParent(title) == tip
endfunction
function HoverKeepsParent takes nothing returns boolean
    return BlzFrameGetParent(hover) == icon
endfunction
function Loose takes nothing returns nothing
    call BlzFrameSetAbsPoint(BlzCreateFrameByType("BACKDROP", "", BlzGetOriginFrame(ORIGIN_FRAME_GAME_UI, 0), "", 0), FRAMEPOINT_TOPLEFT, 0.9, 0.5)
    call BlzFrameSetAbsPoint(BlzCreateFrameByType("SIMPLEFRAME", "", BlzGetOriginFrame(ORIGIN_FRAME_GAME_UI, 0), "", 0), FRAMEPOINT_TOPLEFT, 0.9, 0.4)
endfunction
function Hides takes nothing returns nothing
    call BlzHideOriginFrames(true)
    call BlzFrameSetVisible(BlzGetFrameByName("ConsoleUIBackdrop", 0), false)
    call BlzHideOriginFrames(false)
endfunction
function NoToc takes nothing returns boolean
    return BlzLoadTOCFile("Missing.toc")
endfunction
`;

const realInfo = console.info;
console.info = () => {};
const interp = buildInterpreter([common, COMPAT_PRELUDE, blizzard, SRC], { hooks, blzIndexBase: 0 });
console.info = realInfo;
const call = (fn) => interp.callFunction(fn, []);
const g = (n) => interp.rt.globals.get(n);

console.log('--- the model ---');
check("the map's .toc loads", call('Setup').b, true);
check('a .toc that is not there answers false', call('NoToc').b, false);
check("a stamped template's named child is a frame of its own, parented as the file nests it", call('TitleIsChild').b, true);
check('SetAllPoints covers a frame and does NOT reparent it', call('HoverKeepsParent').b, true);
const model = frameModel(interp.rt);
check('…and the title carries its text', model.frames.get(g('title').h).text, 'Wind Walk Lvl 1');
check('a text change is a TEXT change: named, and patched rather than rebuilt', model.textChanged.has(g('title').h), true);

console.log('\n--- frame events ---');
call('Wire');
interp.fireFrameEvent(g('button').h, 1, 2);
check('a click fires the trigger registered on that frame', g('clicks').n, 1);
check('…with GetTriggerPlayer the player who clicked', g('clicker').n, 2);
check('…and BlzGetTriggerFrame the frame', g('sameFrame').b, true);
interp.fireFrameEvent(g('button').h, 2, 2);
check('a mouse-enter is not a click', g('clicks').n, 1);
interp.fireFrameEvent(g('panel').h, 1, 2);
check('a click on another frame fires nothing', g('clicks').n, 1);

console.log('\n--- the tree the drawing mounts ---');
const tree = buildScriptFrameTree(model, model.lib);
const find = (n, name) => (n.name === name ? n : n.children.map((c) => find(c, name)).find(Boolean));
const prop = (n, key) => n?.props.filter((p) => p.key === key).map((p) => p.args.map((a) => (a.n ?? a.s)));
const panelName = tree.names.get(g('panel').h);
const panelNode = find(tree.root, panelName);
check('a frame hung on ConsoleUIBackdrop is a top-level frame of the tree', tree.root.children.some((c) => c.name === panelName), true);
check('an absolute point is measured in the centred 4:3 box', prop(panelNode, 'SetPoint'), [['TOPLEFT', SCRIPT_UI_43, 'BOTTOMLEFT', 0.601, 0.512]]);
check('a script texture is a stretched picture, slashes turned round', [prop(panelNode, 'BackdropBackground'), prop(panelNode, 'BackdropBlendAll')], [[['Textures\\Black32']], [[]]]);
const tipName = tree.names.get(g('tip').h);
const tipNode = find(tree.root, tipName);
check('the stamped box sits under the frame it was created on', find(find(tree.root, tree.names.get(g('icon').h)), tipName) !== undefined, true);
check('its anchor is the script\'s, its offsets scaled', prop(tipNode, 'SetPoint'), [['RIGHT', tree.names.get(g('icon').h), 'LEFT', -0.002 * 0.85, 0]]);
const titleNode = find(tipNode, tree.names.get(g('title').h));
check("the template's inner anchors follow the per-instance rename, offsets scaled",
  prop(titleNode, 'SetPoint')[0], ['TOPLEFT', tipName, 'TOPLEFT', 0.005 * 0.85, -0.005 * 0.85]);
check('…and its font too', prop(titleNode, 'FrameFont')[0][1], 0.014 * 0.85);
check("the title's text is handed over as a literal override", tree.texts[titleNode.name], 'Wind Walk Lvl 1');
check('the tooltip is known as a tooltip of the hover frame', tree.tooltips, [{ owner: tree.names.get(g('hover').h), tip: tipName }]);
check('the hover frame and the button are listened on; the button takes clicks',
  tree.listen.map((l) => [l.name, l.button, l.events]).sort(),
  [[tree.names.get(g('button').h), true, [1]], [tree.names.get(g('hover').h), false, []]].sort());
const hoverNode = find(tree.root, tree.names.get(g('hover').h));
check('SetAllPoints is two opposite corners on the frame it covers', prop(hoverNode, 'SetPoint'),
  [['TOPLEFT', tree.names.get(g('icon').h), 'TOPLEFT', 0, 0], ['BOTTOMRIGHT', tree.names.get(g('icon').h), 'BOTTOMRIGHT', 0, 0]]);

console.log('\n--- the 4:3 box, and the game frames a map hides ---');
call('Loose');
const tree2 = buildScriptFrameTree(model, model.lib);
const box = tree2.root.children.find((c) => c.name === SCRIPT_UI_43);
check('the clipped box is the 4:3 one', tree2.clipped, SCRIPT_UI_43);
check('a BACKDROP on the plain game UI is drawn INSIDE it (held to 4:3)', box.children.some((c) => c.type === 'BACKDROP'), true);
check('a SIMPLEFRAME is free of it', tree2.root.children.some((c) => c.type === 'SIMPLEFRAME'), true);
check('…and so is a frame on ConsoleUIBackdrop', tree2.root.children.some((c) => c.name === tree2.names.get(g('panel').h)), true);
call('Hides');
check('BlzHideOriginFrames and ConsoleUIBackdrop reach the screen', JSON.stringify(hides), JSON.stringify([['origin', true], ['backdrop', false], ['origin', false]]));

console.log(failures ? `\n${failures} failure(s).` : '\nAll frame checks passed.');
process.exit(failures ? 1 : 0);
