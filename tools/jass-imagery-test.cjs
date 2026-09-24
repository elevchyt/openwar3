// The world-painting natives' JASS half (src/jass/natives/imagery.ts — docs/map-compatibility.md
// pass 10): ubersplats, images, terrain tiles and the water tint. That each reaches its hook with
// the right arguments, and that the documented refusals and no-ops hold (lep.nrw/jassbot):
//   * CreateImage with imageType 0 "return[s] image(-1)", and a texture that is not there too;
//   * SetImageRender "does not work", ResetUbersplat / FinishUbersplat "do nothing";
//   * SetWaterBaseColor takes each channel "mod 256";
//   * a terrain type crosses as its four-letter tile id both ways.
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-imagery-test.cjs
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

const calls = [];
const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return ret; };
const hooks = {
  createUbersplat: (x, y, name, ...rest) => { calls.push(['splat', x, y, name, ...rest]); return name === 'THND' ? 3 : -1; },
  destroyUbersplat: rec('splatDestroy'),
  showUbersplat: rec('splatShow'),
  setUbersplatRenderAlways: rec('splatAlways'),
  createImage: (file, ...rest) => { calls.push(['image', file, ...rest]); return file.endsWith('X.blp') ? 8 : -1; },
  destroyImage: rec('imageDestroy'),
  showImage: rec('imageShow'),
  setImageRenderAlways: rec('imageAlways'),
  setImageColor: rec('imageColor'),
  setImageConstantHeight: rec('imageZ'),
  setImagePosition: rec('imagePos'),
  setImageType: rec('imageType'),
  setWaterBaseColor: rec('water'),
  setSkyModel: rec('sky'),
  terrainTypeAt: (x) => (x > 0 ? 'Ldrt' : ''),
  terrainVarianceAt: () => 17,
  setTerrainType: rec('tile'),
  changeMinimapTerrainTex: (path) => { calls.push(['minimap', path]); return path.endsWith('miniMap.blp'); },
};

const SRC = `
globals
    ubersplat u = null
    ubersplat bad = null
    image i = null
endglobals
function Splats takes nothing returns nothing
    set u = CreateUbersplat(10.0, 20.0, "THND", 255, 128, 0, 300, true, false)
    set bad = CreateUbersplat(0.0, 0.0, "NOPE", 255, 255, 255, 255, false, false)
    call SetUbersplatRenderAlways(u, true)
    call ShowUbersplat(u, false)
    call ResetUbersplat(u)
    call FinishUbersplat(u)
    call DestroyUbersplat(bad)
    call DestroyUbersplat(u)
endfunction
function Images takes nothing returns nothing
    // DotA's own call: a 64-wide X centred on (x, y), type 2 (Indicator).
    set i = CreateImage("Fonts\\\\X.blp", 64.0, 64.0, 0.0, 100.0 - 32.0, 200.0 - 32.0, 0.0, 0.0, 0.0, 0.0, 2)
    call SetImageRenderAlways(i, true)
    call SetImageRender(i, false)
    call ShowImage(i, true)
    call SetImageColor(i, 255, 0, 0, 300)
    call SetImageConstantHeight(i, true, 90.0)
    call SetImagePosition(i, 5.0, 6.0, 7.0)
    call SetImageType(i, 4)
    call DestroyImage(i)
endfunction
function Type0 takes nothing returns boolean
    return CreateImage("Fonts\\\\X.blp", 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0) == null
endfunction
function Missing takes nothing returns boolean
    return CreateImage("NoSuch.blp", 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1) == null
endfunction
function Water takes nothing returns nothing
    call SetWaterBaseColor(0, 255, 256, 511)
endfunction
function Sky takes nothing returns nothing
    call SetSkyModel("Environment\\\\Sky\\\\LordaeronSummerSky\\\\LordaeronSummerSky.mdl")
    call SetSkyModel(null)
endfunction
function TileHere takes nothing returns boolean
    return GetTerrainType(100.0, 0.0) == 'Ldrt'
endfunction
function TileOff takes nothing returns integer
    return GetTerrainType(-100.0, 0.0)
endfunction
function Variance takes nothing returns integer
    return GetTerrainVariance(0.0, 0.0)
endfunction
function Minimap takes nothing returns boolean
    return BlzChangeMinimapTerrainTex("war3mapImported\\\\miniMap.blp")
endfunction
function NoMinimap takes nothing returns boolean
    return BlzChangeMinimapTerrainTex("nothing.blp")
endfunction
function Paint takes nothing returns nothing
    call SetTerrainTypeBJ(Location(1.0, 2.0), 'Nsnw', -1, 5, 0)
endfunction
`;

const quiet = [console.info, console.warn];
console.info = () => {};
console.warn = () => {};
const interp = buildInterpreter([common, blizzard, SRC], { hooks });
[console.info, console.warn] = quiet;
const call = (fn) => interp.callFunction(fn, []);

console.log('--- ubersplats ---');
call('Splats');
check('CreateUbersplat carries every argument, channels clamped to 0–255', J(calls[0]), J(['splat', 10, 20, 'THND', 255, 128, 0, 255, true, false]));
check('a row the table does not have is a null handle — no call reaches the engine for it', J(calls.slice(2).map((c) => c[0])), J(['splatAlways', 'splatShow', 'splatDestroy']));
check('RenderAlways', J(calls[2]), J(['splatAlways', 3, true]));
check('Show', J(calls[3]), J(['splatShow', 3, false]));
check('Reset and Finish do nothing, as documented; Destroy reaches it', J(calls[4]), J(['splatDestroy', 3]));

console.log('\n--- images ---');
calls.length = 0;
call('Images');
check('CreateImage: file, size, corner, origin and type — sizeZ dropped', J(calls[0]), J(['image', 'Fonts\\X.blp', 64, 64, 68, 168, 0, 0, 0, 0, 2]));
check('SetImageRenderAlways', J(calls[1]), J(['imageAlways', 8, true]));
check('SetImageRender does not work — the next call is ShowImage', J(calls[2]), J(['imageShow', 8, true]));
check('SetImageColor clamps to 0–255', J(calls[3]), J(['imageColor', 8, 255, 0, 0, 255]));
check('SetImageConstantHeight', J(calls[4]), J(['imageZ', 8, true, 90]));
check('SetImagePosition moves x and y', J(calls[5]), J(['imagePos', 8, 5, 6]));
check('SetImageType', J(calls[6]), J(['imageType', 8, 4]));
check('DestroyImage', J(calls[7]), J(['imageDestroy', 8]));
check('imageType 0 is image(-1)', call('Type0').b, true);
check('a texture that is not there is image(-1) too', call('Missing').b, true);

console.log('\n--- water and terrain ---');
calls.length = 0;
call('Water');
check('SetWaterBaseColor takes each channel mod 256', J(calls[0]), J(['water', 0, 255, 0, 255]));
calls.length = 0;
call('Sky');
// The GUI's own default is SkyModelNone — a NULL string (UI\TriggerData.txt) — which means "no sky".
check('SetSkyModel reaches the engine with the path as written, and null as ""', J(calls), J([['sky', 'Environment\\Sky\\LordaeronSummerSky\\LordaeronSummerSky.mdl'], ['sky', '']]));
check("GetTerrainType answers the tile's rawcode", call('TileHere').b, true);
check('…and 0 off the map', call('TileOff').n, 0);
check('GetTerrainVariance', call('Variance').n, 17);
calls.length = 0;
call('Paint');
check("SetTerrainTypeBJ reaches it with the tile id, -1, size and shape", J(calls[0]), J(['tile', 1, 2, 'Nsnw', -1, 5, 0]));

console.log('\n--- the minimap picture ---');
// Test of Balance's own call: its war3mapMap.blp is its lobby splash, and the real minimap is an
// import it hands back at init — the ReforgedMapPreviewReplacer habit.
calls.length = 0;
check('BlzChangeMinimapTerrainTex reaches the engine with the path', call('Minimap').b, true);
check('…exactly as the script spelled it', calls[0] && calls[0][1], 'war3mapImported\\miniMap.blp');
check('…and answers false for a picture that is not there', call('NoMinimap').b, false);

console.log(failures ? `\n${failures} failure(s).` : '\nAll imagery native checks passed.');
process.exit(failures ? 1 : 0);
