import type { DataSource } from "../vfs/types";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import type { ListItem } from "./fdf/widgets";
import { adopt, setProp } from "./mapBrowser";
import { HOTKEY_EDITOR_OVERRIDE, OW3_STRINGS } from "../overrides";
import { blpToCanvas } from "../render/blputil";
import { showGlueDialog } from "./glueDialog";
import { keyName } from "../data/commandStrings";
import { canSaveCustomKeys, customKeysText, saveCustomKeys } from "../data/customKeys";
import { CustomKeysDoc, encodeAnsi, joinList, retip, splitList } from "../data/customKeysDoc";
import {
  CATALOG_RACES, HotkeyCatalog, hotkeyField, posField, tipField,
  type CatalogButton, type CatalogCard, type CatalogRace, type CatalogUnit, type KeyVariant,
} from "../data/hotkeyCatalog";

// The hotkey editor (issue #156) — Options → Gameplay → "Hotkeys:" → Custom's own screen.
//
// It does what the community's hotkey generators do (the issue links jcfields'
// warcraft3-hotkey-editor), inside the game and against the player's real file:
//
//   · a race tab and a list of that race's heroes, units and buildings (data/hotkeyCatalog.ts
//     reads them out of the install);
//   · the chosen unit's COMMAND CARD, drawn as the game draws it — the button's own icon in its
//     `Buttonpos` slot and its key in the same framed corner badge the in-game card wears
//     (`hud-count-badge hud-hotkey-badge`, ui/hud.ts). A button is pressed to select it and
//     DRAGGED onto another slot to move it, swapping with whatever was there (`Buttonpos`);
//   · the selected button's key (click the box, press a key) — and for a toggle its active
//     state's key too. The TOOLTIP is not edited here: it is shown as the game will draw it, and
//     its gilded letter follows the key by itself (`retip`), which is what a player rebinding a
//     key wants from it and all they are asked to think about;
//   · Save, which writes the file (customKeys.ts `saveCustomKeys`), and Cancel, which does not.
//
// It is a MODAL like every other glue dialog: a dimmed `glue-dialog-scrim` over the Options
// screen, which is what `modalOver` gates that screen's accelerators on (ui/modal.ts), and it
// takes Escape itself.
//
// Everything it writes goes through `CustomKeysDoc`, which edits the player's file in place. A
// value set back to the install's own is taken OUT of the file rather than written, so a file
// saved from here only ever says what the player changed.

const DIALOG_FDF = "UI\\FrameDef\\Glue\\DialogWar3.fdf";
const LIST_FDF = "UI\\FrameDef\\Glue\\ListBoxWar3.fdf";
/** The box a command button's key is printed in (see countBadge in ui/hud.ts). */
const NUMBER_OVERLAY = "UI\\Widgets\\Console\\Human\\CommandButton\\human-button-lvls-overlay.blp";

const RACE_TAB: Record<CatalogRace, string> = {
  human: "HotkeyRaceHuman", orc: "HotkeyRaceOrc", nightelf: "HotkeyRaceNightElf", undead: "HotkeyRaceUndead", neutral: "HotkeyRaceNeutral",
};
/** The tab labels are the game's own race names (GlobalStrings.fdf). */
const RACE_STRING: Record<CatalogRace, string> = {
  human: "HUMAN", orc: "ORC", nightelf: "NIGHT_ELF", undead: "UNDEAD", neutral: "NEUTRAL",
};
const GROUP_LABEL: Record<CatalogUnit["group"], string> = {
  hero: "Heroes", unit: "Units", building: "Buildings", special: "Special",
};
const PAGE_LABEL: Record<CatalogCard["id"], string> = { main: "Commands", build: "Build", learn: "Learn" };

/** The gold the game gilds a hotkey letter in (every stock Tip: `|cffffcc00M|rove`). */
const GILD = "|cffffcc00";

export interface HotkeyEditorOptions {
  container: HTMLElement;
  vfs: DataSource;
  /** Fired after the editor takes itself away, saved or not. */
  onClosed?: () => void;
}

/** The catalog is the same for the life of an install, and reading it is ~90 tables. */
let cachedCatalog: { vfs: DataSource; catalog: HotkeyCatalog } | null = null;

export async function showHotkeyEditor(opts: HotkeyEditorOptions): Promise<void> {
  const catalog = cachedCatalog?.vfs === opts.vfs ? cachedCatalog.catalog : new HotkeyCatalog(opts.vfs);
  cachedCatalog = { vfs: opts.vfs, catalog };
  const doc = new CustomKeysDoc(customKeysText());

  const scrim = document.createElement("div");
  scrim.className = "glue-dialog-scrim dimmed";
  opts.container.appendChild(scrim);

  let screen: FdfScreen | null = null;
  let lib: FdfLibrary | null = null;
  let race: CatalogRace = "human";
  let unit: CatalogUnit = catalog.units.find((u) => u.race === race) ?? catalog.units[0];
  let page: CatalogCard["id"] = "main";
  let selected: CatalogButton | null = null;
  /** Editing a toggle's ACTIVE state (`Un*`) rather than its normal one. */
  let editingUn = false;
  let capturing = false;
  let status = "";
  let closed = false;

  const icons = new Map<string, string | null>();
  const iconUrl = (path: string): string | null => {
    if (!path) return null;
    if (!icons.has(path)) {
      const bytes = opts.vfs.rawBytes(path.replace(/\.tga$/i, ".blp"));
      icons.set(path, bytes ? blpToCanvas(bytes)?.toDataURL() ?? null : null);
    }
    return icons.get(path) ?? null;
  };
  const iconCanvas = (path: string): HTMLCanvasElement | null => {
    const bytes = path ? opts.vfs.rawBytes(path) : null;
    return bytes ? blpToCanvas(bytes) : null;
  };

  // --- values -------------------------------------------------------------------------------

  /** The document's value for a field, falling back to the install's. */
  const value = (section: string, field: string): string => doc.get(section, field) ?? catalog.default(section, field) ?? "";
  const variantOf = (b: CatalogButton): KeyVariant => (editingUn && b === selected && hasUn(b) ? "un" : b.variant);
  const hasUn = (b: CatalogButton): boolean =>
    b.variant === "" && (catalog.default(b.section, "unhotkey") !== undefined || catalog.default(b.section, "untip") !== undefined);
  const keyOf = (b: CatalogButton, v: KeyVariant = b.variant): string => keyName(splitList(value(b.section, hotkeyField(v)))[0] ?? "");
  const posOf = (b: CatalogButton, v: KeyVariant = b.variant): [number, number] | null => {
    const [x, y] = value(b.section, posField(v)).split(",").map((n) => Number(n.trim()));
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x <= 3 && y >= 0 && y <= 2 ? [x, y] : null;
  };

  /** Write a field, or take it out of the file when it is back to the install's own value. */
  const put = (section: string, field: string, v: string): void => {
    doc.set(section, field, v === (catalog.default(section, field) ?? "") ? null : v);
  };

  const setKey = (b: CatalogButton, v: KeyVariant, key: string): void => {
    const levels = catalog.levels(b.section, v);
    put(b.section, hotkeyField(v), joinList(Array(levels).fill(key)));
    const tips = splitList(value(b.section, tipField(v)));
    if (tips.some((t) => t)) put(b.section, tipField(v), joinList(tips.map((t) => retip(t, key))));
  };

  const resetButton = (b: CatalogButton): void => {
    for (const v of hasUn(b) ? ["", "un"] as KeyVariant[] : [b.variant]) {
      for (const f of [hotkeyField(v), posField(v), tipField(v)]) doc.set(b.section, f, null);
    }
  };

  // --- the card -----------------------------------------------------------------------------

  const card = (): CatalogCard => unit.cards.find((c) => c.id === page) ?? unit.cards[0];

  /** Buttons by slot, in card order. Where two claim one slot, both are kept — the game moves
   *  one of them somewhere free, and the editor shows the clash rather than guessing where. */
  const slots = (): CatalogButton[][] => {
    const out: CatalogButton[][] = Array.from({ length: 12 }, () => []);
    for (const b of card().buttons) {
      const p = posOf(b);
      if (p) out[p[1] * 4 + p[0]].push(b);
    }
    return out;
  };

  const duplicateKeys = (): Set<string> => {
    const seen = new Map<string, number>();
    for (const b of card().buttons) {
      const k = keyOf(b);
      if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  };

  const drawCard = (): void => {
    const host = screen?.frame("HotkeyCardContainer");
    if (!host) return;
    host.textContent = "";
    const grid = document.createElement("div");
    grid.className = "hk-card";
    const dupes = duplicateKeys();
    const bySlot = slots();
    bySlot.forEach((stack, i) => {
      const cell = document.createElement("div");
      cell.className = "hk-slot";
      cell.dataset.slot = String(i);
      const b = stack[stack.length - 1];
      if (b) {
        const btn = document.createElement("div");
        btn.className = "hk-btn";
        // The selected toggle wears its ACTIVE face while that state is the one being edited.
        const v = variantOf(b);
        const url = iconUrl(v === "un" ? b.unIcon ?? b.icon : b.icon);
        if (url) btn.style.backgroundImage = `url(${url})`;
        btn.classList.toggle("selected", b === selected);
        btn.classList.toggle("clash", stack.length > 1);
        const k = keyOf(b, v);
        const badge = document.createElement("span");
        badge.className = "hud-count-badge hud-hotkey-badge";
        const letter = document.createElement("span");
        letter.textContent = keyCap(k);
        badge.appendChild(letter);
        badge.hidden = !k;
        badge.classList.toggle("long", keyCap(k).length > 1);
        badge.classList.toggle("dupe", dupes.has(k));
        btn.appendChild(badge);
        btn.addEventListener("pointerdown", (e) => { if (e.button === 0) press(b, btn, e); });
        btn.addEventListener("dblclick", () => { if (b.opens) showPage(b.opens); });
        cell.appendChild(btn);
      }
      grid.appendChild(cell);
    });
    host.appendChild(grid);
  };

  /**
   * A press on a card button: select it, and if the pointer then travels, DRAG it.
   *
   * Pointer events and a picture of the icon under the cursor rather than HTML5 drag-and-drop:
   * a native drag puts the browser's own drag cursor and ghost image on screen, and the game
   * never shows anything but its own cursor (ui/cursor.ts). The press selects first, so a drag
   * is also a selection — the details column always speaks for the button in hand.
   */
  const press = (b: CatalogButton, btn: HTMLElement, down: PointerEvent): void => {
    const size = btn.getBoundingClientRect();
    select(b);
    let ghost: HTMLElement | null = null;
    let over: HTMLElement | null = null;
    const slotAt = (x: number, y: number): HTMLElement | null =>
      (document.elementsFromPoint(x, y).find((el) => el.classList.contains("hk-slot")) as HTMLElement | undefined) ?? null;
    const onMove = (e: PointerEvent): void => {
      if (!ghost) {
        if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 5) return;
        ghost = document.createElement("div");
        ghost.className = "hk-ghost";
        ghost.style.width = `${size.width}px`;
        ghost.style.height = `${size.height}px`;
        const url = iconUrl(b.icon);
        if (url) ghost.style.backgroundImage = `url(${url})`;
        scrim.appendChild(ghost);
      }
      ghost.style.left = `${e.clientX - size.width / 2}px`;
      ghost.style.top = `${e.clientY - size.height / 2}px`;
      const slot = slotAt(e.clientX, e.clientY);
      if (slot !== over) { over?.classList.remove("drop"); slot?.classList.add("drop"); over = slot; }
    };
    const onUp = (e: PointerEvent): void => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      over?.classList.remove("drop");
      if (!ghost) return;
      ghost.remove();
      const slot = slotAt(e.clientX, e.clientY);
      if (slot?.dataset.slot) move(b, Number(slot.dataset.slot));
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  };

  /** Put `b` in slot `to`, swapping whatever stood there into the slot `b` left. A toggle's
   *  active state moves with it when the two shared a slot, which is every stock toggle. */
  const move = (b: CatalogButton, to: number): void => {
    const from = posOf(b);
    const target = [to % 4, Math.floor(to / 4)] as const;
    if (from && from[0] === target[0] && from[1] === target[1]) return;
    const other = slots()[to].filter((o) => o !== b);
    const place = (x: CatalogButton, p: readonly [number, number]): void => {
      const old = posOf(x);
      put(x.section, posField(x.variant), `${p[0]},${p[1]}`);
      const un = hasUn(x) ? posOf(x, "un") : null;
      if (un && old && un[0] === old[0] && un[1] === old[1]) put(x.section, "unbuttonpos", `${p[0]},${p[1]}`);
    };
    place(b, target);
    if (from) for (const o of other) place(o, from);
    status = "";
    paint();
  };

  // --- selection & details --------------------------------------------------------------------

  const select = (b: CatalogButton): void => {
    if (selected !== b) editingUn = false;
    selected = b;
    capturing = false;
    paint();
  };

  const showPage = (id: CatalogCard["id"]): void => {
    if (!unit.cards.some((c) => c.id === id)) return;
    page = id;
    selected = null;
    paint();
  };

  const paintDetails = (s: FdfScreen): void => {
    const b = selected;
    const show = (name: string, on: boolean): void => { const el = s.frame(name); if (el) el.hidden = !on; };
    for (const name of ["HotkeyKeyLabel", "HotkeyKeyEditBox", "HotkeyResetBackdrop"]) show(name, !!b);
    const un = !!b && hasUn(b);
    show("HotkeyUnCheckBox", un);
    show("HotkeyUnLabel", un);
    if (!b) {
      s.setText("HotkeyButtonName", "|cffa0a0a0Select a button on the card.|r");
      s.setText("HotkeyButtonInfo", "");
      return;
    }
    const v = variantOf(b);
    const tips = splitList(value(b.section, tipField(v)));
    s.setText("HotkeyButtonName", tips[0] || b.name);
    const keyBox = s.editBox("HotkeyKeyEditBox");
    if (keyBox) keyBox.value = capturing ? "…" : keyCap(keyOf(b, v));
    const unBox = s.checkBox("HotkeyUnCheckBox");
    if (unBox) unBox.checked = editingUn;

    const lines: string[] = [];
    const levels = catalog.levels(b.section, v);
    if (levels > 1) lines.push(`One key for all ${levels} levels.`);
    const k = keyOf(b, v);
    const clash = k ? card().buttons.filter((o) => o !== b && keyOf(o) === k) : [];
    if (clash.length) lines.push(`|cffff6060${keyCap(k)} is also ${clash.map((o) => o.name).join(", ")} on this card.|r`);
    const users = catalog.usedBy(b.section).filter((u) => u !== unit);
    if (users.length) {
      const names = [...new Set(users.map((u) => u.name))];
      lines.push(`Also on: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}.`);
    }
    if (b.opens) lines.push(`Double-click to open its card.`);
    s.setText("HotkeyButtonInfo", lines.join("|n"));
  };

  // --- the whole screen ---------------------------------------------------------------------

  const unitItems = (): ListItem[] => {
    const items: ListItem[] = [];
    let group: CatalogUnit["group"] | null = null;
    for (const u of catalog.units) {
      if (u.race !== race) continue;
      if (u.group !== group) {
        group = u.group;
        items.push({ value: `#${group}`, label: `${GILD}${GROUP_LABEL[group]}|r` });
      }
      items.push({ value: u.id, label: u.name, icon: iconCanvas(u.icon) });
    }
    return items;
  };

  const paint = (): void => {
    const s = screen;
    if (!s) return;
    for (const r of CATALOG_RACES) s.setEnabled(RACE_TAB[r], r !== race);
    s.setText("HotkeyCardTitle", `${GILD}${unit.name}|r`);
    const sub = unit.cards.find((c) => c.id !== "main");
    const mainEl = s.frame("HotkeyPageMain");
    const subEl = s.frame("HotkeyPageSub");
    if (mainEl) mainEl.hidden = !sub;
    if (subEl) subEl.hidden = !sub;
    if (sub) {
      s.setText("HotkeyPageSubText", PAGE_LABEL[sub.id]);
      s.setEnabled("HotkeyPageMain", page !== "main");
      s.setEnabled("HotkeyPageSub", page !== sub.id);
    }
    s.setText(
      "HotkeyCardHint",
      "Click a button to change its key. Drag it onto another slot to move it.",
    );
    drawCard();
    paintDetails(s);
    const dirty = doc.dirty;
    s.setText("HotkeyStatus", status || (dirty ? "|cffffcc00Unsaved changes|r" : ""));
  };

  const pickRace = (r: CatalogRace): void => {
    race = r;
    const first = catalog.units.find((u) => u.race === r);
    if (first) unit = first;
    page = "main";
    selected = null;
    screen?.list("HotkeyUnitList")?.setItems(unitItems());
    screen?.list("HotkeyUnitList")?.select(unit.id);
    paint();
  };

  const pickUnit = (id: string): void => {
    const u = catalog.units.find((x) => x.id === id && x.race === race);
    const list = screen?.list("HotkeyUnitList");
    if (!u) { list?.select(unit.id); return; } // a group heading is not a unit
    unit = u;
    page = "main";
    selected = null;
    paint();
  };

  // --- keys, closing, saving ----------------------------------------------------------------

  const close = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKey, true);
    screen?.dispose();
    scrim.remove();
    opts.onClosed?.();
  };

  const cancel = (): void => {
    if (!doc.dirty) return close();
    void showGlueDialog({
      container: scrim,
      vfs: opts.vfs,
      text: "Discard your changes to the hotkeys?",
      buttons: "yesno",
      dimmed: true,
      onConfirm: close,
    });
  };

  const save = async (): Promise<void> => {
    if (!doc.dirty) return close();
    const text = doc.serialize();
    try {
      await saveCustomKeys(text, encodeAnsi(text));
      close();
    } catch (err) {
      status = `|cffff6060${(err as Error).message}|r`;
      paint();
    }
  };

  const resetAll = (): void => {
    void showGlueDialog({
      container: scrim,
      vfs: opts.vfs,
      text: "Reset every hotkey, button position and tooltip to the game's defaults?",
      buttons: "yesno",
      dimmed: true,
      onConfirm: () => {
        for (const u of catalog.units) for (const c of u.cards) for (const b of c.buttons) resetButton(b);
        status = "";
        paint();
      },
    });
  };

  const onKey = (e: KeyboardEvent): void => {
    // A dialog raised from this one (Discard? Reset?) takes its own keys.
    if ([...document.querySelectorAll(".glue-dialog-scrim")].some((el) => el !== scrim && scrim.contains(el))) return;
    const s = screen;
    if (capturing && selected && s) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { capturing = false; paint(); return; }
      if (e.key === "Backspace" || e.key === "Delete") {
        const v = variantOf(selected);
        doc.set(selected.section, hotkeyField(v), null);
        doc.set(selected.section, tipField(v), null);
      } else {
        // CustomKeyInfo.txt: "The entry for a custom key must be uppercase." A letter or a
        // digit — what the card's key handler can match a press against.
        const k = e.key.length === 1 ? e.key.toUpperCase() : "";
        if (!/^[A-Z0-9]$/.test(k)) return;
        setKey(selected, variantOf(selected), k);
      }
      capturing = false;
      status = "";
      (document.activeElement as HTMLElement | null)?.blur();
      paint();
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  window.addEventListener("keydown", onKey, true);

  const buildRoot = (l: FdfLibrary): FdfFrame => {
    lib = l;
    const root = l.resolveRoot("HotkeyEditor");
    if (!root) throw new Error("HotkeyEditor.fdf: no HotkeyEditor frame");
    const listBox = l.resolveRoot("ListBoxWar3");
    if (listBox) {
      const list: FdfFrame = { ...listBox, name: "HotkeyUnitList" };
      setProp(list, "SetAllPoints", []);
      adopt(root, "HotkeyUnitListContainer", [list]);
    }
    return root;
  };

  const numberUrl = iconUrl(NUMBER_OVERLAY);
  if (numberUrl) scrim.style.setProperty("--hk-number-overlay", `url(${numberUrl})`);

  try {
    screen = await mountFdfScreen({
      container: scrim,
      vfs: opts.vfs,
      fdfPath: DIALOG_FDF,
      includeFdf: [LIST_FDF],
      rootFrame: "HotkeyEditor",
      overrides: [OW3_STRINGS, HOTKEY_EDITOR_OVERRIDE],
      buildRoot,
      centerRoot: true,
      noShortcutKeys: true, // the key box takes letters; no accelerator may fire under it
      textOverrides: {
        HotkeyEditorTitle: "Hotkey Editor",
        HotkeyKeyLabel: "Hotkey:",
        HotkeyUnLabel: "Active state",
        HotkeyResetButtonText: "Reset",
        HotkeyResetAllButtonText: "Reset All",
        HotkeySaveButtonText: "Save",
        HotkeyCancelButtonText: "Cancel",
        HotkeyPageMainText: PAGE_LABEL.main,
      },
      handlers: {
        HotkeyRaceHuman: () => pickRace("human"),
        HotkeyRaceOrc: () => pickRace("orc"),
        HotkeyRaceNightElf: () => pickRace("nightelf"),
        HotkeyRaceUndead: () => pickRace("undead"),
        HotkeyRaceNeutral: () => pickRace("neutral"),
        HotkeyPageMain: () => showPage("main"),
        HotkeyPageSub: () => { const sub = unit.cards.find((c) => c.id !== "main"); if (sub) showPage(sub.id); },
        HotkeyResetButton: () => { if (selected) { resetButton(selected); paint(); } },
        HotkeyResetAllButton: resetAll,
        HotkeySaveButton: () => void save(),
        HotkeyCancelButton: cancel,
      },
      onBuild: (s) => {
        screen = s;
        for (const r of CATALOG_RACES) s.setText(`${RACE_TAB[r]}Text`, lib?.string(RACE_STRING[r]) ?? r);
        const list = s.list("HotkeyUnitList");
        if (list) {
          list.setItems(unitItems());
          list.select(unit.id);
          list.onChange = pickUnit;
        }
        const keyInput = s.frame("HotkeyKeyEditBox")?.querySelector("input");
        if (keyInput) {
          keyInput.readOnly = true;
          keyInput.addEventListener("focus", () => { if (selected) { capturing = true; paintDetails(s); } });
          keyInput.addEventListener("blur", () => { if (capturing) { capturing = false; paintDetails(s); } });
        }
        const un = s.checkBox("HotkeyUnCheckBox");
        if (un) un.onChange = (on) => { editingUn = on; paint(); };
        if (!canSaveCustomKeys()) status = "|cffa0a0a0Saved keys last until the game is closed: this browser cannot write to the folder.|r";
        paint();
      },
    });
  } catch (err) {
    close();
    throw err;
  }
}

/** A key as the in-game card prints it (ui/hud.ts `printedKey`'s keycaps). */
function keyCap(k: string): string {
  const caps: Record<string, string> = { Escape: "Esc", Backspace: "Bksp", Enter: "Ent", Delete: "Del", " ": "Spc" };
  return caps[k] ?? k;
}
