// Headless check of voice chat's pure half (src/game/voice.ts, issue #133): who hears a talker
// and that a slice survives the wire. Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const v = require(join(REPO, ".sim-build", "src", "game", "voice.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

// 0,1 allied; 2,3 allied; 4 is a watcher.
const team = { 0: 0, 1: 0, 2: 1, 3: 1 };
const world = {
  players: () => [0, 1, 2, 3, 4],
  coAllied: (a, b) => team[a] !== undefined && team[a] === team[b],
  isObserver: (p) => p === 4,
};

check("allies hear an ally, and the talker", v.voiceRecipients(0, false, world), [0, 1]);
check("enemies hear nothing on the allies channel", v.voiceRecipients(2, false, world).includes(0), false);
check("All Talk: everybody hears (the bench listens to All chat too)", v.voiceRecipients(0, true, world), [0, 1, 2, 3, 4]);
check("a watcher reaches only the watchers, All Talk or not", v.voiceRecipients(4, true, world), [4]);

// µ-law: every code round-trips to itself (the decoder is the inverse of the encoder).
let bad = 0;
for (let b = 0; b < 256; b++) if (v.muLawEncode(v.muLawDecode(b)) !== b && !(b === 0x7f)) bad++; // 0x7f/0xff are the two zeros
check("µ-law codes round-trip", bad, 0);

// A 440 Hz tone at 48 kHz, 2048 samples, survives encode → base64 → decode within µ-law error.
const n = 2048, tone = new Float32Array(n);
for (let i = 0; i < n; i++) tone[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / 48000);
const bytes = v.encodeVoice(tone, 48000);
check("48 kHz → 16 kHz is a third as long", bytes.length, Math.floor(n / 3));
const back = v.decodeVoice(v.voiceFromBase64(v.voiceToBase64(bytes)));
let worst = 0;
for (let i = 0; i < back.length; i++) {
  const ref = 0.6 * Math.sin((2 * Math.PI * 440 * ((i + 0.5) * 3 - 0.5)) / 48000); // box average sits mid-window
  worst = Math.max(worst, Math.abs(back[i] - ref));
}
check("tone comes back within 0.03 of full scale", worst < 0.03, true);

// Talkers: order of first speech, and a hold before a talker is dropped.
const t = new v.Talkers();
t.heard(2, 0); t.heard(1, 0.1); t.heard(2, 0.2);
check("talkers keep the order they began in", t.active(0.25), [2, 1]);
check("a talker goes quiet after the hold", t.active(0.2 + v.VOICE_HOLD_SECS + 0.01), []);

if (failed) { console.log(`\n${failed} check(s) failed.`); process.exit(1); }
console.log("\nvoice ok.");
