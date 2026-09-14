import type { ReactNode } from "react";
import { HotkeyLabel } from "./HotkeyLabel";

interface Props {
  href?: string;
  label: string;
  /** Pressing this letter anywhere on the page clicks the button (see Hotkeys.tsx). */
  hotkey?: string;
  /** The grey-rimmed variant (GlueScreen-Button1-BorderedBackdropBorder). */
  bordered?: boolean;
  size?: "md" | "lg";
  disabled?: boolean;
  /** A second, smaller line under the caption. */
  sub?: ReactNode;
  /** Raised as a tooltip slab on hover and focus. */
  tooltip?: { title: string; body: ReactNode };
  icon?: ReactNode;
  external?: boolean;
}

export function GlueButton({ href, label, hotkey, bordered, size = "md", disabled, sub, tooltip, icon, external }: Props) {
  const cls = ["ow3-glue-btn", `ow3-glue-btn--${size}`, bordered && "ow3-glue-btn--bordered", disabled && "is-disabled"].filter(Boolean).join(" ");
  const inner = (
    <>
      <span className="ow3-glue-btn__glow" aria-hidden />
      <span className="ow3-glue-btn__text">
        {icon && <span className="ow3-glue-btn__icon">{icon}</span>}
        <span className="ow3-glue-btn__caption">
          <span className="ow3-glue-btn__label">
            <HotkeyLabel text={label} hotkey={disabled ? undefined : hotkey} />
          </span>
          {sub && <span className="ow3-glue-btn__sub">{sub}</span>}
        </span>
      </span>
    </>
  );
  const tip = tooltip && (
    <span className="ow3-tooltip" role="tooltip">
      <span className="ow3-tooltip__title">{tooltip.title}</span>
      <span className="ow3-tooltip__body">{tooltip.body}</span>
    </span>
  );
  return (
    <span className="ow3-glue-btn-wrap">
      {disabled || !href ? (
        <button type="button" className={cls} aria-disabled={disabled || undefined} tabIndex={0}>
          {inner}
        </button>
      ) : (
        <a
          className={cls}
          href={href}
          data-hotkey={hotkey?.toLowerCase()}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {inner}
        </a>
      )}
      {tip}
    </span>
  );
}
