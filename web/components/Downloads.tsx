import { GlueButton } from "./GlueButton";
import { AppleIcon, LinuxIcon, WindowsIcon } from "./Icons";
import { PLATFORMS, RELEASES_URL, formatBytes, type LatestRelease, type Platform } from "@/lib/github";

const ICONS: Record<Platform, React.ReactNode> = {
  linux: <LinuxIcon />,
  windows: <WindowsIcon />,
  macos: <AppleIcon />,
};

// One button per desktop target. Whether a platform is live is not written down anywhere on
// this page: it is whether the newest release carries that platform's artifact.
export function Downloads({ release }: { release: LatestRelease | null }) {
  return (
    <div className="downloads">
      <div className="downloads__row">
        {PLATFORMS.map((p) => {
          const asset = release?.assets[p.id];
          // GitHub unreachable: keep Linux live through the redirect route, which retries it.
          const live = asset || (!release && p.id === "linux");
          if (!live) {
            return (
              <GlueButton
                key={p.id}
                size="lg"
                bordered
                disabled
                icon={ICONS[p.id]}
                label={p.label}
                sub="Coming soon"
                tooltip={{
                  title: `${p.label} — Coming soon`,
                  body: (
                    <>
                      A {p.label} build is on the way. <span className="gold">Star the repository</span> to hear when it lands.
                    </>
                  ),
                }}
              />
            );
          }
          return (
            <GlueButton
              key={p.id}
              size="lg"
              bordered
              href={`/download/${p.id}`}
              hotkey={p.label[0]}
              icon={ICONS[p.id]}
              label={p.label}
              sub={asset ? `${p.format} · ${formatBytes(asset.size)}` : p.format}
              tooltip={{
                title: `Download for ${p.label}`,
                body: asset ? (
                  <>
                    <span className="mono">{asset.name}</span>
                    <br />
                    Needs <span className="gold">Warcraft III: The Frozen Throne 1.30.4</span>.
                  </>
                ) : (
                  <>The newest release&apos;s {p.format}.</>
                ),
              }}
            />
          );
        })}
      </div>
      <p className="downloads__meta">
        {release ? (
          <>
            Latest release{" "}
            <a href={release.url} target="_blank" rel="noopener noreferrer">
              {release.tag}
            </a>{" "}
            · {new Date(release.publishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} ·{" "}
          </>
        ) : null}
        <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
          All releases
        </a>
      </p>
    </div>
  );
}
