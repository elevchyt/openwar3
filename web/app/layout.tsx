import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "@openwar3/ui/ui.css";
import "./globals.css";

// Nowar Sans — the game's own fallback face (public/fonts/NowarSans.ttf at the repo root,
// nowar-fonts/Nowar-Sans-War3, OFL 1.1). The full file is 9.7 MB of CJK; this is its Latin
// subset, renamed "OpenWar3 Sans" because the OFL forbids a modified copy from carrying the
// Reserved Font Name. It ships with the UI kit (packages/ui/src/fonts/, licence beside it);
// next/font loads it from there so it is preloaded and gets a size-adjusted fallback.
const gameFont = localFont({
  src: "../node_modules/@openwar3/ui/src/fonts/OpenWar3Sans.woff2",
  variable: "--font-game",
  display: "swap",
  fallback: ["Trebuchet MS", "system-ui", "sans-serif"],
});

const SITE = "https://openwar3.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? SITE),
  title: "OpenWar3 · Warcraft III, rebuilt in the open",
  description:
    "A modern, open-source reimplementation of the Warcraft III: The Frozen Throne engine. Bring your own 1.30.4 install — OpenWar3 ships zero Blizzard assets.",
  openGraph: {
    title: "OpenWar3",
    description: "A modern, open-source reimplementation of the Warcraft III engine.",
    images: ["/media/game2.jpg"],
    type: "website",
  },
  twitter: { card: "summary_large_image", images: ["/media/game2.jpg"] },
};

export const viewport: Viewport = {
  themeColor: "#02040b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={gameFont.variable}>
      <body>{children}</body>
    </html>
  );
}
