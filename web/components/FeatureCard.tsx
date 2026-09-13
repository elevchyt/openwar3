import Image from "next/image";
import type { ReactNode } from "react";
import { PlayIcon } from "./Icons";

export type Media =
  | { kind: "video"; src: string; poster?: string }
  | { kind: "image"; src: string; alt: string }
  | { kind: "placeholder"; caption?: string };

// A feature: a framed clip over a stone-and-marble panel. Footage goes in public/media/ —
// switch a card's `media` from "placeholder" to { kind: "video", src: "/media/<file>.mp4" }.
export function FeatureCard({ title, children, media }: { title: string; children: ReactNode; media: Media }) {
  return (
    <article className="panel feature">
      <div className="feature__media">
        {media.kind === "video" && (
          <video src={media.src} poster={media.poster} autoPlay muted loop playsInline preload="metadata" />
        )}
        {media.kind === "image" && (
          <Image src={media.src} alt={media.alt} fill sizes="(max-width: 720px) 100vw, (max-width: 1100px) 50vw, 400px" />
        )}
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
