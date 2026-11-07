import { downloadedMapKey, keepDownloadedMap, requestMapWriteAccess } from "../assets/downloadedMaps";

// The map sites the map list's download panel reaches (ui/mapSitesPanel.ts) — what each one is,
// how it is reached, and what becomes of a map that comes down from it.
//
// Nothing in 1.30.4 had this: Battle.net's map transfer was a LOBBY's, and a player who wanted a
// map went and got it from a website. These are the three the developer named, and the community
// still uses for exactly that. Two of them can only be OPENED, and one can be READ:
//
//   · EpicWar serves its listing as plain HTML and its files through a signed link, so the game
//     can search it and download a result in place — but a page cannot read it (no CORS), so the
//     read goes through the desktop app's main process or, at localhost, the dev server
//     (electron/mapSites.mjs holds the allow-list both of them use). A hosted web build has
//     neither, and EpicWar is then opened like the others.
//   · Hive Workshop and wc3maps sit behind Cloudflare's bot check. A plain fetch is refused by it,
//     and it is not ours to get round; nor may either be framed (X-Frame-Options). So the desktop
//     app SHOWS the real site inside the dialog, in a web view of its own laid over the tab, whose
//     map downloads land in Maps\Download\ and on the list by themselves
//     (electron/mapSitesView.mjs) — the player never leaves the game. A browser has no such view,
//     so on the web the site opens in a new tab and the player hands the file over through Import
//     (or by dropping it on the dialog).
//
// Every map that comes in, by any of the three doors, is kept the way a LAN download is
// (assets/downloadedMaps.ts): `Maps\Download\<file name>`, an ordinary map of the install from
// then on.

export type MapSiteId = "hive" | "epicwar" | "wc3maps";

export interface MapSite {
  id: MapSiteId;
  name: string;
  /** One line on what it is — ours. */
  blurb: string;
  /** Where "open" goes: the site's map section. */
  home: string;
  /** The site's own search, when its address is known (only EpicWar's is: `/maps/?n=`, read off
   *  its own filter form). */
  searchUrl?: (q: string) => string;
}

export const MAP_SITES: readonly MapSite[] = [
  {
    id: "epicwar",
    name: "EpicWar",
    blurb: "A huge archive of custom maps, new and old.",
    home: "https://www.epicwar.com/maps/",
    searchUrl: (q) => `https://www.epicwar.com/maps/?n=${encodeURIComponent(q)}`,
  },
  {
    id: "hive",
    name: "Hive Workshop",
    blurb: "The largest modding community — reviewed and approved maps.",
    home: "https://www.hiveworkshop.com/repositories/maps.564/",
  },
  {
    id: "wc3maps",
    name: "wc3maps",
    blurb: "An archive of every map played on Battle.net, with its statistics.",
    home: "https://wc3maps.com/",
  },
];

export const siteById = (id: MapSiteId): MapSite => MAP_SITES.find((s) => s.id === id)!;

/** Where a site's web view is (electron/mapSitesView.mjs `state`). */
export interface SiteViewState {
  key: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** A page rectangle, in CSS pixels of the game window. */
export interface ViewRect { x: number; y: number; width: number; height: number }

export type SiteViewNav = "back" | "forward" | "reload" | "home" | "external";

/** The desktop app's side (electron/preload.cjs `mapSites`). */
export interface SiteViewBridge {
  show(key: string, home: string, rect: ViewRect, cursor: string): Promise<void>;
  bounds(rect: ViewRect): void;
  hide(): void;
  nav(what: SiteViewNav): void;
  onState(fn: (s: SiteViewState) => void): () => void;
  onEscape(fn: () => void): () => void;
}

interface MapSitesBridge {
  fetch(url: string): Promise<{ status: number; type: string; bytes: Uint8Array }>;
  view?: SiteViewBridge;
  onProgress?(fn: (p: { name: string; received?: number; total?: number; failed?: string }) => void): () => void;
  onDownloaded(fn: (name: string, bytes: Uint8Array, saveError: string | null) => void): () => void;
}

const bridge = (): MapSitesBridge | null =>
  (window as unknown as { ow3native?: { mapSites?: MapSitesBridge } }).ow3native?.mapSites ?? null;

/** The desktop app's in-dialog web view, or null (a browser: the site opens in a tab instead). */
export const siteView = (): SiteViewBridge | null => bridge()?.view ?? null;

/** Hear a map the site view is downloading — progress, then `failed` or nothing (the map itself
 *  arrives through `onSiteDownload`). A no-op off the desktop app. */
export function onSiteProgress(fn: (p: { name: string; received?: number; total?: number; failed?: string }) => void): () => void {
  return bridge()?.onProgress?.(fn) ?? (() => {});
}

/** The dev server's route (tools/vite-plugin-mapsite-proxy.ts). */
const DEV_PROXY = "/dev-mapsite?url=";

/** Can EpicWar be READ from here? The desktop app and the dev server: yes. A hosted web build: no. */
export const canSearchInGame = (): boolean => !!bridge() || import.meta.env.DEV;


async function siteBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const b = bridge();
  if (b) {
    const r = await b.fetch(url);
    if (r.status >= 400) throw new Error(`The site answered ${r.status}.`);
    return r.bytes;
  }
  if (!import.meta.env.DEV) throw new Error("This copy of the game cannot reach the map sites.");
  const res = await fetch(DEV_PROXY + encodeURIComponent(url), { signal });
  if (!res.ok) throw new Error(`The site answered ${res.status}.`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Open a site in the player's browser — a new tab on the web, the system browser from the
 *  desktop app (electron/main.mjs hands every `window.open` to the shell). */
export function openMapSite(site: MapSite): void {
  window.open(site.home, "_blank", "noopener");
}

// --- EpicWar, read in place ------------------------------------------------------------

export interface EpicWarMap {
  id: string;
  title: string;
  author: string;
  /** Player slots, 0 when the row does not say. */
  players: number;
  category: string;
  date: string;
  downloads: string;
  /** The file as EpicWar names it ("79683_CastleFightEU_2.0.40ComFix6c.w3x"). */
  fileName: string;
  size: string;
  /** The signed download link. Good for a while, not for ever — a stale one is re-read. */
  download: string;
  thumb: string | null;
  /** A file the game can keep and play (.w3x/.w3m), not a campaign or an archive. */
  playable: boolean;
}

/**
 * Search EpicWar. Its listing is one server-rendered page per query, and every row carries the
 * map's name, author, player slots, file name, size and a signed download link — so one read
 * answers the whole panel and nothing is fetched per map until the player asks for it.
 */
export async function searchEpicWar(query: string, signal?: AbortSignal): Promise<EpicWarMap[]> {
  const url = siteById("epicwar").searchUrl!(query.trim());
  const html = new TextDecoder().decode(await siteBytes(url, signal));
  return parseEpicWar(html);
}

/** The rows of an EpicWar listing page. Exported for tools/map-sites-test.cjs. */
export function parseEpicWar(html: string): EpicWarMap[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: EpicWarMap[] = [];
  const seen = new Set<string>();
  for (const link of doc.querySelectorAll<HTMLAnchorElement>('a[href*="/download/?token="]')) {
    const id = /\/maps\/(\d+)\/download\//.exec(link.getAttribute("href") ?? "")?.[1];
    if (!id || seen.has(id)) continue;
    // The row is the grid around the link — the nearest ancestor holding the thumbnail too.
    let row: Element | null = link.parentElement;
    while (row && !row.querySelector("img")) row = row.parentElement;
    if (!row) continue;
    seen.add(id);
    const titleEl = [...row.querySelectorAll<HTMLAnchorElement>(`a[href="/maps/${id}/"]`)].find((a) => a.textContent?.trim());
    const by = [...row.querySelectorAll("div")].find((d) => /^\s*by\s/.test(d.textContent ?? "") && d.children.length <= 2);
    const slots = row.querySelector('[title$="player slots"]')?.getAttribute("title") ?? "";
    const field = (label: string): string => {
      const span = [...row!.querySelectorAll("span")].find((s) => s.textContent?.trim() === `${label}:`);
      return span?.parentElement?.textContent?.replace(`${label}:`, "").trim() ?? "";
    };
    const fileName = link.textContent?.trim() ?? "";
    // The size is the LAST parenthesis after the link — a file name may carry its own, "(6)Castle…".
    const size = /\(([^()]+)\)\s*$/.exec(link.parentElement?.textContent ?? "")?.[1]?.trim() ?? "";
    out.push({
      id,
      title: titleEl?.textContent?.trim() || row.querySelector("img")?.getAttribute("alt") || fileName,
      author: by?.querySelector("span")?.textContent?.trim() ?? "",
      players: parseInt(slots, 10) || 0,
      category: field("Category"),
      date: field("Date"),
      downloads: field("Downloads"),
      fileName,
      size,
      download: link.href.startsWith("http") ? link.href : `https://www.epicwar.com${link.getAttribute("href")}`,
      thumb: row.querySelector("img")?.getAttribute("src") ?? null,
      playable: /\.(w3x|w3m)$/i.test(fileName),
    });
  }
  return out;
}

const thumbs = new Map<string, Promise<string | null>>();

/** A row's thumbnail as an object URL — read through the same door as the listing, because the
 *  page is cross-origin isolated and the object store sends no CORP header to load it directly. */
export function epicWarThumb(m: EpicWarMap): Promise<string | null> {
  if (!m.thumb) return Promise.resolve(null);
  let got = thumbs.get(m.id);
  if (!got) {
    got = siteBytes(m.thumb)
      .then((b) => URL.createObjectURL(new Blob([b.slice()], { type: "image/jpeg" })))
      .catch(() => null);
    thumbs.set(m.id, got);
  }
  return got;
}

// --- a map, kept --------------------------------------------------------------------

/** A map that has come in: its key in the install's list, its file, and why it was not WRITTEN
 *  when it was not (it is still on the list for this session). */
export interface ArrivedMap {
  key: string;
  file: File;
  saveError: string | null;
}

/** Call from INSIDE the click that starts a download: the browser grants the folder's write
 *  access only out of a gesture (assets/downloadedMaps.ts `requestMapWriteAccess`). */
export const askToKeep = (): Promise<boolean> => requestMapWriteAccess();

/** Download an EpicWar result and keep it. */
export async function downloadEpicWar(m: EpicWarMap, signal?: AbortSignal): Promise<ArrivedMap> {
  if (!m.playable) throw new Error("That file is not a map this game can play.");
  const bytes = await siteBytes(m.download, signal);
  return keepDownloadedMap(m.fileName, bytes);
}

/** Keep map files the player handed over (Import, or dropped on the panel). Files that are not
 *  maps are skipped and named in `refused`. */
export async function importMapFiles(files: Iterable<File>): Promise<{ kept: ArrivedMap[]; refused: string[] }> {
  const kept: ArrivedMap[] = [];
  const refused: string[] = [];
  for (const f of files) {
    if (!/\.(w3x|w3m)$/i.test(f.name)) { refused.push(f.name); continue; }
    kept.push(await keepDownloadedMap(f.name, new Uint8Array(await f.arrayBuffer())));
  }
  return { kept, refused };
}

/** Hear the maps the desktop app's site views download — already WRITTEN by the shell, so
 *  they only need their place on the list. A no-op off the desktop app. */
export function onSiteDownload(fn: (m: ArrivedMap) => void): () => void {
  const b = bridge();
  if (!b) return () => {};
  return b.onDownloaded((name, bytes, saveError) => {
    fn({ key: downloadedMapKey(name), file: new File([bytes.slice()], name), saveError });
  });
}
