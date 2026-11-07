// The map sites' fetch — what the page cannot reach on its own (src/ui/mapSites.ts).
//
// A page cannot read EpicWar: it serves no CORS headers, so a search result or a map file is a
// response the page is never handed. The desktop app's main process (electron/main.mjs) and the
// dev server (tools/vite-plugin-mapsite-proxy.ts) have no such rule, and both call THIS, so the
// one list of what may be fetched lives in one place.
//
// It is NOT an open proxy. The page names a URL, and the URL is refused unless it is on a host
// below AND under its path — the EpicWar listing and its map pages, and the object store its
// download links redirect to. Every redirect is followed by hand and checked the same way, so a
// link cannot bounce the fetch anywhere else. Hive Workshop and wc3maps are not here at all: both
// sit behind a Cloudflare bot check that a plain fetch is (rightly) refused by, so the game OPENS
// them for the player instead of reading them.
//
// Nothing is kept here: bytes go straight back to the page, which keeps a map the way it keeps a
// LAN download (src/assets/downloadedMaps.ts).

/** Hosts and the path each may be fetched under. */
const ALLOWED = [
  { host: "www.epicwar.com", path: /^\/maps\// },
  // EpicWar's thumbnails and its map files both live in its bucket on Linode's object store; the
  // download link is a 307 to a signed URL there.
  { host: "fr-par-1.linodeobjects.com", path: /^\/epicwar\// },
];

/** A map larger than this is refused rather than held in memory. Ours: Reforged raised the map
 *  ceiling to 256 MB; nothing a 1.30.4 map list would show is anywhere near it. */
export const MAP_SITE_MAX_BYTES = 256 * 1024 * 1024;

const REDIRECTS = 5;

/** Is `url` one the map-site fetch will take? */
export function mapSiteAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  return ALLOWED.some((a) => a.host === u.hostname && a.path.test(u.pathname));
}

/**
 * Fetch an allowed URL, following its redirects only while they stay allowed. Resolves to the
 * final `Response`; throws on a refused URL, a refused redirect, or too many of them.
 */
export async function fetchMapSite(url, signal) {
  let at = url;
  for (let hop = 0; hop <= REDIRECTS; hop++) {
    if (!mapSiteAllowed(at)) throw new Error(`Not a map-site address: ${at}`);
    const res = await fetch(at, {
      redirect: "manual",
      signal,
      headers: { "user-agent": "OpenWar3 map browser", accept: "*/*" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      at = new URL(res.headers.get("location"), at).href;
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects.");
}

/**
 * The whole body of an allowed URL, for the desktop app's IPC: `{ status, type, bytes }`. A body
 * over `MAP_SITE_MAX_BYTES` is refused by its length, or cut off and refused as it arrives.
 */
export async function readMapSite(url) {
  const res = await fetchMapSite(url);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAP_SITE_MAX_BYTES) throw new Error("That file is too large.");
  const chunks = [];
  let total = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > MAP_SITE_MAX_BYTES) throw new Error("That file is too large.");
      chunks.push(chunk);
    }
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  return { status: res.status, type: res.headers.get("content-type") ?? "", bytes };
}

/** The sites the desktop app may OPEN in its own browsing window — their front doors, and
 *  nothing a page could steer elsewhere. */
export const OPENABLE_HOSTS = ["www.hiveworkshop.com", "hiveworkshop.com", "www.epicwar.com", "epicwar.com", "wc3maps.com", "www.wc3maps.com"];

export function mapSiteOpenable(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && OPENABLE_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}
