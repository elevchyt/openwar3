// Leaderboards (Phase 7.19 — issue #33; see docs/triggers.md).
//
// The scoreboard every TD and AoS puts on screen ("Kills", "Lives left", "Creeps
// leaked"). Like the group family (7.16), the whole GUI surface is *blizzard.j code we
// already interpret* — CreateLeaderboardBJ, LeaderboardAddItemBJ, LeaderboardSortItemsBJ,
// LeaderboardSetPlayerItemValueBJ, LeaderboardResizeBJ … — riding on the ~25 natives
// below. Until they existed, every one of them silently did nothing.
//
// Two details of Blizzard's own BJs shape this record (Scripts\Blizzard.j):
//   • LeaderboardResizeBJ:  size = item count, +1 when the board has a label. So `rows`
//     is what the board makes room for, and it is NOT always items.length.
//   • LeaderboardAddItemBJ: removes the player's existing row first — a leaderboard row
//     is keyed by PLAYER, which is also what LeaderboardSetPlayerItemValueBJ relies on
//     (it looks the row up with LeaderboardGetPlayerIndex).
//
// The UI polls these records (src/ui/leaderboard.ts) rather than being pushed at, for the
// same reason the text tags do: a board is configured across many calls (label, then rows,
// then style, then Display), so there is no single moment worth snapshotting.

import type { JassPlayer, LeaderboardItem, LeaderboardObj, NativeCtx, Runtime } from "../runtime";
import { asInt, asStr, jBool, jHandle, jInt, JNULL, jStr, truthy, type JassValue } from "../values";

type NativeFn = (ctx: NativeCtx, args: JassValue[]) => JassValue;
const def = (rt: Runtime, name: string, fn: NativeFn): void => void rt.natives.set(name, fn);
const board = (c: NativeCtx, v: JassValue): LeaderboardObj | undefined => c.rt.data<LeaderboardObj>(v);
const playerIndex = (c: NativeCtx, v: JassValue): number => c.rt.data<JassPlayer>(v)?.index ?? 0;

/** Pack an (r,g,b,a) 0–255 quad as 0xAARRGGBB — the same layout SetTextTagColor uses. */
const rgba = (r: number, g: number, b: number, a: number): number =>
  (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;

/** Run `fn` on the board and mark it changed, so the UI rebuilds exactly once per tick
 *  no matter how many setters a trigger walks through. */
function edit(c: NativeCtx, v: JassValue, fn: (lb: LeaderboardObj) => void): JassValue {
  const lb = board(c, v);
  if (lb) {
    fn(lb);
    lb.revision++;
  }
  return JNULL;
}

/** The row at `index`, or undefined — every Leaderboard*Item* native is index-addressed
 *  and WC3 tolerates an out-of-range index silently (LeaderboardGetPlayerIndex returns
 *  -1 for an absent player, and the BJs feed that straight back in). */
function row(lb: LeaderboardObj, index: number): LeaderboardItem | undefined {
  return index >= 0 && index < lb.items.length ? lb.items[index] : undefined;
}

export function registerLeaderboardNatives(rt: Runtime): void {
  def(rt, "CreateLeaderboard", (c) => {
    const lb: LeaderboardObj = {
      handleId: 0, label: "", items: [], displayed: false, rows: 0,
      showLabel: true, showNames: true, showValues: true, showIcons: true,
      labelColor: 0xffffffff, valueColor: 0xffffffff, revision: 0,
    };
    lb.handleId = c.rt.handles.alloc(lb);
    c.rt.leaderboards.push(lb);
    return jHandle(lb.handleId, "leaderboard");
  });
  def(rt, "DestroyLeaderboard", (c, a) => {
    const lb = board(c, a[0]);
    if (lb) {
      const i = c.rt.leaderboards.indexOf(lb);
      if (i >= 0) c.rt.leaderboards.splice(i, 1);
      // Un-assign it from anyone still looking at it, or the UI would keep drawing a
      // destroyed board (leaderboardFor resolves through the handle table).
      for (const [p, hid] of c.rt.playerBoards) if (hid === lb.handleId) c.rt.playerBoards.delete(p);
      c.rt.handles.free(lb.handleId);
    }
    return JNULL;
  });

  // --- display / assignment -------------------------------------------------------
  // A board is on screen only if it is DISPLAYED *and* assigned to the viewing player.
  // CreateLeaderboardBJ does both (ForceSetLeaderboardBJ over a force, then Display).
  def(rt, "LeaderboardDisplay", (c, a) => edit(c, a[0], (lb) => (lb.displayed = truthy(a[1]))));
  def(rt, "IsLeaderboardDisplayed", (c, a) => jBool(board(c, a[0])?.displayed ?? false));
  def(rt, "PlayerSetLeaderboard", (c, a) => {
    const p = playerIndex(c, a[0]);
    const lb = board(c, a[1]);
    if (lb) c.rt.playerBoards.set(p, lb.handleId);
    else c.rt.playerBoards.delete(p); // PlayerSetLeaderboard(p, null) detaches
    return JNULL;
  });
  def(rt, "PlayerGetLeaderboard", (c, a) => {
    const hid = c.rt.playerBoards.get(playerIndex(c, a[0]));
    return hid === undefined ? JNULL : jHandle(hid, "leaderboard");
  });

  // --- rows -----------------------------------------------------------------------
  def(rt, "LeaderboardAddItem", (c, a) =>
    edit(c, a[0], (lb) =>
      lb.items.push({
        label: asStr(a[1]),
        value: asInt(a[2]),
        player: playerIndex(c, a[3]),
        showLabel: true, showValue: true, showIcon: true,
        labelColor: null, valueColor: null,
      }),
    ),
  );
  def(rt, "LeaderboardRemoveItem", (c, a) =>
    edit(c, a[0], (lb) => {
      const i = asInt(a[1]);
      if (i >= 0 && i < lb.items.length) lb.items.splice(i, 1);
    }),
  );
  def(rt, "LeaderboardRemovePlayerItem", (c, a) =>
    edit(c, a[0], (lb) => {
      const p = playerIndex(c, a[1]);
      const i = lb.items.findIndex((it) => it.player === p);
      if (i >= 0) lb.items.splice(i, 1);
    }),
  );
  def(rt, "LeaderboardClear", (c, a) => edit(c, a[0], (lb) => (lb.items = [])));
  def(rt, "LeaderboardGetItemCount", (c, a) => jInt(board(c, a[0])?.items.length ?? 0));
  def(rt, "LeaderboardSetSizeByItemCount", (c, a) => edit(c, a[0], (lb) => (lb.rows = asInt(a[1]))));
  def(rt, "LeaderboardHasPlayerItem", (c, a) => {
    const lb = board(c, a[0]);
    const p = playerIndex(c, a[1]);
    return jBool(!!lb && lb.items.some((it) => it.player === p));
  });
  def(rt, "LeaderboardGetPlayerIndex", (c, a) => {
    const lb = board(c, a[0]);
    const p = playerIndex(c, a[1]);
    return jInt(lb ? lb.items.findIndex((it) => it.player === p) : -1);
  });

  // --- the board's own label ------------------------------------------------------
  def(rt, "LeaderboardSetLabel", (c, a) => edit(c, a[0], (lb) => (lb.label = asStr(a[1]))));
  def(rt, "LeaderboardGetLabelText", (c, a) => jStr(board(c, a[0])?.label ?? ""));

  // --- sorting --------------------------------------------------------------------
  // LeaderboardSortItemsBJ dispatches to these three by sort type. WC3's sort is stable
  // in practice (rows added in the same tick keep their order when they tie), and Array
  // .sort has been stable since ES2019 — so a value tie keeps insertion order, which is
  // what a "Kills" board relies on to look settled instead of jittering every update.
  def(rt, "LeaderboardSortItemsByValue", (c, a) =>
    edit(c, a[0], (lb) => sort(lb, truthy(a[1]), (x, y) => x.value - y.value)),
  );
  def(rt, "LeaderboardSortItemsByPlayer", (c, a) =>
    edit(c, a[0], (lb) => sort(lb, truthy(a[1]), (x, y) => x.player - y.player)),
  );
  def(rt, "LeaderboardSortItemsByLabel", (c, a) =>
    edit(c, a[0], (lb) => sort(lb, truthy(a[1]), (x, y) => x.label.localeCompare(y.label))),
  );

  // --- style + colours ------------------------------------------------------------
  def(rt, "LeaderboardSetStyle", (c, a) =>
    edit(c, a[0], (lb) => {
      lb.showLabel = truthy(a[1]);
      lb.showNames = truthy(a[2]);
      lb.showValues = truthy(a[3]);
      lb.showIcons = truthy(a[4]);
    }),
  );
  def(rt, "LeaderboardSetLabelColor", (c, a) =>
    edit(c, a[0], (lb) => (lb.labelColor = rgba(asInt(a[1]), asInt(a[2]), asInt(a[3]), asInt(a[4])))),
  );
  def(rt, "LeaderboardSetValueColor", (c, a) =>
    edit(c, a[0], (lb) => (lb.valueColor = rgba(asInt(a[1]), asInt(a[2]), asInt(a[3]), asInt(a[4])))),
  );

  // --- per-row setters (what LeaderboardSetPlayerItem*BJ resolves to) --------------
  def(rt, "LeaderboardSetItemValue", (c, a) =>
    edit(c, a[0], (lb) => {
      const it = row(lb, asInt(a[1]));
      if (it) it.value = asInt(a[2]);
    }),
  );
  def(rt, "LeaderboardSetItemLabel", (c, a) =>
    edit(c, a[0], (lb) => {
      const it = row(lb, asInt(a[1]));
      if (it) it.label = asStr(a[2]);
    }),
  );
  def(rt, "LeaderboardSetItemStyle", (c, a) =>
    edit(c, a[0], (lb) => {
      const it = row(lb, asInt(a[1]));
      if (it) {
        it.showLabel = truthy(a[2]);
        it.showValue = truthy(a[3]);
        it.showIcon = truthy(a[4]);
      }
    }),
  );
  def(rt, "LeaderboardSetItemLabelColor", (c, a) =>
    edit(c, a[0], (lb) => {
      const it = row(lb, asInt(a[1]));
      if (it) it.labelColor = rgba(asInt(a[2]), asInt(a[3]), asInt(a[4]), asInt(a[5]));
    }),
  );
  def(rt, "LeaderboardSetItemValueColor", (c, a) =>
    edit(c, a[0], (lb) => {
      const it = row(lb, asInt(a[1]));
      if (it) it.valueColor = rgba(asInt(a[2]), asInt(a[3]), asInt(a[4]), asInt(a[5]));
    }),
  );
}

/** Sort the rows in place. `ascending` is the caller's word for it; a DESCENDING board
 *  (the usual one — highest score at the top) just reverses the comparison. */
function sort(lb: LeaderboardObj, ascending: boolean, cmp: (a: LeaderboardItem, b: LeaderboardItem) => number): void {
  lb.items.sort((a, b) => (ascending ? cmp(a, b) : cmp(b, a)));
}
