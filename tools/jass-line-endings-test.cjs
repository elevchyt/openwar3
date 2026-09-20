// JASS line endings (src/jass/lexer.ts).
//
//   npx tsc -p tools/tsconfig.jass.json && node tools/jass-line-endings-test.cjs
//
// JASS is LINE-ORIENTED, so the line terminator is a token and not whitespace, and all three
// conventions have to produce exactly one of it. The third one is why this test exists: a map
// PROTECTOR re-emits the script it rewrites, and at least one writes bare `\r` — four of the
// eleven maps in a stock install's own `Maps\Download` are like that. Dropping `\r` as
// whitespace made such a file ONE logical line, and the parse then "succeeded" with nothing in
// it: no error anywhere, `config` and `main` unknown, and the match opened on an empty world.
//
// Reads only the developer's own local install for the corpus half (gitignored; zero shipped assets).

const { readFileSync, readdirSync, existsSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');
const BUILD = join(REPO, '.jass-build', 'src', 'jass');
if (!existsSync(join(BUILD, 'parser.js'))) {
  console.error('Build first:  npx tsc -p tools/tsconfig.jass.json');
  process.exit(2);
}
writeFileSync(join(REPO, '.jass-build', 'package.json'), '{"type":"commonjs"}');
const { parseJass } = require(join(BUILD, 'parser.js'));
const { tokenize } = require(join(BUILD, 'lexer.js'));

let failures = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (want ${want})`}`);
};

// The same three-line program, written three ways.
const LINES = [
  'globals',
  '    integer counter = 0',
  'endglobals',
  'function Add takes integer n returns integer',
  '    set counter = counter + n',
  '    return counter',
  'endfunction',
  '// a comment, which ends at the end of ITS line and not at the end of the file',
  'function Twice takes integer n returns integer',
  '    return Add(n) + Add(n)',
  'endfunction',
];
const forms = { LF: LINES.join('\n'), CRLF: LINES.join('\r\n'), CR: LINES.join('\r') };

console.log('--- all three terminators parse the same program ---');
for (const [name, src] of Object.entries(forms)) {
  const ast = parseJass(src);
  check(`${name}: two functions`, (ast.functions || []).length, 2);
  check(`${name}: one global`, (ast.globals || []).length, 1);
}

console.log('\n--- and produce the same tokens ---');
const counts = Object.fromEntries(Object.entries(forms).map(([k, v]) => [k, tokenize(v).length]));
check('CRLF is ONE separator, not two', counts.CRLF, counts.LF);
check('a bare CR is a separator too', counts.CR, counts.LF);

console.log('\n--- a comment ends at any of them ---');
// If the comment scanner stopped only at `\n`, everything after it in a bare-CR file would be
// swallowed and the second function would vanish.
check('the function after a comment survives a bare CR', (parseJass(forms.CR).functions || []).map((f) => f.name).join(','), 'Add,Twice');

console.log('\n--- every map in the install still parses to something ---');
const mpqMod = require('mdx-m3-viewer/dist/cjs/parsers/mpq');
const MpqArchive = (mpqMod.default ?? mpqMod).Archive;
const SEP = String.fromCharCode(92);
const decode = (b) => new TextDecoder('windows-1252').decode(b);
const dir = join(REPO, 'Warcraft III', 'Maps', 'Download');
if (!existsSync(dir)) {
  console.log('    (no Maps\\Download to read — skipped)');
} else {
  for (const f of readdirSync(dir).filter((x) => /\.w3[xm]$/i.test(x))) {
    let src = null;
    try {
      const buf = readFileSync(join(dir, f));
      const bytes = new Uint8Array(buf.byteLength);
      bytes.set(buf);
      const a = new MpqArchive();
      a.load(bytes, true);
      const o = a.get('war3map.j') ?? a.get(`scripts${SEP}war3map.j`);
      if (!o) continue;
      src = decode(o.bytes());
    } catch { continue; }
    const n = (parseJass(src).functions || []).length;
    const ok = n > 0;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${f}: ${n} function(s)`);
  }
}

console.log(failures ? `\n${failures} failure(s).` : '\nAll line-ending checks passed.');
process.exit(failures ? 1 : 0);
