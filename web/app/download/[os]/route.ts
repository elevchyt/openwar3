import { RELEASES_URL, isPlatform, latestRelease } from "@/lib/github";

// GET /download/linux → 302 to the newest release's AppImage (likewise /windows, /macos).
// A stable link to hand out anywhere: it never names a version, so it never goes stale.
// A platform with no artifact yet — or GitHub being unreachable — lands on the releases page
// rather than on an error.
export async function GET(_req: Request, ctx: { params: Promise<{ os: string }> }) {
  const { os } = await ctx.params;
  if (!isPlatform(os)) return new Response("Unknown platform", { status: 404 });
  const release = await latestRelease();
  const asset = release?.assets[os];
  return Response.redirect(asset ? asset.url : RELEASES_URL, 302);
}
