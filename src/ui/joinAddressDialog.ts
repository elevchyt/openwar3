import type { DataSource } from "../vfs/types";
import type { LanLobby } from "../net/lobby";
import { normalizeRelayUrl } from "../net/lobby";
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
// Everything it changes lives on the `LanLobby`: `addRelay` opens a browse connection, whose
// games merge into the screen's list under the room `key` that tells two relays' rooms apart,
// and `removeRelay` closes one again.

const DIALOG_FDF = "UI\\FrameDef\\Glue\\DialogWar3.fdf";
const LIST_FDF = "UI\\FrameDef\\Glue\\ListBoxWar3.fdf";

export interface JoinAddressDialog {
  close(): void;
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
      relays.map((url): ListItem => ({
        value: url,
        label: authorityOf(url),
        // The row IS the address, so its control removes it — no "select the row, then press
        // the button under the list", which is a step a three-row list does not need.
        action: {
          label: "✕",
          title: `Remove ${authorityOf(url)}`,
          onClick: () => {
            opts.lobby.removeRelay(url);
            message = null;
            paint();
            opts.onChange?.();
          },
        },
      })),
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
    // Checked here as well as in `addRelay` so a typo is answered instantly rather than after a
    // socket has been opened at a hostname that cannot exist.
    if (!normalizeRelayUrl(typed)) {
      message = `"${typed}" is not an address.`;
      warn = true;
      return paint();
    }
    message = `Looking for a game at ${typed}…`;
    warn = false;
    paint();
    void opts.lobby.addRelay(typed).then(
      () => {
        if (box) box.value = "";
        message = null;
        warn = false;
        paint();
        opts.onChange?.();
      },
      (err: Error) => {
        // A relay that is not there rejects with the transport's own sentence, which names a
        // dev command; in this box the fault is almost always the address, so say that instead.
        message = /no relay at/i.test(err.message) ? `No game answered at ${typed}.` : err.message;
        warn = true;
        paint();
      },
    );
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
  return { close };
}
