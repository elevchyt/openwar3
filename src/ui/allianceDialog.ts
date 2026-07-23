// The F11 Allies dialog, built from `UI\FrameDef\UI\AllianceDialog.fdf` + `AllianceSlot.fdf`.
//
// Two files, because the dialog is a TABLE and the engine stamps its rows: AllianceDialog
// declares the frame, the four column headers and the Accept / Cancel pair, and AllianceSlot
// is one player's row (colour swatch, name, three check boxes, a gold field and a lumber
// field) sitting at top level with no parent, waiting to be cloned per player.
//
// The column headers are chained off ONE ANOTHER —
//
//     Frame "TEXT" "PlayersHeader" { SetPoint TOPLEFT, "AllianceDialog", TOPLEFT, …, Text "PLAYERS" }
//     Frame "TEXT" "AllyHeader"    { SetPoint BOTTOMLEFT, "PlayersHeader", BOTTOMRIGHT, 0.196, 0 }
//
// — so where the "Ally" column sits is a function of how wide the word "Players" renders.
// That is the engine's TEXT auto-size, and it is why `layout()` measures (ui/fdf/layout.ts's
// MeasureText). It pays off exactly here: measured, the headers land within 0.002 world units
// of the check-box columns the rows put under them, with nothing hand-placed.
//
// The three check boxes are the real `alliancetype` matrix (src/sim/alliances.ts), which is
// DIRECTED — a row says what the LOCAL player grants that player, not what they have agreed:
//
//     Ally         → ALLIANCE_PASSIVE         (don't shoot each other)
//     Share Vision → ALLIANCE_SHARED_VISION
//     Share Units  → ALLIANCE_SHARED_CONTROL
//
// Nothing is committed until Accept, which is the FDF's own Accept / Cancel pair doing what
// it says — and is also why a click can't half-apply an alliance.

import { AllianceType } from "../sim/alliances";
import { blpToCanvas } from "../render/blputil";
import type { DataSource } from "../vfs/types";
import type { Arg, FdfFrame, FdfProp } from "./fdf/parser";
import { cloneNamespaced, type FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";

const ALLIANCE_FDF = "UI\\FrameDef\\UI\\AllianceDialog.fdf";
const ALLIANCE_SLOT_FDF = "UI\\FrameDef\\UI\\AllianceSlot.fdf";
const TEAM_COLOR = (i: number) => `ReplaceableTextures\\TeamColor\\TeamColor${String(i).padStart(2, "0")}.blp`;

// In the FDF's 0.8×0.6 world units. The row's own geometry is the file's (0.528 × 0.024);
// these are the numbers the ENGINE owns — where the stack of rows begins and its pitch.
// ROW_X centres the 0.528-wide row in the 0.576-wide dialog, which is what puts each row's
// colour swatch under the "Players" header.
const ROW_X = 0.024;
const ROW_TOP = 0.078; // below PlayersHeader (anchored at -0.060875, one 0.011 line tall)
const ROW_PITCH = 0.026; // the row's 0.024 plus the hairline between two

const s = (v: string): Arg => ({ s: v, n: null, str: true });
const word = (v: string): Arg => ({ s: v, n: null, str: false });
const num = (v: number): Arg => ({ s: String(v), n: v, str: false });
const prop = (key: string, ...args: Arg[]): FdfProp => ({ key, args });

/** The three columns, in the order the FDF's headers run. */
const COLUMNS: Array<{ frame: string; type: AllianceType }> = [
  { frame: "AllyCheckBox", type: AllianceType.Passive },
  { frame: "VisionCheckBox", type: AllianceType.SharedVision },
  { frame: "UnitsCheckBox", type: AllianceType.SharedControl },
];

/** One other player in the match — the local player has no row of their own. */
export interface AlliancePeer {
  id: number;
  /** The lobby's label ("Player 2", "Computer (Normal)"). */
  name: string;
}

export interface AllianceModel {
  localPlayer: number;
  peers(): AlliancePeer[];
  /** GetPlayerAlliance(local, other, type). */
  get(other: number, type: AllianceType): boolean;
  /** SetPlayerAlliance(local, other, type, value) — only ever called on Accept. */
  set(other: number, type: AllianceType, value: boolean): void;
  /** What the local player can spend right now, so a gift can't overdraw it. */
  stash(): { gold: number; lumber: number };
  /** Hand resources to an ally (the dialog's Gold / Lumber fields). */
  trade(other: number, gold: number, lumber: number): void;
  /**
   * False on a LAN client. Every write here is PLAYER-scoped, and the command protocol
   * (src/game/commands.ts) is entirely unit-scoped — there is no message that carries "player
   * 0 now grants player 1 shared vision" to the authority. Applying it locally instead would
   * put this machine's alliance matrix out of step with the host's, and alliances gate
   * targeting, so the two would disagree about who may shoot whom. Until a player-scoped
   * command exists the dialog is READ-ONLY there: it still shows the truth, it just can't
   * change it. (Single player is the authority, so it writes normally.)
   */
  writable: boolean;
}

export class AllianceDialogOverlay {
  private screen: FdfScreen | null = null;
  private scrim: HTMLElement | null = null;
  private shown = false;
  private mounting = false;
  /** Pending edits, committed by Accept and dropped by Cancel: `${player}:${type}` → value. */
  private pending = new Map<string, boolean>();
  /** Pending gifts, likewise: player → the amounts typed into its two fields. */
  private gifts = new Map<number, { gold: number; lumber: number }>();
  private onEscape: (e: KeyboardEvent) => void;

  constructor(
    private container: HTMLElement,
    private vfs: DataSource,
    private skin: string,
    private model: AllianceModel,
  ) {
    this.onEscape = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !this.shown) return;
      e.preventDefault();
      e.stopPropagation();
      this.hide(); // Escape is Cancel: the pending edits are dropped with the dialog
    };
  }

  get visible(): boolean {
    return this.shown;
  }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.pending.clear();
    this.gifts.clear();
    window.addEventListener("keydown", this.onEscape, true);
    void this.build();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    window.removeEventListener("keydown", this.onEscape, true);
    this.teardown();
  }

  toggle(): boolean {
    if (this.shown) this.hide();
    else this.show();
    return this.shown;
  }

  dispose(): void {
    this.hide();
    this.teardown();
  }

  private teardown(): void {
    this.screen?.dispose();
    this.screen = null;
    this.scrim?.remove();
    this.scrim = null;
  }

  private async build(): Promise<void> {
    if (this.mounting) return;
    this.mounting = true;
    try {
      const prev = this.screen;
      const screen = await mountFdfScreen({
        container: this.container,
        vfs: this.vfs,
        fdfPath: ALLIANCE_FDF,
        // The row template lives in its own file and nothing includes it — the ENGINE loads
        // both and composes them, so we do too.
        includeFdf: [ALLIANCE_SLOT_FDF],
        rootFrame: "AllianceDialog",
        overlayClass: "fdf-ingame fdf-dialog",
        skin: this.skin,
        centerRoot: true,
        buildRoot: (lib) => this.rootFrame(lib),
        handlers: {
          AllianceAcceptButton: () => this.accept(),
          AllianceCancelButton: () => this.hide(),
        },
        textOverrides: this.rowText(),
        onBuild: (built) => this.onBuild(built),
      });
      prev?.dispose();
      this.screen = screen;
      if (!this.scrim) {
        this.scrim = document.createElement("div");
        this.scrim.className = "fdf-dialog-scrim";
        this.container.appendChild(this.scrim);
      }
      this.container.appendChild(screen.element);
    } catch (err) {
      console.warn("[allies] could not mount the FDF panel:", err);
      this.screen = null;
    } finally {
      this.mounting = false;
    }
  }

  /** The dialog with one `AllianceSlot` clone per other player stacked under the headers. */
  private rootFrame(lib: FdfLibrary): FdfFrame {
    const dialog = lib.resolveRoot("AllianceDialog");
    const slot = lib.resolveRoot("AllianceSlot");
    if (!dialog) throw new Error('FDF: frame "AllianceDialog" not found');

    const children = dialog.children.slice();
    if (slot) {
      this.model.peers().forEach((peer, i) => {
        const row = cloneNamespaced(slot, String(peer.id));
        row.props = [
          ...row.props.filter((p) => p.key !== "SetPoint"),
          prop("SetPoint", word("TOPLEFT"), s("AllianceDialog"), word("TOPLEFT"),
            num(ROW_X), num(-(ROW_TOP + i * ROW_PITCH))),
        ];
        children.push(row);
      });
    }
    return { ...dialog, children };
  }

  /** Each row's name label — the only text the FDF leaves the engine to supply. */
  private rowText(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const peer of this.model.peers()) out[`PlayerNameLabel${peer.id}`] = peer.name;
    return out;
  }

  /**
   * Fill the rows in. Runs on every build, resize included, so it must be able to restore
   * the pending edits rather than re-reading the model — a resize mid-dialog would otherwise
   * silently revert everything the player had ticked.
   */
  private onBuild(screen: FdfScreen): void {
    for (const peer of this.model.peers()) {
      this.paintSwatch(screen, peer.id);
      for (const col of COLUMNS) {
        const box = screen.checkBox(`${col.frame}${peer.id}`);
        if (!box) continue;
        box.checked = this.pending.get(key(peer.id, col.type)) ?? this.model.get(peer.id, col.type);
        box.setEnabled(this.model.writable);
        box.onChange = (on) => this.pending.set(key(peer.id, col.type), on);
      }
      this.wireGift(screen, peer.id, "Gold");
      this.wireGift(screen, peer.id, "Lumber");
    }
    // Allied Victory is a GAME RULE (blizzard.j's bj_alliedVictory), not an alliancetype —
    // there is no melee victory condition reading it yet, so it is shown greyed rather than
    // offered as a switch that does nothing.
    screen.setEnabled("AlliedVictoryCheckBox", false);
    screen.setEnabled("AllianceAcceptButton", this.model.writable);
  }

  /** The row's colour chip: the player's own colour, from the game's flat team-colour swatch. */
  private paintSwatch(screen: FdfScreen, player: number): void {
    const el = screen.frame(`ColorBackdrop${player}`);
    const color = this.teamColor(player);
    if (el && color) el.style.background = color;
  }

  /**
   * The gold / lumber gift fields. The FDF declares them as TEXT frames over the
   * `AllianceGold` / `AllianceLumber` textures, not as EDITBOXes — the engine attaches the
   * editing itself, exactly as it supplies a list's rows — so an input goes into the frame
   * the file drew and wears its font.
   */
  private wireGift(screen: FdfScreen, player: number, kind: "Gold" | "Lumber"): void {
    const el = screen.frame(`${kind}Text${player}`);
    if (!el) return;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.className = "fdf-gift-input";
    input.value = String(this.gifts.get(player)?.[kind === "Gold" ? "gold" : "lumber"] ?? 0);
    input.disabled = !this.model.writable;
    const style = getComputedStyle(el);
    input.style.fontSize = style.fontSize;
    el.replaceChildren(input);
    input.addEventListener("input", () => {
      const amount = Math.max(0, Number.parseInt(input.value.replace(/\D/g, ""), 10) || 0);
      const gift = this.gifts.get(player) ?? { gold: 0, lumber: 0 };
      if (kind === "Gold") gift.gold = amount;
      else gift.lumber = amount;
      this.gifts.set(player, gift);
    });
  }

  /** Commit the pending alliance changes and gifts, then close — the Accept button. */
  private accept(): void {
    if (!this.model.writable) return;
    for (const [k, value] of this.pending) {
      const [player, type] = k.split(":").map(Number);
      this.model.set(player, type as AllianceType, value);
    }
    // Gifts are capped at what is actually in the bank, and spent in row order — the same
    // first-come rule the game applies when two gifts together exceed the treasury.
    for (const [player, gift] of this.gifts) {
      const have = this.model.stash();
      const gold = Math.min(gift.gold, have.gold);
      const lumber = Math.min(gift.lumber, have.lumber);
      if (gold > 0 || lumber > 0) this.model.trade(player, gold, lumber);
    }
    this.hide();
  }

  /** The player's colour, read from the game's own flat TeamColorNN.blp swatch. */
  private teamColor(player: number): string | null {
    const cached = teamColorCache.get(player);
    if (cached !== undefined) return cached;
    let out: string | null = null;
    const bytes = this.vfs.rawBytes(TEAM_COLOR(player));
    if (bytes) {
      const px = blpToCanvas(bytes)?.getContext("2d")?.getImageData(0, 0, 1, 1).data;
      if (px) out = `rgb(${px[0]}, ${px[1]}, ${px[2]})`;
    }
    teamColorCache.set(player, out);
    return out;
  }
}

const key = (player: number, type: AllianceType): string => `${player}:${type}`;

/** Player index → CSS colour. The swatches never change, so one decode per colour. */
const teamColorCache = new Map<number, string | null>();
