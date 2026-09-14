import Image from "next/image";
import { GlueButton, Hotkeys, Panel } from "@openwar3/ui/react";
import { Downloads } from "@/components/Downloads";
import { FeatureCard, type Media } from "@/components/FeatureCard";
import { GitHubIcon, KofiIcon, StarIcon } from "@/components/Icons";
import { REPO_URL, latestRelease, stargazers } from "@/lib/github";

const KOFI_URL = "https://ko-fi.com/lefterisdev";

// Re-rendered in the background at most every five minutes (lib/github.ts REVALIDATE — Next
// wants a literal here), so a new release shows up without a redeploy.
export const revalidate = 300;

const FEATURES: ReadonlyArray<{ title: string; body: string; media: Media }> = [
  {
    title: "A faithful recreation",
    body: "Every unit, ability, cost and timing is read straight out of your own Warcraft III: The Frozen Throne 1.30.4 install. OpenWar3 is original code and ships zero Blizzard assets.",
    media: { kind: "image", src: "/media/game1.jpg", alt: "An orc base in OpenWar3, training from the Altar of Storms" },
  },
  {
    title: "Computer+",
    body: "A second melee AI beside Blizzard's own, which is ported script for script. Computer+ never cheats at any difficulty, rolls a named build every match, creeps, shops, and talks to its allies in team games.",
    media: { kind: "placeholder" },
  },
  {
    title: "LAN with zero setup",
    body: "Run the desktop app on two machines and pick Local Area Network. Games show up in each other's list within seconds — no terminal, no accounts, no cloud.",
    media: { kind: "placeholder" },
  },
  {
    title: "Campaigns & custom maps",
    body: "Maps run their own JASS scripts on OpenWar3's interpreter, from the campaign chapters to custom games like Extreme Candy War.",
    media: { kind: "placeholder" },
  },
  {
    title: "Hotkeys your way",
    body: "Legacy, Grid, or your own CustomKeys.txt — the same three options the game has, with the grid read off the key's position, so it works on any keyboard layout.",
    media: { kind: "placeholder" },
  },
  {
    title: "Keeps itself up to date",
    body: "The game checks for a new release at launch and offers it in its own message box. Say yes and it downloads, installs and restarts on its own.",
    media: { kind: "image", src: "/media/updater.jpg", alt: "The OpenWar3 main menu downloading an update" },
  },
];

const ROADMAP: ReadonlyArray<{ title: string; body: string }> = [
  { title: "Windows & macOS builds", body: "The same desktop app on every platform, and in any browser." },
  { title: "Multiplayer reconnect", body: "A dropped connection no longer costs you the game." },
  { title: "Huge control groups", body: "Dozens of units bound to a single group key." },
  { title: "Select army hotkey", body: "Every combat unit you own on one key." },
  { title: "Voice control mode", body: "An accessibility option so more people can play." },
  { title: "Push-to-talk voice chat", body: "Talk to your team in multiplayer, DotA-style." },
];

export default async function Home() {
  const [release, stars] = await Promise.all([latestRelease(), stargazers()]);

  return (
    <>
      <Hotkeys />
      <header className="topbar">
        <div className="topbar__inner">
          <a className="topbar__brand" href="#top">
            OpenWar3
          </a>
          <nav className="topbar__nav">
            <a href="#features">Features</a>
            <a href="#roadmap">Roadmap</a>
            <a href="#contribute">Contribute</a>
          </nav>
          <div className="topbar__resources">
            <a className="resource resource--kofi" href={KOFI_URL} target="_blank" rel="noopener noreferrer" title="Support OpenWar3 on Ko-fi">
              <span className="resource__icon">
                <KofiIcon />
              </span>
              <span className="resource__label">Support</span>
            </a>
            <a className="resource" href={REPO_URL} target="_blank" rel="noopener noreferrer" title="Star OpenWar3 on GitHub">
              <span className="resource__icon">
                <StarIcon />
              </span>
              <span className="resource__value">{stars ?? "Star"}</span>
              <span className="resource__github">
                <GitHubIcon />
              </span>
            </a>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero__backdrop" aria-hidden>
            <Image src="/media/game2.jpg" alt="" fill priority sizes="100vw" />
          </div>
          <div className="hero__content">
            <h1 className="sr-only">OpenWar3</h1>
            <Image
              className="hero__logo"
              src="/openwar3-logo.png"
              alt="OpenWar3"
              width={1683}
              height={935}
              priority
              sizes="(max-width: 720px) 90vw, 640px"
            />
            <p className="hero__tagline">Warcraft III: The Frozen Throne, rebuilt in the open.</p>
            <p className="hero__lede">
              A modern, open-source reimplementation of the Warcraft III engine. Bring your own 1.30.4 install — we bring the
              engine.
            </p>
            <Downloads release={release} />
          </div>
        </section>

        <section id="features" className="section">
          <h2 className="ow3-heading">Features</h2>
          <p className="section__lede">Everything below runs in the current release. Footage is on its way.</p>
          <div className="features">
            {FEATURES.map((f) => (
              <FeatureCard key={f.title} title={f.title} media={f.media}>
                {f.body}
              </FeatureCard>
            ))}
          </div>
        </section>

        <section id="roadmap" className="section">
          <h2 className="ow3-heading">Roadmap</h2>
          <p className="section__lede">Where the engine goes past what the original ever did.</p>
          <Panel className="quests">
            <h3 className="quests__heading">Main Quests</h3>
            <ul className="quests__list">
              {ROADMAP.map((q) => (
                <li key={q.title} className="quest">
                  <span className="quest__marker" aria-hidden />
                  <span>
                    <span className="quest__title">{q.title}</span>
                    <span className="quest__body">{q.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </section>

        <section id="contribute" className="section">
          <Panel className="cta">
            <h2 className="cta__title">Rally to the cause</h2>
            <p className="cta__lede">
              OpenWar3 is built in the open by people who still love this game. A <span className="ow3-gold">star on GitHub</span> is
              the single easiest way to help — it tells other players the project exists and keeps us going.
            </p>
            <div className="cta__buttons">
              <GlueButton
                size="lg"
                bordered
                href={REPO_URL}
                external
                hotkey="S"
                icon={<StarIcon />}
                label="Star on GitHub"
                sub={stars != null ? `${stars} ${stars === 1 ? "star" : "stars"} so far` : "Every star counts"}
              />
              <GlueButton
                size="lg"
                bordered
                href={`${REPO_URL}/blob/main/README.md#quick-start`}
                external
                hotkey="C"
                icon={<GitHubIcon />}
                label="Contribute"
                sub="Pull requests welcome"
              />
            </div>
            <div className="cta__ways">
              <div>
                <h3>Write code</h3>
                <p>
                  TypeScript, MIT-licensed. Clone it, run <span className="mono">pnpm dev</span>, pick a subsystem. The{" "}
                  <a href={`${REPO_URL}/tree/main/docs`} target="_blank" rel="noopener noreferrer">
                    docs
                  </a>{" "}
                  explain how each one matches the original.
                </p>
              </div>
              <div>
                <h3>Report what&apos;s different</h3>
                <p>
                  Something doesn&apos;t behave like Warcraft III?{" "}
                  <a href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer">
                    Open an issue
                  </a>{" "}
                  — a map and a screenshot go a long way.
                </p>
              </div>
              <div>
                <h3>Spread the word</h3>
                <p>Share it with the friends you used to play LAN with. Every new player finds bugs we haven&apos;t.</p>
              </div>
            </div>
          </Panel>
        </section>
      </main>

      <footer className="footer">
        <p>
          OpenWar3 is an independent open-source project, not affiliated with or endorsed by Blizzard Entertainment. Warcraft
          is a trademark of Blizzard Entertainment, Inc. You need a legitimate copy of Warcraft III: The Frozen Throne to play.
        </p>
        <p>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>{" "}
          · MIT License · Set in Nowar Sans (SIL OFL 1.1)
        </p>
      </footer>
    </>
  );
}
