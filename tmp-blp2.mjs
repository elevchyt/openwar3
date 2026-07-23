import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { Archive } = require('mdx-m3-viewer/dist/cjs/parsers/mpq');
const { BlpImage } = require('mdx-m3-viewer/dist/cjs/parsers/blp/image');
const WC3='C:/Users/Owner/Documents/GitHub/openwar3/Warcraft III'; const S=String.fromCharCode(92);
function open(n){const b=readFileSync(join(WC3,n));const u=new Uint8Array(b.byteLength);u.set(b);const a=new Archive();a.load(u,true);return a;}
const path='Abilities'+S+'Spells'+S+'Other'+S+'Aneu'+S+'MercArrow.blp';
const a=open('War3.mpq'); const f=a.get(path);
const img=new BlpImage(); img.load(f.bytes());
const d=img.getMipmap(0);
console.log('size',d.width,d.height);
// write PPM-ish PNG via raw + ffmpeg
writeFileSync('C:/Users/Owner/AppData/Local/Temp/claude/MercArrow.rgba', Buffer.from(d.data.buffer ?? d.data));
