// The hover HINTS that are OpenWar3's own — the idle-worker button, the XP bar's numbers, the
// day/night clock, the build and queue icons, a list row's action button — drawn in the game's
// tooltip slab instead of the browser's `title` bubble.
//
// Why not `title`: the browser draws it BELOW the pointer, so it grows DOWNWARD, in the OS's own
// font and chrome, after the OS's own delay. Every tooltip Warcraft III draws grows UPWARD from a
// fixed bottom edge — the command card's slab over the console (`.hud-tooltip`, pinned by its
// `bottom`) and the name slab over a unit (`.unit-hover-tooltip`, `translate(-50%, -100%)`) — and
// so do these: the slab's BOTTOM edge sits a small gap above the element, and taller text only
// ever pushes its top edge up. It wears the same dress as the unit slab (body.hud-tooltip-skinned
// in a match, the placeholder slate outside one).
//
// One slab for the whole page, since only one element can be under the pointer.

/** The gap between the element's top edge and the slab's bottom edge, in CSS pixels. */
const GAP_PX = 6;
/** How close the slab may come to the viewport's side edges. */
const EDGE_PX = 2;

let slab: HTMLDivElement | null = null;
let anchor: HTMLElement | null = null;
let watching = false;
const texts = new WeakMap<HTMLElement, string>();
const bound = new WeakSet<HTMLElement>();

/**
 * Give `el` a hover hint (or take it away with null). Safe to call every frame — the XP bar
 * re-states its numbers as they tick — and a hint that changes while it is up is re-drawn in
 * place, still pinned by its bottom edge.
 */
export function setGameTip(el: HTMLElement, text: string | null): void {
  el.removeAttribute("title"); // never both: the browser's bubble would draw under ours
  if (text) texts.set(el, text);
  else texts.delete(el);
  if (!bound.has(el)) {
    bound.add(el);
    el.addEventListener("pointerenter", () => show(el));
    el.addEventListener("pointerleave", () => {
      if (anchor === el) hide();
    });
  }
  if (anchor === el) {
    if (text) show(el);
    else hide();
  }
}

function show(el: HTMLElement): void {
  const text = texts.get(el);
  if (!text) return hide();
  if (!slab) {
    slab = document.createElement("div");
    slab.className = "game-tip";
    document.body.appendChild(slab);
  }
  anchor = el;
  if (slab.textContent !== text) slab.textContent = text;
  slab.hidden = false;
  place();
  if (!watching) {
    watching = true;
    requestAnimationFrame(watch);
  }
}

function hide(): void {
  if (slab) slab.hidden = true;
  anchor = null;
}

/**
 * Pin the slab's bottom edge above the element, centred on it and kept inside the viewport.
 *
 * An element with no room above it (the clock, in the bar along the top of the screen) takes
 * the slab under itself instead — still pinned by the slab's BOTTOM edge, at the height the
 * slab has now, so it cannot grow down into the world either.
 */
function place(): void {
  if (!slab || !anchor) return;
  const r = anchor.getBoundingClientRect();
  const h = slab.offsetHeight;
  const bottomEdge = r.top - GAP_PX >= h ? r.top - GAP_PX : r.bottom + GAP_PX + h;
  slab.style.bottom = `${window.innerHeight - bottomEdge}px`;
  const half = slab.offsetWidth / 2;
  const cx = Math.min(Math.max(r.left + r.width / 2, half + EDGE_PX), window.innerWidth - half - EDGE_PX);
  slab.style.left = `${cx}px`;
}

/** Follow the element while the slab is up, and drop the slab when the element goes — hidden,
 *  removed, or simply no longer under the pointer without a pointerleave having arrived. */
function watch(): void {
  if (!slab || slab.hidden || !anchor || !anchor.isConnected || !anchor.matches(":hover")) {
    watching = false;
    if (anchor) hide();
    return;
  }
  place();
  requestAnimationFrame(watch);
}
