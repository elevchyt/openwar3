import type { DataSource } from "../vfs/types";
import type { LanLobby } from "../net/lobby";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import type { ListItem } from "./fdf/widgets";
import { adopt, setProp } from "./mapBrowser";
import { JOIN_ADDRESS_DIALOG_OVERRIDE, OW3_STRINGS } from "../overrides";
import { LABEL_GOLD } from "./fdfLan";

// "Join by address" — the machines this one is watching for games (issue: LAN discovery).
//
// **What it is for.** Real WC3 broadcast on the subnet, so a game on the network appeared in the
// list and nobody typed anything. A browser cannot send a datagram, and the packaged game's
// window has no address bar, so two copies of OpenWar3 on one network cannot find each other at
// all: somebody has to say where to look. Until the UDP beacon lands (docs/multiplayer.md), this
// is the whole of discovery.
//
// **Why a dialog and not a field on the screen behind it.** Because it is a LIST. An address is
// kept, re-used and thrown away, and the LAN screen has 0.027 of clear panel under its games
// list — measured, after two attempts — which is not enough for an edit box, let alone a list
// and a way to remove a row. The chrome is the glue's own (see the FDF), it is centred, and the
// scrim behind it is darkened, because a panel that is a place of its own should say so.
//
// Everything it changes lives on the `LanLobby`: `addRelay` takes an address and keeps knocking
// at it, and the games of whichever ones are answering merge into the screen's list under the
// room `key` that tells two relays' rooms apart; `removeRelay` drops one again. An address that
// nothing is hosting on is not a failure and is never reported as one — the other player has
// simply not started their game yet, and the row waits for them.

const DIALOG_FDF = "UI\\FrameDef\\Glue\\DialogWar3.fdf";
const LIST_FDF = "UI\\FrameDef\\Glue\\ListBoxWar3.fdf";

export interface JoinAddressDialog {
  close(): void;
  /** Re-read the lobby and repaint. The dialog EDITS the lobby but does not own it: a knock
   *  that lands while the box is open (`LanLobby.dial`) changes a row from waiting to answering
   *  with nobody having touched anything, and a dialog that only painted on its own events sat
   *  there saying "waiting" at a machine whose games were already in the list behind it. */
  refresh(): void;
}

/** Strip the wire's own dressing back to what the player typed: `ws://1.2.3.4:8787/relay` is
 *  our business, `1.2.3.4:8787` is theirs. */
function authorityOf(url: string): string {
  return url.replace(/^wss?:\/\//, "").replace(/\/relay$/, "");
}

/** The dialog's own root: our frame, with the shared list box dropped into the empty container
 *  it leaves — the same composition the Single Player screen's Profile List is made by. */
function buildRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("JoinAddressDialog");
  if (!root) throw new Error("JoinAddressDialog.fdf: no JoinAddressDialog frame");
  const listBox = lib.resolveRoot("ListBoxWar3");
  if (listBox) {
    // Renamed on the way in: `ListBoxWar3` is shared, and the list this dialog asks for by name
    // has to be its own.
    const list: FdfFrame = { ...listBox, name: "JoinAddressList" };
    setProp(list, "SetAllPoints", []); // fill the container the FDF already sized
    adopt(root, "JoinAddressListContainer", [list]);
  }
  return root;
}

/**
 * Put the dialog up over the LAN screen. Resolves once it is on screen; `close()` takes it and
 * its scrim away, and so does its own Done button and Escape.
 *
 * `onChange` fires whenever the watched set changes, so the screen underneath can re-render its
 * game list — the dialog holds no list of its own, it edits the lobby's.
 */
export async function showJoinAddressDialog(opts: {
  container: HTMLElement;
  vfs: DataSource;
  lobby: LanLobby;
  onChange?: () => void;
  /** Fired when the dialog takes itself away (Done, Escape, a click on the scrim), so the
   *  screen underneath can stop holding on to it. */
  onClosed?: () => void;
}): Promise<JoinAddressDialog> {
  const scrim = document.createElement("div");
  scrim.className = "glue-dialog-scrim dimmed";
  opts.container.appendChild(scrim);

  let screen: FdfScreen | null = null;
  let message: string | null = null;
  let warn = false;

  const close = (): void => {
    window.removeEventListener("keydown", onKey, true);
    screen?.dispose();
    scrim.remove();
    opts.onClosed?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener("keydown", onKey, true);
  // A click on the scrim itself — outside the box — closes it, the way a modal is expected to.
  scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) close(); });

  const paint = (): void => {
    const s = screen;
    if (!s) return;
    const relays = opts.lobby.relays;
    s.list("JoinAddressList")?.setItems(
      relays.map(({ url, connected, source }): ListItem => {
        // Two states worth saying out loud, and they are not the same thing. An address nobody
        // is hosting on YET is the ordinary case — two people sitting down to play, one of them
        // not there yet — so it is a quiet marker on the row and never an error; the lobby keeps
        // knocking. A machine the NETWORK told us about (the desktop app's beacon) says so
        // instead, because the player did not put it there and should not wonder how it arrived.
        const note = !connected ? "  |cff808080(waiting)|r"
          : source === "found" ? "  |cff808080(on your network)|r"
          : "";
        return {
          value: url,
          label: `${authorityOf(url)}${note}`,
          // The row IS the address, so its control removes it — no "select the row, then press
          // the button under the list", which is a step a three-row list does not need.
          //
          // A FOUND one has no ✕: it is not the player's to remove. The machine is broadcasting,
          // so it would be back on the list within two seconds, and a button that undoes itself
          // while you watch is worse than no button. Theirs go when they close their game.
          action: source === "found" ? undefined : {
            label: "✕",
            title: `Remove ${authorityOf(url)}`,
            onClick: () => {
              opts.lobby.removeRelay(url);
              message = null;
              paint();
              opts.onChange?.();
            },
          },
        };
      }),
    );
    s.setText(
      "JoinAddressDialogInfo",
      message !== null
        ? `|cff${warn ? "ff8080" : LABEL_GOLD}${message}|r`
        : "Games created on these servers will appear on your games list.",
    );
  };

  const submit = (): void => {
    const s = screen;
    const box = s?.editBox("JoinAddressDialogEditBox");
    const typed = box?.value.trim() ?? "";
    if (!typed) return;
    try {
      // Only the two answers that are the PLAYER's mistake throw — a typo, and their own
      // address. Whether anything is listening is not one of them: `addRelay` takes the address
      // on the spot and keeps knocking, so the row appears either way and nothing here waits.
      opts.lobby.addRelay(typed);
    } catch (err) {
      message = (err as Error).message;
      warn = true;
      return paint();
    }
    if (box) box.value = "";
    message = null;
    warn = false;
    paint();
    opts.onChange?.();
  };

  try {
    screen = await mountFdfScreen({
      container: scrim,
      vfs: opts.vfs,
      fdfPath: DIALOG_FDF,
      includeFdf: [LIST_FDF],
      rootFrame: "JoinAddressDialog",
      overrides: [OW3_STRINGS, JOIN_ADDRESS_DIALOG_OVERRIDE],
      buildRoot,
      centerRoot: true, // the FDF gives the box its own size and no anchors
      textOverrides: {
        JoinAddressDialogTitle: "Join Server",
        JoinAddressListLabel: "Servers:",
        JoinAddressAddButtonText: "Add",
        JoinAddressDoneButtonText: "Done",
      },
      handlers: {
        JoinAddressAddButton: submit,
        JoinAddressDoneButton: close,
      },
      onBuild: (s) => {
        screen = s;
        const box = s.editBox("JoinAddressDialogEditBox");
        if (box) box.onSubmit = submit;
        const input = s.frame("JoinAddressDialogEditBox")?.querySelector("input");
        if (input) input.placeholder = "192.168.1.42";
        paint();
        box?.focus();
      },
    });
  } catch (err) {
    close();
    throw err;
  }
  return { close, refresh: paint };
}
