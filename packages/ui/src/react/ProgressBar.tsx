import type { CSSProperties } from "react";

interface Props {
  /** 0…1, or null for a stage whose size is not known yet (the head sweeps the hole). */
  value: number | null;
  /** The line under the bar. */
  label?: string;
  /** 1 = the frame's own texels (a 40 px tall bar). */
  scale?: number;
  className?: string;
}

/** The loading screen's bar (LoadBar.mdx), in the kit's own frame — same markup as the DOM
 *  binding's `createProgressBar`. */
export function ProgressBar({ value, label, scale, className }: Props) {
  const f = value === null ? null : Math.min(1, Math.max(0, value));
  const style = { ...(f !== null && { "--ow3-progress": f }), ...(scale && { "--ow3-progress-scale": scale }) } as CSSProperties;
  return (
    <div className={["ow3-progress-wrap", className].filter(Boolean).join(" ")}>
      <div
        className={["ow3-progress", f === null && "is-indeterminate"].filter(Boolean).join(" ")}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={f === null ? undefined : Math.round(f * 100)}
        data-empty={f === 0 ? "" : undefined}
        style={style}
      >
        <div className="ow3-progress__track">
          <div className="ow3-progress__fill" />
          <div className="ow3-progress__glow" />
          <div className="ow3-progress__glass" />
        </div>
      </div>
      {label && <span className="ow3-progress__label">{label}</span>}
    </div>
  );
}
