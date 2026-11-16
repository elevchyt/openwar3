// Seeded random STREAMS as plain state (issue #159, docs/save-games.md).
//
// A stream kept in a closure (`let s = seed; return () => …`) hides its position where nothing
// can read it, so a saved game would bring every computer back with its dice rewound to the
// seed. These hold the position in a field instead: the codec writes it, and a closure that
// calls `next()` on the instance it was made with keeps working after a load, because the load
// writes the saved position INTO that same instance.

/** Park–Miller (`s * 16807 mod 2³¹−1`) — the AI's `lcg`, seeded exactly as it was. */
export class ParkMillerStream {
  private s: number;
  constructor(seed: number) {
    let s = Math.abs(Math.floor(seed)) % 2147483647;
    if (s <= 0) s += 2147483646;
    this.s = s;
  }
  next(): number {
    this.s = (this.s * 16807) % 2147483647;
    return (this.s - 1) / 2147483646;
  }
}

/** mulberry32 — the custom-map Computer+ players' stream, seeded exactly as it was. */
export class Mulberry32Stream {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
