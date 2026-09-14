"use client";

import { useEffect } from "react";
import { bindHotkeys } from "../dom";

// The glue screens answer to a letter as well as a click (MainMenu.fdf `ControlShortcutKey`),
// so the page does too: pressing a button's marked letter clicks it. Mount once per page.
export function Hotkeys() {
  useEffect(() => bindHotkeys(), []);
  return null;
}
