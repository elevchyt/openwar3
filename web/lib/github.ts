// Everything the page knows about the project comes from GitHub at request time, so a new
// release needs no edit here: tag it, upload the artifacts (`pnpm release` at the repo root),
// and within REVALIDATE seconds the buttons point at the new files — and a platform whose
// artifact appears for the first time stops saying "Coming soon" on its own.

export const REPO = "elevchyt/openwar3";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;

/** Seconds a GitHub answer is reused. The unauthenticated API allows 60 calls an hour per IP;
 *  at 300 s the page and the download route together stay far under it. Set GITHUB_TOKEN on
 *  Vercel to lift the limit to 5 000. */
export const REVALIDATE = 300;

export type Platform = "linux" | "windows" | "macos";

export const PLATFORMS: ReadonlyArray<{ id: Platform; label: string; format: string; ships: boolean }> = [
  { id: "linux", label: "Linux", format: "AppImage", ships: true },
  // ONE installer for 32- and 64-bit Windows: electron-builder packs both builds and the
  // installer picks the one the machine runs (root package.json `build.win`).
  { id: "windows", label: "Windows", format: "Installer", ships: true },
  { id: "macos", label: "macOS", format: "DMG", ships: false },
];

/** Which release asset belongs to a platform — the three targets in the root package.json's
 *  `build` block (AppImage, nsis, dmg). The `.blockmap` and `latest-*.yml` files beside them
 *  are the updater's, never a download (`.exe.blockmap` does not end in `.exe`). */
const MATCHERS: Record<Platform, (name: string) => boolean> = {
  linux: (n) => /\.AppImage$/i.test(n),
  windows: (n) => /\.exe$/i.test(n),
  macos: (n) => /\.dmg$/i.test(n),
};

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
}

export interface LatestRelease {
  tag: string;
  url: string;
  publishedAt: string;
  assets: Partial<Record<Platform, ReleaseAsset>>;
}

function headers(): HeadersInit {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openwar3-web",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function gh<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: headers(),
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface GhRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: Array<{ name: string; size: number; browser_download_url: string }>;
}

/** The newest non-draft, non-prerelease release, or null when GitHub can't be reached. */
export async function latestRelease(): Promise<LatestRelease | null> {
  const r = await gh<GhRelease>(`/repos/${REPO}/releases/latest`);
  if (!r) return null;
  const assets: LatestRelease["assets"] = {};
  for (const p of PLATFORMS) {
    const a = r.assets.find((x) => MATCHERS[p.id](x.name));
    if (a) assets[p.id] = { name: a.name, size: a.size, url: a.browser_download_url };
  }
  return { tag: r.tag_name, url: r.html_url, publishedAt: r.published_at, assets };
}

export async function stargazers(): Promise<number | null> {
  const r = await gh<{ stargazers_count: number }>(`/repos/${REPO}`);
  return r ? r.stargazers_count : null;
}

/**
 * Everything the home page shows, for a render that is going to be CACHED.
 *
 * A GitHub call that fails (a rate limit is the usual one: Vercel's functions share egress IPs,
 * and the unauthenticated quota is per IP) answers null, and a page rendered from a null is a
 * page with no version and every button but the fallbacks saying "Coming soon" — which ISR
 * would then serve for the next REVALIDATE seconds. Throwing instead is Next's own contract for
 * this (docs: incremental-static-regeneration, "If an error is thrown while attempting to
 * revalidate data, the last successfully generated data will continue to be served"), so the
 * last good page stays up and the next request tries again.
 *
 * Except at BUILD time, where there is no previous page to keep and a throw would fail the
 * deploy: a page built while GitHub is down renders the fallbacks and replaces itself at the
 * first revalidation that succeeds.
 */
export async function homeData(): Promise<{ release: LatestRelease | null; stars: number | null }> {
  const [release, stars] = await Promise.all([latestRelease(), stargazers()]);
  if ((release === null || stars === null) && process.env.NEXT_PHASE !== "phase-production-build") {
    throw new Error("GitHub could not be reached; keeping the last generated page");
  }
  return { release, stars };
}

export function isPlatform(s: string): s is Platform {
  return PLATFORMS.some((p) => p.id === s);
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}
