// Multiboard natives (7.22 — issue #33; see docs/triggers.md).
//
// The OTHER scoreboard, and the one every modern custom map actually uses. Where a
// leaderboard (7.19) is a list of rows keyed by PLAYER, each holding one NUMBER, a
// multiboard is a free-form GRID of string cells:
//
//     CreateMultiboardBJ(3, 12, "Skibi's Castle")   // cols, rows, title
//     call MultiboardSetItemValueBJ( mb, 2, 5, "Kills: 14" )
//     call MultiboardSetItemIconBJ ( mb, 3, 1, "ReplaceableTextures\CommandButtons\BTNChestOfGold.blp" )
//
// Be honest about its value by the corpus: only 4 of the 165 bundled maps create one
// (Skibi's Castle TD, ExtremeCandyWar, BomberCommand, AzerothGrandPrix, FunnyBunnys).
// It earns its place because it is what DotA and the whole modern custom-map ecosystem
// puts on screen, and because `UI\FrameDef\UI\MultiBoard.fdf` was already sitting next to
// the LeaderBoard.fdf we mount.
//
// Two shapes to get right, both read off Blizzard.j rather than guessed:
//
//  • **A cell is addressed (row, column) — but the BJs take (col, row).** The natives are
//    `MultiboardGetItem(mb, row, column)`, 0-based; every BJ that fronts them is
//    `MultiboardSetItemValueBJ(mb, col, row, val)`, 1-BASED, and it loops:
//
//        set mbitem = MultiboardGetItem(mb, curRow - 1, curCol - 1)
//        call MultiboardSetItemValue(mbitem, val)
//        call MultiboardReleaseItem(mbitem)
//
//    …with 0 meaning "every row" / "every column". Swap the two and a script writes down
//    the wrong axis; it will look almost right on a square board and wrong on any other.
//
//  • **An item handle is BORROWED, not owned.** `MultiboardGetItem` mints a handle onto a
//    cell and `MultiboardReleaseItem` gives it back — every BJ above pairs them. So the
//    handle must be a *reference into the board*, not a copy of the cell: a released item
//    is stale, and a write through a stale one must not resurrect anything. We hand out a
//    (board, row, col) cursor and let the write go through the board.

import type { MultiboardItem, MultiboardObj, NativeCtx, Runtime } from "../runtime";
import { asInt, asNum, asStr, jBool, jHandle, jInt, JNULL, jStr, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);

/** A `multiboarditem` handle: a cursor into a board's cell, not a copy of it. */
interface MultiboardItemRef {
  handleId: number;
  board: MultiboardObj;
  row: number;
  col: number;
  released: boolean;
}

const WHITE = 0xffffffff;

const board = (c: NativeCtx, v: JassValue): MultiboardObj | undefined => c.rt.data<MultiboardObj>(v);
const itemRef = (c: NativeCtx, v: JassValue): MultiboardItemRef | undefined => c.rt.data<MultiboardItemRef>(v);

const blankItem = (): MultiboardItem => ({
  value: "",
  icon: "",
  width: 0,
  showValue: true,
  showIcon: true,
  valueColor: WHITE,
});

/** The cell at (row, col), or undefined if it is off the board. Cells are row-major, and
 *  the grid is re-shaped by Set{Row,Column}Count — so this is the one place that knows
 *  the layout. */
function cellAt(mb: MultiboardObj, row: number, col: number): MultiboardItem | undefined {
  if (row < 0 || col < 0 || row >= mb.rows || col >= mb.columns) return undefined;
  return mb.items[row * mb.columns + col];
}

/** Re-shape the grid, preserving whatever cells still fall inside it. MultiboardSetRowCount
 *  and SetColumnCount are called in either order (CreateMultiboardBJ does rows THEN columns),
 *  so a resize must never throw away a cell that is still on the board. */
function reshape(mb: MultiboardObj, rows: number, columns: number): void {
  const old = mb.items;
  const oldCols = mb.columns;
  const oldRows = mb.rows;
  mb.rows = Math.max(0, rows);
  mb.columns = Math.max(0, columns);
  mb.items = Array.from({ length: mb.rows * mb.columns }, (_v, i) => {
    const r = Math.floor(i / mb.columns);
    const c = i % mb.columns;
    if (r < oldRows && c < oldCols) return old[r * oldCols + c] ?? blankItem();
    return blankItem();
  });
  mb.revision++;
}

/** Apply `fn` to a cell through an item handle, unless the handle has been released. */
function withCell(c: NativeCtx, v: JassValue, fn: (cell: MultiboardItem, mb: MultiboardObj) => void): JassValue {
  const ref = itemRef(c, v);
  if (!ref || ref.released) return JNULL;
  const cell = cellAt(ref.board, ref.row, ref.col);
  if (!cell) return JNULL;
  fn(cell, ref.board);
  ref.board.revision++;
  return JNULL;
}

export function registerMultiboardNatives(rt: Runtime): void {
  def(rt, "CreateMultiboard", (c) => {
    const mb: MultiboardObj = {
      handleId: 0,
      title: "",
      titleColor: WHITE,
      rows: 0,
      columns: 0,
      items: [],
      displayed: false,
      minimized: false,
      revision: 0,
    };
    mb.handleId = c.rt.handles.alloc(mb);
    c.rt.multiboards.push(mb);
    return jHandle(mb.handleId, "multiboard");
  });
  def(rt, "DestroyMultiboard", (c, a) => {
    const mb = board(c, a[0]);
    if (!mb) return JNULL;
    const i = c.rt.multiboards.indexOf(mb);
    if (i >= 0) c.rt.multiboards.splice(i, 1);
    return JNULL;
  });

  // --- board-level state ---
  def(rt, "MultiboardDisplay", (c, a) => {
    const mb = board(c, a[0]);
    if (mb) {
      mb.displayed = truthy(a[1]);
      mb.revision++;
    }
    return JNULL;
  });
  def(rt, "IsMultiboardDisplayed", (c, a) => jBool(board(c, a[0])?.displayed ?? false));
  def(rt, "MultiboardMinimize", (c, a) => {
    const mb = board(c, a[0]);
    if (mb) {
      mb.minimized = truthy(a[1]);
      mb.revision++;
    }
    return JNULL;
  });
  def(rt, "IsMultiboardMinimized", (c, a) => jBool(board(c, a[0])?.minimized ?? false));
  def(rt, "MultiboardClear", (c, a) => {
    const mb = board(c, a[0]);
    if (mb) {
      mb.items = mb.items.map(() => blankItem());
      mb.revision++;
    }
    return JNULL;
  });
  def(rt, "MultiboardSetTitleText", (c, a) => {
    const mb = board(c, a[0]);
    if (mb) {
      mb.title = asStr(a[1]);
      mb.revision++;
    }
    return JNULL;
  });
  def(rt, "MultiboardGetTitleText", (c, a) => jStr(board(c, a[0])?.title ?? ""));
  def(rt, "MultiboardSetTitleTextColor", (c, a) => {
    const mb = board(c, a[0]);
    if (mb) {
      mb.titleColor = argb(asInt(a[1]), asInt(a[2]), asInt(a[3]), asInt(a[4]));
      mb.revision++;
    }
    return JNULL;
  });
  def(rt, "MultiboardGetRowCount", (c, a) => jInt(board(c, a[0])?.rows ?? 0));
  def(rt, "MultiboardGetColumnCount", (c, a) => jInt(board(c, a[0])?.columns ?? 0));
  def(rt, "MultiboardSetRowCount", (c, a) => {
    const mb = board(c, a[0]);
    if (mb) reshape(mb, asInt(a[1]), mb.columns);
    return JNULL;
  });
  def(rt, "MultiboardSetColumnCount", (c, a) => {
    const mb = board(c, a[0]);
    if (mb) reshape(mb, mb.rows, asInt(a[1]));
    return JNULL;
  });

  // --- "…Items…" (plural): set EVERY cell at once ---
  const allCells = (c: NativeCtx, v: JassValue, fn: (cell: MultiboardItem) => void): JassValue => {
    const mb = board(c, v);
    if (!mb) return JNULL;
    for (const cell of mb.items) fn(cell);
    mb.revision++;
    return JNULL;
  };
  def(rt, "MultiboardSetItemsStyle", (c, a) =>
    allCells(c, a[0], (cell) => {
      cell.showValue = truthy(a[1]);
      cell.showIcon = truthy(a[2]);
    }),
  );
  def(rt, "MultiboardSetItemsValue", (c, a) => allCells(c, a[0], (cell) => (cell.value = asStr(a[1]))));
  def(rt, "MultiboardSetItemsValueColor", (c, a) =>
    allCells(c, a[0], (cell) => (cell.valueColor = argb(asInt(a[1]), asInt(a[2]), asInt(a[3]), asInt(a[4])))),
  );
  def(rt, "MultiboardSetItemsWidth", (c, a) => allCells(c, a[0], (cell) => (cell.width = asNum(a[1]))));
  def(rt, "MultiboardSetItemsIcon", (c, a) => allCells(c, a[0], (cell) => (cell.icon = asStr(a[1]))));

  // --- "…Item…" (singular): one cell, through a BORROWED handle ---
  // MultiboardGetItem(mb, row, column) is 0-based. Note the axis order: row first. Every
  // blizzard.j BJ that calls it passes (curRow - 1, curCol - 1) from a 1-based (col, row)
  // signature, so the swap happens in Blizzard's code, not ours.
  def(rt, "MultiboardGetItem", (c, a) => {
    const mb = board(c, a[0]);
    if (!mb) return JNULL;
    const ref: MultiboardItemRef = { handleId: 0, board: mb, row: asInt(a[1]), col: asInt(a[2]), released: false };
    ref.handleId = c.rt.handles.alloc(ref);
    return jHandle(ref.handleId, "multiboarditem");
  });
  // The handle is given BACK, not destroyed — the cell lives on in the board. A write
  // through a released handle is a no-op (withCell checks), which is what stops a stale
  // cursor from resurrecting a cell the board has since resized away.
  def(rt, "MultiboardReleaseItem", (c, a) => {
    const ref = itemRef(c, a[0]);
    if (ref) ref.released = true;
    return JNULL;
  });
  def(rt, "MultiboardSetItemStyle", (c, a) =>
    withCell(c, a[0], (cell) => {
      cell.showValue = truthy(a[1]);
      cell.showIcon = truthy(a[2]);
    }),
  );
  def(rt, "MultiboardSetItemValue", (c, a) => withCell(c, a[0], (cell) => (cell.value = asStr(a[1]))));
  def(rt, "MultiboardSetItemValueColor", (c, a) =>
    withCell(c, a[0], (cell) => (cell.valueColor = argb(asInt(a[1]), asInt(a[2]), asInt(a[3]), asInt(a[4])))),
  );
  def(rt, "MultiboardSetItemWidth", (c, a) => withCell(c, a[0], (cell) => (cell.width = asNum(a[1]))));
  def(rt, "MultiboardSetItemIcon", (c, a) => withCell(c, a[0], (cell) => (cell.icon = asStr(a[1]))));

  // MultiboardSuppressDisplay(true) hides every board without touching its `displayed`
  // flag — a cinematic toggle (Skibi's Castle TD wraps its minigames in it), so the boards
  // come back exactly as they were.
  def(rt, "MultiboardSuppressDisplay", (c, a) => {
    c.rt.multiboardSuppressed = truthy(a[0]);
    return JNULL;
  });
}

/** WC3's 0–255 r/g/b/a → 0xAARRGGBB (the same packing the leaderboard colours use). */
function argb(r: number, g: number, b: number, a: number): number {
  const cl = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return (((cl(a) << 24) | (cl(r) << 16) | (cl(g) << 8) | cl(b)) >>> 0);
}
