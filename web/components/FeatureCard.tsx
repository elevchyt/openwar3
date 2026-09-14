import Image from "next/image";
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
// (web/public/media/) rather than re-encoded to WebP on the way out.
function FeatureImage({ src, alt }: { src: string; alt: string }) {
  return (
    <Image
      src={src}
      alt={alt}
      fill
      unoptimized={src.endsWith(".avif")}
      sizes="(max-width: 720px) 100vw, (max-width: 1100px) 50vw, 400px"
    />
  );
}
