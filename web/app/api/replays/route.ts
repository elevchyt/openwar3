// The REPLAY COLLECTION's door (issue #158). The game's uploader (src/game/replayUpload.ts)
// POSTs every finished replay here when the player has "Share Replays" on, and this route
// files it in the project's PRIVATE Vercel Blob store — nothing in it is readable from the web.
//
// The request is the uploader's, unchanged: the replay's raw bytes plus three headers —
// `x-ow3-version` (OpenWar3's), `x-ow3-replay-format` (the FILE's, src/game/replay.ts
// REPLAY_FORMAT) and `x-ow3-install` (the anonymous install id, a random UUID). The game page
// is never on this origin — the desktop app serves itself from `127.0.0.1:<random port>`, a
// browser build from wherever it is hosted — so every answer carries open CORS headers and
// the preflight those custom headers cause is answered below.
//
// The door is anonymous by design (there is no account to sign), so what keeps junk out is
// the FILE: an OpenWar3 replay is "OW3R", a format number, then `[tag:4][length:u32 LE][gzip]`
// sections that tile the file exactly, HEAD first (src/game/replay.ts `encodeReplay`). A body
// that is not that shape is refused before anything is written. The status says whether the
// uploader should try again: a 4xx is final (it drops the file), a 5xx is not (it keeps it).
//
// Where a replay lands: `replays/<YYYY-MM-DD>/<install>_<version>-<random>.o3r`. The date is
// the day it ARRIVED (an offline player's queue arrives late); the install id groups one
// player's matches without saying who they are; the version says which build recorded it.

import { put } from "@vercel/blob";

export const runtime = "nodejs";

/** The largest replay accepted. A Vercel Function's request body stops at 4.5 MB; every section
 *  is gzip'd JSON, and a ten-minute two-player match is ~186 KB even in a dev build. Ours. */
const MAX_BYTES = 4 * 1024 * 1024;

/** The highest file format this door accepts. Generous on purpose: a newer client must not be
 *  refused for being newer, only for not being a replay. Ours. */
const MAX_FORMAT = 99;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const TAG = /^[A-Z]{4}$/;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-ow3-version, x-ow3-replay-format, x-ow3-install",
  "access-control-max-age": "86400",
};

function answer(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: CORS });
}

/** Why `bytes` is not an OpenWar3 replay, or null when it is one. */
function notAReplay(bytes: Uint8Array): string | null {
  if (bytes.length < 6 || bytes[0] !== 0x4f || bytes[1] !== 0x57 || bytes[2] !== 0x33 || bytes[3] !== 0x52) return "bad magic";
  const format = bytes[4] | (bytes[5] << 8);
  if (format < 1 || format > MAX_FORMAT) return "bad format";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 6;
  let first = true;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return "truncated section";
    const tag = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const len = view.getUint32(at + 4, true);
    if (!TAG.test(tag)) return "bad section tag";
    if (first && tag !== "HEAD") return "no header";
    // Every section body is gzip (RFC 1952 starts 1f 8b).
    if (len < 2 || bytes[at + 8] !== 0x1f || bytes[at + 9] !== 0x8b) return "bad section body";
    at += 8 + len;
    first = false;
  }
  return at === bytes.length && !first ? null : "sections do not tile the file";
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return answer(413, { error: "too large" });

  const install = req.headers.get("x-ow3-install") ?? "";
  const version = req.headers.get("x-ow3-version") ?? "";
  // "unknown" is what `installId()` answers when the page has no localStorage.
  if (install !== "unknown" && !UUID.test(install)) return answer(400, { error: "bad install id" });
  if (!VERSION.test(version)) return answer(400, { error: "bad version" });

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_BYTES) return answer(413, { error: "too large" });
  const why = notAReplay(bytes);
  if (why) return answer(400, { error: why });
  const format = bytes[4] | (bytes[5] << 8);
  if (req.headers.get("x-ow3-replay-format") !== String(format)) return answer(400, { error: "format header disagrees with the file" });

  const day = new Date().toISOString().slice(0, 10);
  try {
    await put(`replays/${day}/${install.toLowerCase()}_${version}.o3r`, Buffer.from(bytes), {
      access: "private",
      addRandomSuffix: true,
      contentType: "application/octet-stream",
    });
  } catch (e) {
    console.error("replay upload failed", e);
    return answer(503, { error: "storage unavailable" });
  }
  return answer(201, { ok: true });
}
