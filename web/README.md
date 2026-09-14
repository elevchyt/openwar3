# OpenWar3 — landing page

The site at the project's public URL: a Next.js (App Router) app, deployed to Vercel by hand with
**Root Directory = `web`**. It has its own lockfile and shares one thing with the engine: the UI kit in `../packages/ui`.

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

None of that lives here. It is the shared UI kit in [`../packages/ui`](../packages/ui) — the
same one the game's first screen is built from — imported as `@openwar3/ui` (the stylesheet in
`app/layout.tsx`, the React components from `@openwar3/ui/react`). This folder only lays the page
out. The kit is a `file:` dependency, hard-linked into `node_modules`: **after adding or renaming
a file in the kit, run `pnpm install` here.** Its README covers how the frames are drawn with zero
Blizzard assets, and the typeface (**OpenWar3 Sans**, an OFL subset of Nowar Sans) that
`app/layout.tsx` loads out of it.

## Adding feature footage

Put clips in `public/media/` and change the card's `media` in `app/page.tsx`:

```ts
media: { kind: "video", src: "/media/computer-plus.mp4", poster: "/media/computer-plus.jpg" }
```

Videos autoplay muted and loop. Keep them short (H.264 MP4, ≤ ~8 MB) — they are served as
static files, not through the image optimiser.
