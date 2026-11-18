import { MEDIA_VARIANTS } from "@/lib/mediaVariants";
import type { ReactNode } from "react";
import { PlayIcon } from "./Icons";

export type Media =
  | { kind: "video"; src: string; poster?: string }
  // `fit: "inset"` is for a small UI crop rather than a screenshot: it floats inside the frame over
  // the marble, never scaled past its own pixels, instead of being cropped to fill the 16:9 box.
  | { kind: "image"; src: string; alt: string; fit?: "cover" | "inset" }
  | { kind: "placeholder"; caption?: string };

// A feature: a framed clip over a stone-and-marble panel. Footage goes in public/media/ —
// switch a card's `media` from "placeholder" to { kind: "video", src: "/media/<file>.mp4" }.
export function FeatureCard({ title, children, media }: { title: string; children: ReactNode; media: Media }) {
  return (
    <article className="ow3-panel feature">
      <div className="feature__media">
        {media.kind === "video" && (
          <video src={media.src} poster={media.poster} autoPlay muted loop playsInline preload="metadata" />
        )}
        {media.kind === "image" &&
          (media.fit === "inset" ? (
            <div className="feature__inset">
              <div className="feature__inset-box">
                <FeatureImage src={media.src} alt={media.alt} />
              </div>
            </div>
          ) : (
            <FeatureImage src={media.src} alt={media.alt} />
          ))}
        {media.kind === "placeholder" && (
          <div className="feature__placeholder">
            <span className="feature__play">
              <PlayIcon />
            </span>
            <span>{media.caption ?? "Footage coming soon"}</span>
          </div>
        )}
      </div>
      <h3 className="feature__title">{title}</h3>
      <p className="feature__body">{children}</p>
    </article>
  );
}

// An AVIF is already the format the optimizer would transcode to, so it is served as it was encoded
// (web/public/media/) rather than re-encoded to WebP on the way out — but at the size the card
// draws it: a screenshot carries smaller copies beside it (scripts/media-variants.mjs, `pnpm media`)
// and the browser picks one off `srcset`. AVIF decoding is what made the page crawl on an old
// Core 2 Duo laptop, and a 1600×900 shot in a 400 px card was ten times the pixels it needed.
// A plain <img>: next/image builds no `srcset` for an unoptimized source.
const SIZES = "(max-width: 720px) 100vw, (max-width: 1100px) 50vw, 400px";

function FeatureImage({ src, alt }: { src: string; alt: string }) {
  const v = MEDIA_VARIANTS[src];
  const srcSet = v
    ? [...v.widths.map((w) => `${src.replace(/\.avif$/, `@${w}.avif`)} ${w}w`), `${src} ${v.width}w`].join(", ")
    : undefined;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} srcSet={srcSet} sizes={srcSet ? SIZES : undefined} alt={alt} draggable={false} loading="lazy" decoding="async" />
  );
}
