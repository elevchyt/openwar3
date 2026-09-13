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
  const cls = ["glue-btn", `glue-btn--${size}`, bordered && "glue-btn--bordered", disabled && "is-disabled"].filter(Boolean).join(" ");
  const inner = (
    <>
      <span className="glue-btn__glow" aria-hidden />
      <span className="glue-btn__text">
        {icon && <span className="glue-btn__icon">{icon}</span>}
        <span className="glue-btn__caption">
          <span className="glue-btn__label">
            <HotkeyLabel text={label} hotkey={disabled ? undefined : hotkey} />
          </span>
          {sub && <span className="glue-btn__sub">{sub}</span>}
        </span>
      </span>
    </>
  );
  const tip = tooltip && (
    <span className="tooltip" role="tooltip">
      <span className="tooltip__title">{tooltip.title}</span>
      <span className="tooltip__body">{tooltip.body}</span>
    </span>
  );
  return (
    <span className="glue-btn-wrap">
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
