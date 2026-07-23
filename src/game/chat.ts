// In-game chat: who a message reaches, and what it reads as.
//
// Kept pure — no DOM, no sim, no wire — because the two rules worth being sure of are both
// decidable from data alone, and both are easy to get subtly wrong:
//
//   • WHO HEARS IT. "Allies" is not a team number. Alliances are a DIRECTED per-pair matrix
//     (src/sim/alliances.ts), so allied chat has to ask blizzard.j's own question —
//     PlayersAreCoAllied, which reads ALLIANCE_PASSIVE in BOTH directions — rather than
//     compare teams. A player who has granted you passive but not been granted it back is
//     not your ally and must not read your chat.
//   • WHAT IT SAYS. Every word of it is the game's: `UI\FrameDef\GlobalStrings.fdf` carries
//     the entry-line prompts (COLON_MESSAGE_ALL "To All:", COLON_MESSAGE_ALLIES "To Allies:",
//     COLON_MESSAGE_PLAYER "To %s:", and COLON_MESSAGE_SINGLEPLAYER "Message:" — because with
//     nobody to address, the game does not ask who) and the recipient tags a received line
//     wears (CHAT_RECIPIENT_ALL "[All]", CHAT_RECIPIENT_ALLIES "[Allies]", …). None of it is
//     spelled here, so a localized install says what it says.
//
// The sender is NEVER carried in a chat message from the wire. Same rule the command stream
// runs on (src/net/commandLink.ts): identity comes from the relay's own stamp, or a client
// could speak as anybody.

/** Who a message is addressed to. The `all`/`allies` pair is what the two send keys bind to
 *  (Enter and Ctrl+Enter); `private` is the F12 dialog's Send to Player. */
export type ChatScope = "all" | "allies" | "observers" | "private";

export interface ChatTarget {
  scope: ChatScope;
  /** The recipient, for `private` only. */
  player?: number;
}

/** One line as it happened: who said it, what they said, and who they said it to. */
export interface ChatLine {
  from: number;
  text: string;
  target: ChatTarget;
}

/** What the model needs to know about the match to route a line. */
export interface ChatWorld {
  /** Every seated player, the sender included. */
  players(): readonly number[];
  /** blizzard.j's PlayersAreCoAllied — BOTH directions of ALLIANCE_PASSIVE. */
  coAllied(a: number, b: number): boolean;
  /** Is this player watching rather than playing? (No observer slots yet — always false.) */
  isObserver(player: number): boolean;
}

/**
 * Who receives a line, the sender included — you see your own chat, which is not a detail to
 * skip: it is the only confirmation that a message was sent at all.
 *
 * A private message reaches exactly two people, and reaches the sender even when they addressed
 * somebody who has since left, so a message never silently evaporates.
 */
export function chatRecipients(line: ChatLine, world: ChatWorld): number[] {
  const { from, target } = line;
  const all = world.players();
  switch (target.scope) {
    case "all":
      return all.slice();
    case "allies":
      return all.filter((p) => p === from || world.coAllied(from, p));
    case "observers":
      return all.filter((p) => p === from || world.isObserver(p));
    case "private": {
      const to = target.player;
      return to === undefined || to === from ? [from] : [from, to];
    }
  }
}

/** The GlobalStrings this module speaks with — passed in, never spelled out. */
export interface ChatStrings {
  (key: string): string | undefined;
}

/**
 * The entry line's prompt: "To All:", "To Allies:", "To Player 2:" — or plain "Message:" in a
 * single-player game, which is the game's own behaviour and not a shortcut. `COLON_MESSAGE_PLAYER`
 * is a `%s` format, the only one of the five that is.
 */
export function chatPrompt(
  target: ChatTarget,
  multiplayer: boolean,
  nameOf: (player: number) => string,
  strings: ChatStrings,
): string {
  if (!multiplayer) return strings("COLON_MESSAGE_SINGLEPLAYER") ?? "Message:";
  switch (target.scope) {
    case "allies":
      return strings("COLON_MESSAGE_ALLIES") ?? "To Allies:";
    case "observers":
      return strings("COLON_MESSAGE_OBSERVERS") ?? "To Observers:";
    case "private":
      return (strings("COLON_MESSAGE_PLAYER") ?? "To %s:").replace(
        "%s",
        target.player === undefined ? "" : nameOf(target.player),
      );
    case "all":
      return strings("COLON_MESSAGE_ALL") ?? "To All:";
  }
}

/** The bracketed audience tag a received line wears. Empty for a plain all-chat line in a
 *  single-player game, where there is only one audience and naming it says nothing. */
export function chatRecipientTag(target: ChatTarget, multiplayer: boolean, strings: ChatStrings): string {
  if (!multiplayer) return "";
  switch (target.scope) {
    case "allies":
      return strings("CHAT_RECIPIENT_ALLIES") ?? "[Allies]";
    case "observers":
      return strings("CHAT_RECIPIENT_OBSERVERS") ?? "[Observers]";
    case "private":
      return strings("CHAT_RECIPIENT_PRIVATE") ?? "[Private]";
    case "all":
      return strings("CHAT_RECIPIENT_ALL") ?? "[All]";
  }
}

/**
 * One line as WC3 markup, ready for the message area and the log: the speaker's name in the
 * speaker's own colour, the audience tag, then the text.
 *
 * The name carries the colour and the message does NOT — a player cannot colour their own
 * chat by typing `|cff...` into it, because the text is escaped by the renderer's markup pass
 * only for the parts we build. So the message body is stripped of markup codes here: left in,
 * a player could paint their message, forge a `|n` line break, or open a colour span that
 * bleeds into every line drawn after theirs.
 */
export function formatChatLine(
  line: ChatLine,
  multiplayer: boolean,
  nameOf: (player: number) => string,
  colorOf: (player: number) => string | null,
  strings: ChatStrings,
): string {
  const tag = chatRecipientTag(line.target, multiplayer, strings);
  const color = colorOf(line.from);
  const name = `${nameOf(line.from)}${tag ? ` ${tag}` : ""}`;
  const head = color ? `|c${color}${name}|r` : name;
  return `${head}: ${stripMarkup(line.text)}`;
}

/** Strip WC3 markup codes from player-typed text — see formatChatLine. */
export function stripMarkup(text: string): string {
  return text.replace(/\|[cC][0-9a-fA-F]{8}/g, "").replace(/\|[rRnN]/g, "");
}

/** The longest message the game accepts. WC3's own chat edit box stops here, and a cap is
 *  also what stops a peer flooding every other player's message area from one keystroke. */
export const CHAT_MAX_LENGTH = 127;

/** Trim and cap a typed message; empty means "nothing was said", and nothing is sent. */
export function sanitizeChat(text: string): string {
  return stripMarkup(text).trim().slice(0, CHAT_MAX_LENGTH);
}
