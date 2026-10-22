// A match's wire, carried DIRECT between each client and the host where the network allows it
// (docs/multiplayer.md "Direct links (WebRTC)").
//
// Over the OpenWar3 server every message hairpins: player → relay → host → relay → player, two
// round trips to Amsterdam for what is one round trip between two machines that may sit in the
// same city. Two players in Greece measured 130–150 ms in game against ~64 ms to the relay. So
// once a match starts, every client opens an `RTCDataChannel` to the HOST — the only machine
// anybody's traffic is for: the authority does not move and the topology stays a star — and the
// relay is left doing what it is good at: introducing the two (the offer, the answer and the ICE
// candidates ride the ordinary opaque `relay`/`deliver` envelope, addressed by peer id like any
// other game traffic, so the server needs no change at all) and carrying whatever cannot go direct.
//
// This is a DECORATOR over the relay channel, behind the `MatchChannel` seam the match already
// talks to, so `MatchLink`, the load gate and the menus' end-of-match hooks cannot tell which
// path a message took. Four rules make that true:
//
//   • ONE ordered, reliable channel per link. A snapshot is a STATE, but it also carries EVENTS
//     (fx bursts, notices, felled trees told once), and the client drops a payload older than the
//     one it holds — so an unreliable or unordered lane would lose a spell's burst or a tree
//     outright. Splitting the events out is what an unreliable lane would cost, and is deferred.
//   • THE CUTOVER IS ORDERED. Traffic sent over the relay before a link opened may still be in
//     flight when the first direct message lands, and commands must not overtake each other (the
//     host counts them for `WorldSnapshot.ack`). So each side, the moment its end opens, sends a
//     `cut` marker over the RELAY and only then switches; the far side holds direct traffic from
//     that peer until the marker arrives, which the relay — one ordered socket each way — delivers
//     after everything sent before it.
//   • THE RELAY IS THE FALLBACK. A link that does not open (a symmetric NAT, a firewall that drops
//     UDP) or that dies mid-match leaves that peer on the relay, exactly as before this file. A
//     client re-offers a dead link a couple of times; the host only ever answers.
//   • IDENTITY IS THE RELAY'S. A link is bound to the peer id the relay stamped on its offer, so a
//     direct message is attributed exactly as the relay would have attributed it.
//
// What it costs: the host's IP address becomes visible to its players and theirs to it (the ICE
// candidates are addresses). `DirectLinks.enabled = false` (`?direct=0` on a dev boot) keeps a
// match on the relay alone.

import type { MatchChannel } from "../game/matchLink";

/** The switch, read when a match starts. Off keeps every message on the relay. */
export const DirectLinks = { enabled: true };

/**
 * Public STUN only: enough for each end to learn the address its NAT shows the world, which is
 * all a cone NAT needs. There is deliberately no TURN — a TURN server relays every byte, which is
 * what the OpenWar3 server already does, so a link ICE cannot open simply stays on that.
 */
const ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];

/** How long a link may take to open before it is given up and its peer stays on the relay. */
const OPEN_TIMEOUT_MS = 10_000;

/** How many times a client offers a link to the host in one match (the first included), and how
 *  long it waits before each retry. A NAT that refused once mostly refuses again. */
const MAX_OFFERS = 3;
const RETRY_MS = [2_000, 10_000];

/**
 * The largest single data-channel message. Chrome advertises 256 KiB, but every SCTP message is
 * reassembled before it is handed over and a big one holds up the ones behind it, so a payload
 * past this is sent in pieces (a late-game snapshot can be ~45 KB; a rejoin catch-up more).
 */
const PIECE = 64 * 1024;
/** A data-channel message is a whole JSON payload, or one of these followed by a piece of one:
 *  JSON never begins with a control character. */
const MORE = "\u0002";
const LAST = "\u0003";

/** Signaling, carried over the relay. `g` is the link's generation: a re-offer starts a new
 *  one, and a candidate or a cut for an older link is ignored. */
interface RtcSignal {
  k: "rtc";
  g: number;
  offer?: string;
  answer?: string;
  ice?: RTCIceCandidateInit;
  cut?: true;
}

function isRtcSignal(data: unknown): data is RtcSignal {
  return typeof data === "object" && data !== null && (data as { k?: unknown }).k === "rtc" && typeof (data as { g?: unknown }).g === "number";
}

/** Makes a peer connection. The browser's, unless a test hands in its own. */
export type RtcFactory = (config: RTCConfiguration) => RTCPeerConnection;

export interface DirectSetup {
  /** This machine's relay peer id. */
  self: number;
  /** The host's relay peer id. */
  hostPeer: number;
  isHost: boolean;
  /** Every OTHER relay peer in the match — seats and observers. A broadcast becomes one send to
   *  each, so the ones with a link get it direct and the rest over the relay. */
  peers: readonly number[];
  rtc?: RtcFactory;
}

/** One client↔host link. */
class Link {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null = null;
  /** Our outgoing traffic to this peer goes direct. */
  sending = false;
  /** The peer's `cut` arrived: everything it sent over the relay first has been delivered. */
  cutHeard = false;
  /** Direct traffic that landed before the cut, in order. */
  held: unknown[] = [];
  /** A payload arriving in pieces. */
  partial = "";
  /** Candidates that arrived before the remote description they belong after. */
  early: RTCIceCandidateInit[] = [];
  timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    readonly peer: number,
    readonly gen: number,
    rtc: RtcFactory,
  ) {
    this.pc = rtc({ iceServers: ICE_SERVERS });
  }
}

export class DirectChannel implements MatchChannel {
  onPeerData: (from: number, data: unknown) => void = () => {};
  onPeerRejoin: (peer: number) => void = () => {};
  onPeerLeave: (peer: number) => void = () => {};
  onRoomClosed: (reason: string) => void = () => {};
  onPeerDrop: (peer: number, holdMs?: number) => void = () => {};
  onLinkLost: () => void = () => {};
  onRejoined: () => void = () => {};
  onDisconnected: () => void = () => {};

  private readonly links = new Map<number, Link>();
  private readonly rtc: RtcFactory;
  private gen = 0;
  private offers = 0;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** Messages each way, for the dev heartbeat and the tests: how much actually went direct. */
  readonly counts = { directOut: 0, relayOut: 0, directIn: 0, relayIn: 0 };

  constructor(
    private readonly inner: MatchChannel,
    private readonly setup: DirectSetup,
  ) {
    this.rtc = setup.rtc ?? ((config) => new RTCPeerConnection(config));
    inner.onPeerData = (from, data) => {
      if (isRtcSignal(data)) return this.signal(from, data);
      this.counts.relayIn++;
      this.onPeerData(from, data);
    };
    inner.onPeerRejoin = (peer) => this.onPeerRejoin(peer);
    inner.onPeerLeave = (peer) => {
      this.drop(peer);
      this.onPeerLeave(peer);
    };
    inner.onRoomClosed = (reason) => {
      this.shutDown();
      this.onRoomClosed(reason);
    };
    // The connection news a dropped player turns on ("Waiting for players..."), passed straight
    // through: it is the RELAY's word on who is connected to it, which a direct lane neither
    // knows nor changes.
    inner.onPeerDrop = (peer, holdMs) => this.onPeerDrop(peer, holdMs);
    inner.onLinkLost = () => this.onLinkLost();
    inner.onRejoined = () => this.onRejoined();
    inner.onDisconnected = () => {
      this.shutDown();
      this.onDisconnected();
    };
    if (!setup.isHost) this.offer();
  }

  /** Is this peer's traffic going direct right now? */
  isDirect(peer: number): boolean {
    return this.links.get(peer)?.sending ?? false;
  }

  send(data: unknown, to?: number): void {
    if (to !== undefined) return this.sendTo(to, data);
    // Nothing direct yet: one relay broadcast, exactly as before — and it reaches anybody in
    // the room the seating did not list.
    let any = false;
    for (const link of this.links.values()) any ||= link.sending;
    if (!any) {
      this.counts.relayOut++;
      return this.inner.send(data);
    }
    for (const peer of this.setup.peers) this.sendTo(peer, data);
  }

  close(): void {
    this.shutDown();
    this.inner.close?.();
  }

  dropPeer(peer: number): void {
    this.drop(peer);
    this.inner.dropPeer?.(peer);
  }

  private sendTo(peer: number, data: unknown): void {
    const link = this.links.get(peer);
    if (link?.sending && link.dc?.readyState === "open") {
      try {
        write(link.dc, JSON.stringify(data));
        this.counts.directOut++;
        return;
      } catch {
        // A channel that throws on send is closing under us: this message takes the relay and
        // the close handler takes the link down.
        link.sending = false;
      }
    }
    this.counts.relayOut++;
    this.inner.send(data, peer);
  }

  // ---- the handshake ---------------------------------------------------------------------------

  /** Client side: offer a link to the host. */
  private offer(): void {
    if (this.closed || this.offers >= MAX_OFFERS) return;
    this.offers++;
    const peer = this.setup.hostPeer;
    const link = this.open(peer, ++this.gen);
    this.attach(link, link.pc.createDataChannel("match", { ordered: true }));
    void (async () => {
      try {
        await link.pc.setLocalDescription(await link.pc.createOffer());
        if (this.links.get(peer) !== link) return;
        this.inner.send({ k: "rtc", g: link.gen, offer: link.pc.localDescription?.sdp } satisfies RtcSignal, peer);
      } catch {
        this.fail(link);
      }
    })();
  }

  /** A signal over the relay. */
  private signal(from: number, msg: RtcSignal): void {
    if (this.closed) return;
    // A host takes offers from the peers in its match and nobody else; a client listens to
    // its host alone. Nobody can open a link on another peer's behalf: `from` is the relay's.
    if (this.setup.isHost ? !this.setup.peers.includes(from) : from !== this.setup.hostPeer) return;
    if (msg.offer !== undefined && this.setup.isHost) return this.answer(from, msg.g, msg.offer);
    const link = this.links.get(from);
    if (!link || link.gen !== msg.g) return;
    if (msg.answer !== undefined && !this.setup.isHost) {
      void link.pc.setRemoteDescription({ type: "answer", sdp: msg.answer }).then(() => this.flushEarly(link), () => this.fail(link));
    } else if (msg.ice) {
      if (link.pc.remoteDescription) void link.pc.addIceCandidate(msg.ice).catch(() => {});
      else link.early.push(msg.ice);
    } else if (msg.cut) {
      link.cutHeard = true;
      const held = link.held;
      link.held = [];
      for (const data of held) this.deliver(from, data);
    }
  }

  /** Host side: answer a client's offer — replacing whatever link that peer had, since a client
   *  only re-offers once its old one is dead to it. */
  private answer(peer: number, gen: number, sdp: string): void {
    this.drop(peer);
    const link = this.open(peer, gen);
    link.pc.ondatachannel = (ev) => this.attach(link, ev.channel);
    void (async () => {
      try {
        await link.pc.setRemoteDescription({ type: "offer", sdp });
        this.flushEarly(link);
        await link.pc.setLocalDescription(await link.pc.createAnswer());
        if (this.links.get(peer) !== link) return;
        this.inner.send({ k: "rtc", g: gen, answer: link.pc.localDescription?.sdp } satisfies RtcSignal, peer);
      } catch {
        this.fail(link);
      }
    })();
  }

  private open(peer: number, gen: number): Link {
    const link = new Link(peer, gen, this.rtc);
    this.links.set(peer, link);
    link.pc.onicecandidate = (ev) => {
      if (ev.candidate && this.links.get(peer) === link) {
        this.inner.send({ k: "rtc", g: gen, ice: ev.candidate.toJSON() } satisfies RtcSignal, peer);
      }
    };
    link.pc.onconnectionstatechange = () => {
      const state = link.pc.connectionState;
      if (state === "failed" || state === "closed") this.fail(link);
    };
    link.timer = setTimeout(() => {
      if (!link.sending) this.fail(link);
    }, OPEN_TIMEOUT_MS);
    return link;
  }

  private flushEarly(link: Link): void {
    const early = link.early;
    link.early = [];
    for (const ice of early) void link.pc.addIceCandidate(ice).catch(() => {});
  }

  private attach(link: Link, dc: RTCDataChannel): void {
    link.dc = dc;
    const opened = (): void => {
      if (this.links.get(link.peer) !== link || link.sending) return;
      if (link.timer !== null) clearTimeout(link.timer);
      link.timer = null;
      // The marker first, over the relay, and only then the switch: see the file header.
      this.inner.send({ k: "rtc", g: link.gen, cut: true } satisfies RtcSignal, link.peer);
      link.sending = true;
    };
    dc.onopen = opened;
    // The ANSWERING end is handed its channel by `ondatachannel`, and depending on the engine
    // that channel is already open by then and no `open` event follows.
    if (dc.readyState === "open") queueMicrotask(opened);
    dc.onmessage = (ev) => {
      if (this.links.get(link.peer) !== link || typeof ev.data !== "string") return;
      const text = ev.data;
      let whole: string;
      if (text.startsWith(MORE)) {
        link.partial += text.slice(1);
        return;
      } else if (text.startsWith(LAST)) {
        whole = link.partial + text.slice(1);
        link.partial = "";
      } else whole = text;
      let data: unknown;
      try {
        data = JSON.parse(whole);
      } catch {
        return;
      }
      this.counts.directIn++;
      if (link.cutHeard) this.deliver(link.peer, data);
      else link.held.push(data);
    };
    dc.onclose = () => this.fail(link);
  }

  private deliver(from: number, data: unknown): void {
    this.onPeerData(from, data);
  }

  /** A link did not open, or stopped working: its peer is back on the relay. A client tries
   *  again a little later; the host waits to be offered. */
  private fail(link: Link): void {
    if (this.links.get(link.peer) !== link) return;
    this.drop(link.peer);
    if (!this.setup.isHost && !this.closed && this.offers < MAX_OFFERS && this.retry === null) {
      this.retry = setTimeout(() => {
        this.retry = null;
        this.offer();
      }, RETRY_MS[this.offers - 1] ?? RETRY_MS[RETRY_MS.length - 1]);
    }
  }

  /** Tear one link down. Direct traffic still held for a cut that will now never matter is
   *  handed over rather than lost — it was sent after everything the relay carried. */
  private drop(peer: number): void {
    const link = this.links.get(peer);
    if (!link) return;
    this.links.delete(peer);
    link.sending = false;
    if (link.timer !== null) clearTimeout(link.timer);
    link.pc.onicecandidate = null;
    link.pc.onconnectionstatechange = null;
    if (link.dc) {
      link.dc.onopen = null;
      link.dc.onmessage = null;
      link.dc.onclose = null;
    }
    try {
      link.dc?.close();
      link.pc.close();
    } catch {
      /* already gone */
    }
    for (const data of link.held) this.deliver(peer, data);
    link.held = [];
  }

  private shutDown(): void {
    this.closed = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    for (const peer of [...this.links.keys()]) this.drop(peer);
  }
}

/** Send one payload, in pieces when it is large. */
function write(dc: RTCDataChannel, text: string): void {
  if (text.length <= PIECE) return dc.send(text);
  for (let at = 0; at < text.length; at += PIECE) {
    const end = Math.min(text.length, at + PIECE);
    dc.send((end === text.length ? LAST : MORE) + text.slice(at, end));
  }
}

/**
 * Put direct links under a match's relay channel, or hand the channel back untouched where
 * there is nothing to do: the switch is off, the platform has no WebRTC (the headless tests),
 * or nobody else in the match is a person.
 */
export function withDirectLinks(inner: MatchChannel, setup: DirectSetup): MatchChannel {
  if (!DirectLinks.enabled || setup.peers.length === 0) return inner;
  if (!setup.rtc && typeof RTCPeerConnection === "undefined") return inner;
  return new DirectChannel(inner, setup);
}
