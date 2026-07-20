// An in-process relay: N clients, one Node process, no listening port
// (docs/multiplayer.md Phase E item 8).
//
// `Transport` (src/net/transport.ts) has always been the seam — everything above it talks to a
// Transport, never to a WebSocket, so that the authority is transport-agnostic. Until now the
// only implementation was `WebSocketTransport`, which means every test of anything above the
// seam had to boot a server, bind a port and wait on timers. That is why there is no reconnect
// test: "kill a client and bring it back" is miserable to write against a real socket and
// trivial against a queue.
//
// This is the other adapter, over the SAME `RelayCore` the deployed relay runs
// (`server/rooms.mjs`). Not a mock — a mock would be a second set of routing rules that agree
// with the real ones until they quietly do not. The room table, the peer ids, the
// host-leaves-closes-the-room rule and the `relay`→`deliver` fan-out are all literally the
// production code.
//
// DELIVERY IS ASYNCHRONOUS, on purpose. A real transport never hands you a reply inside the
// call that sent it, and a loopback that did would let a test pass that depends on ordering no
// socket can give. Messages go through a microtask queue, so `await tick()` is the "let the
// network settle" step and anything that needs two round trips has to say so.

import { RelayCore } from "../server/rooms.mjs";

/** Let every queued delivery run. One `await` per hop; the queue drains itself. */
export const tick = () => new Promise((r) => setTimeout(r, 0));

export class LoopbackRelay {
  constructor() {
    this.core = new RelayCore();
  }

  /** A fresh client endpoint, already connected (`hello` + `rooms` are in its inbox). */
  connect(label = "client") {
    return new LoopbackTransport(this.core, label);
  }
}

/**
 * One client's end of the wire. Implements `Transport` — `send`, `close`, `connected`,
 * `onMessage`, `onClose` — so anything written against the seam takes one of these unchanged.
 *
 * It additionally keeps every message it has received in `inbox`, which a socket does not do
 * and a test badly wants: assertions read "what did player 2 end up being told", not "what was
 * the callback holding at the moment I looked".
 */
export class LoopbackTransport {
  constructor(core, label) {
    this.core = core;
    this.label = label;
    this.inbox = [];
    this.connected = true;
    this.onMessage = () => {};
    this.onClose = () => {};

    this.conn = {
      send: (msg) => {
        // Asynchronous, and via a structured copy: two endpoints in one process would
        // otherwise share object identity, so a client mutating a payload it received would
        // reach into the relay's own room table. Over a real socket that is impossible, and a
        // loopback that allowed it would hide the bug rather than surface it.
        queueMicrotask(() => {
          if (!this.connected) return;
          const copy = JSON.parse(JSON.stringify(msg));
          this.inbox.push(copy);
          this.onMessage(copy);
        });
      },
    };
    this.core.connect(this.conn);
  }

  send(msg) {
    if (!this.connected) return;
    // Serialise NOW, deliver later — which is what a socket does, and the reason the copy is
    // not inside the microtask. `ws.send(JSON.stringify(msg))` freezes the payload at the
    // moment of the call; a caller that reuses and mutates its message object afterwards
    // cannot change what is already on the wire. Taking the copy at delivery time instead
    // reads almost identically and gives the opposite guarantee.
    const frozen = JSON.parse(JSON.stringify(msg));
    queueMicrotask(() => this.core.handle(this.conn, frozen));
  }

  /** A clean departure — the client chose to leave. */
  close() {
    if (!this.connected) return;
    this.connected = false;
    this.core.disconnect(this.conn);
  }

  /**
   * The connection DROPPED — a laptop lid, a lost wifi, a crashed tab.
   *
   * Deliberately distinct from `close()`, even though the relay currently cannot tell them
   * apart: a drop is what reconnect has to survive, and giving it its own verb means the test
   * that describes reconnect reads as reconnect rather than as "leave, then join again". When
   * item 11 gives the relay a rejoin token, THIS is the path that must not free the slot.
   */
  drop() {
    if (!this.connected) return;
    this.connected = false;
    this.core.disconnect(this.conn);
    this.onClose("Connection to the game host was lost.");
  }

  /** Everything received, oldest first. `t` filters by message type. */
  seen(t) {
    return t ? this.inbox.filter((m) => m.t === t) : this.inbox.slice();
  }

  /** The most recent message of a type, or undefined. */
  last(t) {
    const all = this.seen(t);
    return all[all.length - 1];
  }

  /** Forget what has been received so far, so an assertion can be about what happens NEXT. */
  clear() {
    this.inbox.length = 0;
  }
}
