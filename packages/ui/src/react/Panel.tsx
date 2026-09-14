import type { ReactNode } from "react";

/** The Human options-menu backdrop: stone frame, gold rule, blue marble (esc-panel.svg). */
export function Panel({ children, className, as: Tag = "div", id }: { children: ReactNode; className?: string; as?: "div" | "section" | "article"; id?: string }) {
  return (
    <Tag id={id} className={["ow3-panel", className].filter(Boolean).join(" ")}>
      {children}
    </Tag>
  );
}
