# OpenWar3 — landing page

The site at the project's public URL: a Next.js (App Router) app, deployed to Vercel by hand with
**Root Directory = `web`**. It shares nothing with the engine in `../src` and has its own lockfile.

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm build        # typecheck + production build
```

## Downloads are never edited by hand

`lib/github.ts` reads the newest GitHub release at request time (cached 5 minutes):

- `/download/linux`, `/download/windows`, `/download/macos` redirect to that release's
  `.AppImage` / `.exe` / `.dmg`. These links never name a version, so they never go stale.
- A platform whose artifact is missing from the latest release shows **Coming soon** — so the
  day a release carries a `.exe`, the Windows button goes live with no change here.
- The star count in the top bar and the call-to-action comes from the same API.

The unauthenticated GitHub API allows 60 requests an hour per IP; the 5-minute cache stays well
under it. To lift the limit anyway, set a read-only `GITHUB_TOKEN` in the Vercel project.
`NEXT_PUBLIC_SITE_URL` sets the canonical URL used for social previews.

## The look — and why there are no game textures in it

The page is dressed as the Frozen Throne glue screens: navy glue buttons with the blue-lit bevel,
the Human options-menu panel (stone frame, gold rule, blue marble), the gold-stroke tooltip slab,
gold captions with a white hotkey letter (the letters work — press **L**, **S** or **C**).

OpenWar3 ships **zero Blizzard assets**, and that includes this site. Every frame in `public/ui/`
is drawn from scratch by `scripts/frames.mjs` (`pnpm frames` regenerates them); only the
*colours* were sampled from the 1.30.4 install's own BLPs, and the header of that script names
each texture it matches. Text colours are the ones the FrameDef files state — see the comment at
the top of `app/globals.css`.

The typeface is **Nowar Sans** (nowar-fonts/Nowar-Sans-War3, SIL OFL 1.1), the engine's own
fallback face. `app/fonts/OpenWar3Sans.woff2` is a 22 KB Latin subset of the 9.7 MB original;
because the OFL does not let a modified copy carry the Reserved Font Name, the subset is renamed
**OpenWar3 Sans**. Its licence sits beside it.

## Adding feature footage

Put clips in `public/media/` and change the card's `media` in `app/page.tsx`:

```ts
media: { kind: "video", src: "/media/computer-plus.mp4", poster: "/media/computer-plus.jpg" }
```

Videos autoplay muted and loop. Keep them short (H.264 MP4, ≤ ~8 MB) — they are served as
static files, not through the image optimiser.
