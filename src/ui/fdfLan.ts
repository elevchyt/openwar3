import type { DataSource } from "../vfs/types";
import type { FdfFrame } from "./fdf/parser";
import type { FdfLibrary } from "./fdf/library";
import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import type { ListItem } from "./fdf/widgets";
import { LanLobby, type LobbyState } from "../net/lobby";

// The Local Area Network screen, built from the game's own
// UI\FrameDef\Glue\LocalMultiplayerJoin.fdf.
//
// WC3's LAN screen lists GAMES on the network, not room codes — and that maps exactly onto
// what our relay serves (src/net/protocol.ts `RoomInfo`), so the original layout needs no
// reinterpretation: the relay IS the discovery mechanism the screen was designed around.
//
// Like Skirmish.fdf, this file declares GameListContainer as an EMPTY frame that the engine
// fills at runtime, so we compose MapListBox.fdf into it through `buildRoot` — the same hook
// and the same reason as ui/fdfSkirmish.ts.
//
// Scope note: this screen creates and joins a room and shows who is in it. Choosing the map
// and launching the match is the NEXT slice — the host's authority does not exist yet
// (docs/multiplayer.md Phase A/B), so "Start" would have nothing to start.

const MAP_LIST_FDF = "UI\\FrameDef\\Glue\\MapListBox.fdf";

export interface LanHandlers {
  onCancel: () => void;
}

export async function mountLanScreen(
  container: HTMLElement,
  vfs: DataSource,
  h: LanHandlers,
): Promise<FdfScreen> {
  const lobby = new LanLobby();
  let screen: FdfScreen;

  // The name you appear as. WC3 remembers this between sessions; so do we.
  const savedName = localStorage.getItem("openwar3.playerName") || "Player";
  const playerName = (): string => screen.editBox("PlayerNameEditBox")?.value?.trim() || savedName;

  screen = await mountFdfScreen({
    container,
    vfs,
    fdfPath: "UI\\FrameDef\\Glue\\LocalMultiplayerJoin.fdf",
    includeFdf: [MAP_LIST_FDF],
    rootFrame: "LocalMultiplayerJoin",
    buildRoot: (lib) => buildLanRoot(lib),
    buttonWidthScale: 1.35,
    // The engine's own strings assume Blizzard's LAN browser; ours says what it does.
    textOverrides: {
      CustomCreateTitle: "Local Area Network",
      CustomCreateInfo: "Games on your network appear below.",
      GameListTitle: "Network Games",
      CreateButtonText: "Create Game",
      JoinButtonText: "Join Game",
    },
    // Load a saved game over the network — not in scope, and greying it out is more honest
    // than a button that does nothing.
    hidden: ["LoadBackdrop"],
    handlers: {
      CreateButton: () => {
        remember();
        lobby.host(`${playerName()}'s Game`, playerName(), "", 12);
      },
      JoinButton: () => {
        remember();
        const roomId = screen.list("MapListBox")?.value;
        if (roomId) lobby.join(roomId, playerName());
      },
      CancelButton: () => {
        // In a room, Cancel backs out of the room first — one Cancel, one level, as the
        // original does. Only from the browser does it leave the screen.
        if (lobby.snapshot.phase === "hosting" || lobby.snapshot.phase === "joined") lobby.leave();
        else {
          lobby.dispose();
          h.onCancel();
        }
      },
    },
  });

  const remember = (): void => localStorage.setItem("openwar3.playerName", playerName());
  const nameBox = screen.editBox("PlayerNameEditBox");
  if (nameBox) nameBox.value = savedName;

  lobby.onChange = (s) => render(screen, s);
  render(screen, lobby.snapshot);

  // Connecting can fail for exactly one interesting reason — no relay is running — and the
  // fix is a command, so say it on screen rather than only in the console.
  lobby.connect().catch((err: Error) => {
    screen.setText("CustomCreateInfo", `|cffff8080${err.message}|r`);
    screen.setEnabled("CreateButton", false);
    screen.setEnabled("JoinButton", false);
  });

  const dispose = screen.dispose.bind(screen);
  screen.dispose = () => {
    lobby.dispose();
    dispose();
  };
  return screen;
}

/** Paint the current lobby state onto the screen. */
function render(s: FdfScreen, st: LobbyState): void {
  const list = s.list("MapListBox");
  const inRoom = st.phase === "hosting" || st.phase === "joined";

  if (inRoom && st.room) {
    // In a room the list becomes the player list — the original swaps to a lobby view here;
    // reusing the one list keeps this slice to the frames the FDF actually gives us.
    list?.setItems(
      st.peers.map((p): ListItem => ({
        value: `peer${p.id}`,
        label: p.host ? `${p.name}  |cffffcc00(host)|r` : p.name,
      })),
    );
    s.setText("GameListTitle", st.room.name);
    s.setText("GameCreatorValue", st.room.hostName);
    s.setText("GameSpeedValue", `${st.peers.length} / ${st.room.maxPlayers} players`);
    s.setText(
      "CustomCreateInfo",
      st.phase === "hosting"
        ? "Waiting for players to join. You are the host."
        : "Joined. Waiting for the host to start.",
    );
  } else {
    list?.setItems(
      st.rooms.map((r): ListItem => ({
        value: r.id,
        label: `${r.name}   |cff909090${r.players}/${r.maxPlayers}|r`,
      })),
    );
    s.setText("GameListTitle", "Network Games");
    s.setText("GameCreatorValue", "");
    s.setText("GameSpeedValue", "");
    if (!st.error) {
      s.setText(
        "CustomCreateInfo",
        st.rooms.length ? "Select a game and choose Join." : "No games found. Create one.",
      );
    }
  }

  if (st.error) s.setText("CustomCreateInfo", `|cffff8080${st.error}|r`);

  s.setEnabled("CreateButton", st.phase === "browsing");
  s.setEnabled("JoinButton", st.phase === "browsing" && st.rooms.length > 0);
}

/** Compose the screen the way the engine does: MapListBox.fdf into the empty container. */
function buildLanRoot(lib: FdfLibrary): FdfFrame {
  const root = lib.resolveRoot("LocalMultiplayerJoin");
  if (!root) throw new Error("LocalMultiplayerJoin.fdf: no LocalMultiplayerJoin frame");

  // GameListTitle / PlayerNameLabel / GameListLabel are TEXT frames that declare NO
  // Width/Height — the engine auto-sizes a TEXT frame to its string, so the FDF doesn't
  // bother. Our layout stretches an unsized frame to fill instead, which matters here
  // because this screen chains its anchors down a ladder of them
  // (title → label → editbox → list, each SetPoint TOPLEFT … BOTTOMLEFT): one full-height
  // frame pushes everything below it off the bottom of the screen. Give them their real
  // heights, as fdfSkirmish.ts does for the frames the engine positions in code.
  // (A general fix — auto-height for unsized TEXT frames — belongs in ui/fdf/layout.ts.)
  size(findFrame(root, "GameListTitle"), LIST_W, 0.022);
  size(findFrame(root, "PlayerNameLabel"), LIST_W, 0.016);
  size(findFrame(root, "GameListLabel"), LIST_W, 0.016);

  const listBox = lib.resolveRoot("MapListBox");
  if (listBox) {
    setProp(listBox, "SetAllPoints", []); // fill the container the FDF already sized
    adopt(root, "GameListContainer", [listBox]);
  }
  return root;
}

/** The left column's width, as LocalMultiplayerJoin.fdf sizes its editbox and list. */
const LIST_W = 0.37;

// --- small FdfFrame helpers (mirrors of the ones in fdfSkirmish.ts) -------------------

function findFrame(f: FdfFrame, name: string): FdfFrame | undefined {
  if (f.name === name) return f;
  for (const c of f.children) {
    const hit = findFrame(c, name);
    if (hit) return hit;
  }
  return undefined;
}

function adopt(root: FdfFrame, container: string, children: FdfFrame[]): void {
  const target = findFrame(root, container);
  if (target) target.children.push(...children);
}

function setProp(
  f: FdfFrame | undefined,
  key: string,
  args: Array<{ s: string; n: number | null; str: boolean }>,
): void {
  if (!f) return;
  f.props = f.props.filter((p) => p.key !== key);
  f.props.push({ key, args });
}

const num = (n: number) => ({ s: String(n), n, str: false });

function size(f: FdfFrame | undefined, w: number, h: number): void {
  setProp(f, "Width", [num(w)]);
  setProp(f, "Height", [num(h)]);
}
