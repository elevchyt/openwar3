// The kit's progress bar must have an accessible name: the bar is `role="progressbar"`, and its
// label is the line printed under it, so the bar has to point at that line (aria-labelledby).
// A screen reader otherwise hears an unnamed progress bar (issue #310).
//
// No DOM library is installed, so this drives the vanilla binding against a minimal stand-in
// for the handful of DOM calls it makes. Node 24 strips the types from the .ts source directly.

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    const classes = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
    };
    this.style = { setProperty() {} };
    this.id = "";
    this.hidden = false;
    this.text = "";
    this.className = "";
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, on) { if (on) this.setAttribute(name, ""); else this.removeAttribute(name); }
  append(...nodes) { this.children.push(...nodes); }
  get textContent() { return this.text || this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.text = String(v); }
  find(id) {
    if (this.id === id) return this;
    for (const c of this.children) {
      const hit = c.find(id);
      if (hit) return hit;
    }
    return null;
  }
}
globalThis.document = { createElement: (tag) => new El(tag) };

const { createProgressBar } = await import("../packages/ui/src/dom/index.ts");

const LABEL = "Loading the Frozen Throne";
const bar = createProgressBar({ scale: 1.5, label: LABEL });
const [progress, label] = bar.root.children;

const named = progress.getAttribute("aria-labelledby");
if (!named) {
  console.error(`progressbar has no accessible name: aria-labelledby=${named}`);
  process.exit(1);
}
const target = bar.root.find(named);
if (!target || target.textContent !== LABEL) {
  console.error(`progressbar name does not read the label: expected "${LABEL}", got "${target?.textContent ?? null}"`);
  process.exit(1);
}
if (target !== label) {
  console.error("progressbar name points at something other than its label line");
  process.exit(1);
}

console.log("ui-progressbar: ok");
