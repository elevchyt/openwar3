// SAVED GAMES (issue #159) — the object-graph codec every saved game is written with.
//
// A saved game is the MATCH ITSELF, written down: the world, the map's script with its sleeping
// threads, the computers' brains (docs/save-games.md). Warcraft III does the same thing — a
// `.w3z` is the engine's memory, not a replay — and the reason we can too is that the state of a
// match lives in plain data: units point at each other by id, a JASS handle is a number, a
// trigger names its functions by name.
//
// So rather than a hand-written field list per class (which is exactly the list that falls
// behind the day somebody adds a field, and silently: the save "works" and the loaded game is a
// little different), the codec walks the GRAPH. Every object, array, Map, Set and typed array
// reachable from the roots is written once, by identity — so two references to one record are
// still one record after a load, and a cycle is just a reference back.
//
// Three things in a match's graph are not state, and the codec has a word for each:
//
//   · EXTERNALS — the static world the match was BUILT from: the unit/ability/item tables, the
//     script's syntax tree. A unit that holds its type's row holds a pointer into data the
//     loaded game reads from the same install, so it is written as a KEY (`unit:hfoo/weapons/0`)
//     and looked up again on load, never copied.
//   · WIRING — a function. Hooks, callbacks, the renderer's samplers: they are how one part of
//     the program talks to another, and the fresh match the save is loaded INTO already has
//     them. A function is written as a marker and the loaded object keeps its own.
//   · OPAQUE — something that is neither (a WeakMap — whose keys cannot be listed — or an object
//     the caller says is not ours, like a GPU instance). Same as wiring: the target keeps its own.
//
// Which is why a save is restored INTO a match, not built from nothing: `decodeGraph` is handed
// the freshly loaded match's own objects and writes the saved state over them IN PLACE, field
// by field, keeping the same Map, the same typed array, the same instance wherever the saved
// object and the fresh one are the same kind of thing. Anything else in the program that holds
// one of those (the fog overlay holds the vision grid; the HUD holds the units Map) is then
// still holding the live one. A class the fresh match has no instance of at that spot is made
// from its prototype — which is what the CLASS REGISTRY is for: a class is named by the name it
// was registered under, never by `constructor.name`, which a minified build renames.
//
// Kept free of the DOM and the renderer: the headless save tests compile it for Node.

/** A value as written. A plain JSON value, or one of a handful of tagged objects. */
export type GVal =
  | null
  | boolean
  | number
  | string
  | { $: number } // a reference to node $
  | { x: string } // an external, by key
  | { f: 1 } // a function (wiring): the target keeps its own
  | { w: 1 } // opaque: the target keeps its own
  | { w: 2 } // transient (a cache, a static table the caller named): the target keeps its own, silently
  | { u: 1 } // undefined
  | { n: "NaN" | "Inf" | "-Inf" | "-0" }; // the numbers JSON cannot say

/** One object, as written. */
export type GNode =
  | { t: "o"; c?: string; p: Record<string, GVal> }
  | { t: "a"; v: GVal[] }
  | { t: "m"; v: Array<[GVal, GVal]> }
  | { t: "s"; v: GVal[] }
  | { t: "b"; c: string; d: string };

export interface GraphDoc {
  nodes: GNode[];
  root: GVal;
}

// --- the class registry --------------------------------------------------------------------------

type Ctor = abstract new (...args: never[]) => unknown;
const classByName = new Map<string, Ctor>();
const nameByProto = new Map<object, string>();
const transientByName = new Map<string, ReadonlySet<string>>();
const hooksByName = new Map<string, SaveClassHooks<never>>();

/**
 * What a class does about the part of itself the codec cannot see. `save` hands over fields to
 * write IN PLACE OF the object's own (the JASS VM writes its threads' traces where its generators
 * are); `load` runs once the whole graph has been written back, with those fields restored, and
 * turns them back into the live thing (the VM rebuilds its generators).
 */
export interface SaveClassHooks<T> {
  save?(o: T): Record<string, unknown>;
  load?(o: T): void;
}

/**
 * Name a class for the codec. Every class whose instances can be PART of a match's state must be
 * registered (src/game/save/classes.ts does it in one place), so a minified build — which renames
 * `constructor.name` — still writes and reads the same word. An unregistered class still saves
 * (under `?Name`) and is reported by `encodeGraph`'s stats, which is how the tests keep the list
 * complete.
 */
export function registerSaveClass<T>(name: string, ctor: Ctor, transient: readonly string[] = [], hooks?: SaveClassHooks<T>): void {
  classByName.set(name, ctor);
  nameByProto.set(ctor.prototype as object, name);
  if (transient.length) transientByName.set(name, new Set(transient));
  if (hooks) hooksByName.set(name, hooks as SaveClassHooks<never>);
}

const TYPED: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array,
};

function typedName(o: object): string | null {
  if (!ArrayBuffer.isView(o) || o instanceof DataView) return null;
  const n = (o as { constructor: { name: string } }).constructor.name;
  // Matched by the class itself, not by its (minifiable) name.
  for (const [k, c] of Object.entries(TYPED)) if (o instanceof c) return k;
  return n;
}

/** The registered name of an object's class; "" for a plain object or a null-prototype one. */
function classKey(o: object): string {
  const proto = Object.getPrototypeOf(o) as object | null;
  if (proto === null || proto === Object.prototype) return "";
  const named = nameByProto.get(proto);
  if (named) return named;
  const ctor = (proto as { constructor?: { name?: string } }).constructor;
  return `?${ctor?.name ?? "anonymous"}`;
}

// --- base64 (the page and Node both have btoa/atob) ----------------------------------------------

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- encode ----------------------------------------------------------------------------------------

export interface EncodeOptions {
  /** Objects that belong to the static world, by key (see `ExternalIndex`). */
  externalKey?: (o: object) => string | undefined;
  /** Objects that are not ours to write (a GPU instance, a DOM node): the target keeps its own. */
  opaque?: (o: object) => boolean;
  /** Per-class fields that are not state — a cache, a scratch buffer — written as opaque, on
   *  top of the ones each class registered with (`registerSaveClass`). */
  transient?: (cls: string, field: string) => boolean;
}

export interface EncodeStats {
  /** How many objects of each class were written (plain objects under ""). */
  classes: Map<string, number>;
  /** Classes that are not registered — each one is a class the registry is missing. */
  unregistered: Set<string>;
  /** Where each kind of marker was met, for the tests: `functions` are wiring, and a function
   *  inside a class the fresh match does NOT already have an instance of is a closure that holds
   *  state, which the codec cannot carry. */
  functions: string[];
  opaque: string[];
}

export function encodeGraph(root: unknown, opts: EncodeOptions = {}, stats?: EncodeStats): GraphDoc {
  const nodes: GNode[] = [];
  const ids = new Map<object, number>();
  // Iterative, so a long chain (a linked list, a deep record) cannot blow the JS stack: every
  // object gets its id the moment it is first met and is FILLED later, from this queue.
  const pending: Array<{ o: object; id: number; path: string }> = [];

  const val = (v: unknown, path: string): GVal => {
    switch (typeof v) {
      case "undefined":
        return { u: 1 };
      case "boolean":
      case "string":
        return v;
      case "number":
        if (Number.isNaN(v)) return { n: "NaN" };
        if (v === Infinity) return { n: "Inf" };
        if (v === -Infinity) return { n: "-Inf" };
        if (Object.is(v, -0)) return { n: "-0" };
        return v;
      case "function":
        stats?.functions.push(path);
        return { f: 1 };
      case "bigint":
      case "symbol":
        throw new Error(`save: cannot write a ${typeof v} at ${path}`);
    }
    if (v === null) return null;
    const o = v as object;
    const seen = ids.get(o);
    if (seen !== undefined) return { $: seen };
    const ext = opts.externalKey?.(o);
    if (ext !== undefined) return { x: ext };
    if (o instanceof WeakMap || o instanceof WeakSet || (typeof WeakRef !== "undefined" && o instanceof WeakRef) || o instanceof Promise || opts.opaque?.(o)) {
      stats?.opaque.push(path);
      return { w: 1 };
    }
    const id = nodes.length;
    nodes.push(null as unknown as GNode); // reserved; filled from the queue
    ids.set(o, id);
    pending.push({ o, id, path });
    return { $: id };
  };

  const fill = (o: object, id: number, path: string): void => {
    const tn = typedName(o);
    if (tn !== null) {
      const view = o as ArrayBufferView;
      if (!(tn in TYPED)) throw new Error(`save: cannot write a ${tn} at ${path}`);
      nodes[id] = { t: "b", c: tn, d: toB64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()) };
      return;
    }
    if (o instanceof ArrayBuffer) throw new Error(`save: a bare ArrayBuffer at ${path}`);
    if (Array.isArray(o)) {
      if (Object.getPrototypeOf(o) !== Array.prototype) throw new Error(`save: an Array subclass at ${path}`);
      const v: GVal[] = new Array(o.length);
      for (let i = 0; i < o.length; i++) v[i] = val(o[i], `${path}[${i}]`);
      nodes[id] = { t: "a", v };
      return;
    }
    if (o instanceof Map) {
      const v: Array<[GVal, GVal]> = [];
      let i = 0;
      for (const [k, x] of o) {
        v.push([val(k, `${path}.<key ${i}>`), val(x, `${path}.get(${typeof k === "object" ? i : String(k)})`)]);
        i++;
      }
      nodes[id] = { t: "m", v };
      bump(stats, "Map");
      return;
    }
    if (o instanceof Set) {
      const v: GVal[] = [];
      let i = 0;
      for (const x of o) v.push(val(x, `${path}.<${i++}>`));
      nodes[id] = { t: "s", v };
      bump(stats, "Set");
      return;
    }
    const c = classKey(o);
    if (c.startsWith("?")) stats?.unregistered.add(`${c.slice(1)} (at ${path})`);
    bump(stats, c);
    const p: Record<string, GVal> = {};
    const over = c ? (hooksByName.get(c)?.save?.(o as never) ?? null) : null;
    for (const k of over ? new Set([...Object.keys(o), ...Object.keys(over)]) : Object.keys(o)) {
      if (over && k in over) {
        p[k] = val(over[k], `${path}.${k}`);
        continue;
      }
      const sub = `${path}.${k}`;
      if (c && (transientByName.get(c)?.has(k) || opts.transient?.(c, k))) {
        p[k] = { w: 2 };
        continue;
      }
      p[k] = val((o as Record<string, unknown>)[k], sub);
    }
    nodes[id] = c ? { t: "o", c, p } : { t: "o", p };
  };

  const rootVal = val(root, "$");
  while (pending.length) {
    const next = pending.pop()!;
    fill(next.o, next.id, next.path);
  }
  return { nodes, root: rootVal };
}

function bump(stats: EncodeStats | undefined, key: string): void {
  if (stats) stats.classes.set(key, (stats.classes.get(key) ?? 0) + 1);
}

export function newEncodeStats(): EncodeStats {
  return { classes: new Map(), unregistered: new Set(), functions: [], opaque: [] };
}

// --- decode ----------------------------------------------------------------------------------------

export interface DecodeOptions {
  /** The object an external key names, in the match being loaded into. */
  resolveExternal?: (key: string) => unknown;
}

export interface DecodeReport {
  /** Saved functions (or opaque values) that had NO counterpart in the target to keep — each is
   *  wiring the loaded object is now missing. Empty on a sound load. */
  lost: string[];
  /** Externals the target could not resolve. */
  missingExternals: string[];
}

/**
 * Write a saved graph over `target`, in place.
 *
 * `target` is the freshly loaded match's root (the same shape the save's root was). Every saved
 * object is matched with the object at the same place in the target: if they are the same KIND
 * (the same registered class, or both plain, both Maps, …) and that target object has not
 * already been used for another saved one, it is REUSED — its fields are overwritten, the fields
 * the save does not have are deleted, and its functions are kept. Otherwise a new object is
 * made. The result is the decoded root (which is `target` itself whenever the kinds agree).
 */
export function decodeGraph(doc: GraphDoc, target: unknown, opts: DecodeOptions = {}, report?: DecodeReport): unknown {
  const made: unknown[] = new Array(doc.nodes.length);
  const filled = new Uint8Array(doc.nodes.length);
  const claimed = new WeakSet<object>();
  // Iterative fill, for the same reason as the encoder.
  const queue: Array<{ id: number; obj: unknown; path: string; old: unknown }> = [];

  const kindOf = (o: unknown): string => {
    if (o === null || typeof o !== "object") return "";
    if (Array.isArray(o)) return "a";
    if (o instanceof Map) return "m";
    if (o instanceof Set) return "s";
    const tn = typedName(o);
    if (tn !== null) return `b:${tn}`;
    return `o:${classKey(o)}`;
  };

  const nodeKind = (n: GNode): string => {
    switch (n.t) {
      case "o": return `o:${n.c ?? ""}`;
      case "b": return `b:${n.c}`;
      default: return n.t;
    }
  };

  const make = (n: GNode, path: string): unknown => {
    switch (n.t) {
      case "a": return [];
      case "m": return new Map();
      case "s": return new Set();
      case "b": {
        const bytes = fromB64(n.d);
        const C = TYPED[n.c];
        return new C(bytes.buffer as ArrayBuffer);
      }
      case "o": {
        if (!n.c) return {};
        const C = classByName.get(n.c);
        if (C) return Object.create(C.prototype as object) as object;
        report?.lost.push(`${path} (class ${n.c} has no registered prototype)`);
        return {};
      }
    }
  };

  // WHICH target objects may be reused. A CLASS instance always may (it is where the wiring
  // lives, and nothing shares one as a constant). A CONTAINER — a Map, a Set, an array, a typed
  // array, a plain record — when it is a field of a class instance or of the root (the
  // `SimWorld.units` Map the HUD holds, the vision grid the fog overlay holds), or when it CARRIES
  // wiring itself: a record of functions (an AI's view of the world) or one holding class
  // instances (a Computer+ brain), and an array of such. Anything else is a VALUE, and values
  // ARE shared — `JNULL` is one object behind every null global in the script — so reusing one
  // would write a saved handle over the null every other global is pointing at.
  const wired = new WeakMap<object, boolean>();
  const carriesWiring = (o: unknown, depth = 0): boolean => {
    if (o === null || typeof o !== "object") return typeof o === "function";
    const hit = wired.get(o);
    if (hit !== undefined) return hit;
    let r = false;
    if (ArrayBuffer.isView(o)) r = false;
    else if (classKey(o) !== "" && !Array.isArray(o) && !(o instanceof Map) && !(o instanceof Set)) r = true;
    else if (depth < 2) {
      const vals: unknown[] = o instanceof Map ? [...o.values()] : o instanceof Set ? [...o] : Array.isArray(o) ? o : Object.values(o);
      r = vals.some((v) => typeof v === "function" || (v !== null && typeof v === "object" && carriesWiring(v, depth + 1)));
    }
    wired.set(o, r);
    return r;
  };
  const ref = (id: number, old: unknown, path: string, ownerIsClass: boolean): unknown => {
    if (filled[id]) return made[id];
    const n = doc.nodes[id];
    let obj: unknown;
    const reusable = (n.t === "o" && !!n.c) || ownerIsClass || carriesWiring(old);
    if (reusable && old !== null && typeof old === "object" && !Object.isFrozen(old) && !claimed.has(old) && kindOf(old) === nodeKind(n)) {
      obj = old;
      // A typed array is reused only when it can hold the saved bytes as they are: same class
      // and same length. Anything else is a new array.
      if (n.t === "b" && (old as ArrayBufferView).byteLength !== fromB64Length(n.d)) obj = make(n, path);
    } else {
      obj = make(n, path);
    }
    if (obj !== null && typeof obj === "object") claimed.add(obj);
    made[id] = obj;
    filled[id] = 1;
    queue.push({ id, obj, path, old });
    return obj;
  };

  const value = (v: GVal, old: unknown, path: string, keep: () => unknown, ownerIsClass = false): unknown => {
    if (v === null || typeof v !== "object") return v;
    if ("$" in v) return ref(v.$, old, path, ownerIsClass);
    if ("x" in v) {
      const r = opts.resolveExternal?.(v.x);
      if (r === undefined) report?.missingExternals.push(`${path} → ${v.x}`);
      return r;
    }
    if ("u" in v) return undefined;
    if ("n" in v) return v.n === "NaN" ? NaN : v.n === "Inf" ? Infinity : v.n === "-Inf" ? -Infinity : -0;
    // A function or an opaque value: the target's own is kept.
    const mine = keep();
    if ("w" in v && v.w === 2) return mine;
    if (mine === undefined) report?.lost.push(`${path} (${"f" in v ? "function" : "opaque"})`);
    return mine;
  };

  const loads: Array<[SaveClassHooks<never>, unknown]> = [];
  const fill = (id: number, obj: unknown, path: string): void => {
    const n = doc.nodes[id];
    if (n.t === "o" && n.c) {
      const h = hooksByName.get(n.c);
      if (h?.load) loads.push([h, obj]);
    }
    switch (n.t) {
      case "b": {
        const view = obj as ArrayBufferView;
        const bytes = fromB64(n.d);
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);
        return;
      }
      case "a": {
        const arr = obj as unknown[];
        const before = arr.slice();
        arr.length = n.v.length;
        for (let i = 0; i < n.v.length; i++) arr[i] = value(n.v[i], before[i], `${path}[${i}]`, () => before[i]);
        return;
      }
      case "m": {
        const map = obj as Map<unknown, unknown>;
        const before = new Map(map);
        map.clear();
        for (const [kv, vv] of n.v) {
          const k = value(kv, undefined, `${path}.<key>`, () => undefined);
          map.set(k, value(vv, before.get(k), `${path}.get(${String(k)})`, () => before.get(k)));
        }
        return;
      }
      case "s": {
        const set = obj as Set<unknown>;
        set.clear();
        for (const x of n.v) set.add(value(x, undefined, `${path}.<item>`, () => undefined));
        return;
      }
      case "o": {
        const o = obj as Record<string, unknown>;
        const owner = !!n.c || id === rootId;
        for (const k of Object.keys(n.p)) {
          const prev = o[k];
          const sub = `${path}.${k}`;
          o[k] = value(n.p[k], prev, sub, () => prev, owner);
        }
        // A field the fresh object has and the saved one did not was absent in the match that
        // was saved — unless it is the target's own wiring, which the save never had a say on.
        for (const k of Object.keys(o)) if (!(k in n.p) && typeof o[k] !== "function") delete o[k];
        return;
      }
    }
  };

  const rootId = doc.root !== null && typeof doc.root === "object" && "$" in doc.root ? doc.root.$ : -1;
  const root = value(doc.root, target, "$", () => target, true);
  while (queue.length) {
    const next = queue.pop()!;
    fill(next.id, next.obj, next.path);
  }
  // Once EVERYTHING is back: a load hook may read any part of the graph (a VM's threads name the
  // handles of its runtime).
  for (const [h, o] of loads) h.load!(o as never);
  return root;
}

function fromB64Length(s: string): number {
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

// --- externals -------------------------------------------------------------------------------------

/**
 * The static world, indexed for the codec: every object reachable from a named SOURCE (a data
 * table's row, the script's syntax tree) gets a key `<source>/<path>`, and on load the same key
 * is followed back through the same source in the new match.
 *
 * A source is a `(id) => object` lookup rather than a whole table, because the tables fill
 * LAZILY: a row read for the first time ten minutes into the saved match may not have been read
 * yet in the match being loaded into, and a path through the whole table would then name a
 * different row. `lookup(id)` reads it on demand on both sides.
 */
export class ExternalIndex {
  private readonly keys = new Map<object, string>();

  /** Index `obj` (and everything inside it) under `<prefix>:<id>`. */
  add(prefix: string, id: string, obj: unknown): void {
    if (obj === null || typeof obj !== "object") return;
    const stack: Array<[object, string]> = [[obj, `${prefix}:${id}`]];
    while (stack.length) {
      const [o, key] = stack.pop()!;
      if (this.keys.has(o)) continue;
      this.keys.set(o, key);
      if (ArrayBuffer.isView(o)) continue;
      if (o instanceof Map) {
        for (const [k, v] of o) if (v !== null && typeof v === "object" && (typeof k === "string" || typeof k === "number")) stack.push([v as object, `${key}/m${encodeURIComponent(String(k))}${typeof k === "number" ? "#" : ""}`]);
        continue;
      }
      if (o instanceof Set) continue;
      for (const k of Object.keys(o)) {
        const v = (o as Record<string, unknown>)[k];
        if (v !== null && typeof v === "object") stack.push([v, `${key}/${encodeURIComponent(k)}`]);
      }
    }
  }

  keyOf = (o: object): string | undefined => this.keys.get(o);

  get size(): number {
    return this.keys.size;
  }
}

/** Follow an external key back to its object, through `sources` (prefix → lookup by id). */
export function resolveExternalKey(key: string, sources: ReadonlyMap<string, (id: string) => unknown>): unknown {
  const colon = key.indexOf(":");
  if (colon < 0) return undefined;
  const prefix = key.slice(0, colon);
  const parts = key.slice(colon + 1).split("/");
  const lookup = sources.get(prefix);
  if (!lookup) return undefined;
  let cur: unknown = lookup(decodeURIComponent(parts[0]));
  for (let i = 1; i < parts.length && cur !== undefined && cur !== null; i++) {
    const p = parts[i];
    if (cur instanceof Map && p.startsWith("m")) {
      const raw = p.slice(1);
      const numeric = raw.endsWith("#");
      const k = decodeURIComponent(numeric ? raw.slice(0, -1) : raw);
      cur = cur.get(numeric ? Number(k) : k);
    } else {
      cur = (cur as Record<string, unknown>)[decodeURIComponent(p)];
    }
  }
  return cur ?? undefined;
}
