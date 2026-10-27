// Gliding hover pill, as in ReeliF Studio's menu bar: inside any element with the class "glide",
// one pill (its `.glide-pill` child) slides behind the item under the pointer or keyboard focus,
// takes that item's size and corners, and fades out when the pointer leaves the group.
// Installed once per window (main.tsx); off under reduced motion (it jumps instead of gliding).
import { gsap } from "gsap";
import { reducedMotion } from "./motion";

/** Items the pill rides behind. Filled buttons (record, stop, export, play) keep their own look. */
export const GLIDE_ITEMS = ".cb-icon, .cb-source, .cb-choice, .cb-link, .ed-rail-btn, .ed-tab, .ed-icon, .ed-row, .btn:not(.primary):not(.danger)";

function pillOf(box: HTMLElement): HTMLElement | null {
  return box.querySelector<HTMLElement>(":scope > .glide-pill");
}

function show(box: HTMLElement, item: HTMLElement) {
  const pill = pillOf(box);
  if (!pill) return;
  const b = box.getBoundingClientRect();
  const r = item.getBoundingClientRect();
  const to = { x: r.left - b.left + box.scrollLeft, y: r.top - b.top + box.scrollTop, width: r.width, height: r.height, borderRadius: getComputedStyle(item).borderRadius };
  const still = reducedMotion();
  gsap.killTweensOf(pill);
  if (pill.dataset.on !== "1") {
    // Appears where it is needed, then glides from there.
    gsap.set(pill, { ...to, scale: 0.92 });
    gsap.to(pill, { autoAlpha: 1, scale: 1, duration: still ? 0 : 0.18, ease: "power2.out" });
  } else {
    gsap.to(pill, { ...to, autoAlpha: 1, scale: 1, duration: still ? 0 : 0.32, ease: "power3.out" });
  }
  pill.dataset.on = "1";
}

function hide(box: HTMLElement) {
  const pill = pillOf(box);
  if (!pill || pill.dataset.on !== "1") return;
  pill.dataset.on = "0";
  gsap.to(pill, { autoAlpha: 0, scale: 0.96, duration: reducedMotion() ? 0 : 0.18, ease: "power2.out" });
}

function itemAt(target: EventTarget | null): { box: HTMLElement; item: HTMLElement } | null {
  if (!(target instanceof Element)) return null;
  const item = target.closest<HTMLElement>(GLIDE_ITEMS);
  const box = item?.closest<HTMLElement>(".glide");
  if (!item || !box || item === box || (item as HTMLButtonElement).disabled) return null;
  return { box, item };
}

export function installGlide() {
  document.addEventListener("pointerover", (e) => {
    const hit = itemAt(e.target);
    if (hit) show(hit.box, hit.item);
  });
  // Gaps between items keep the pill; leaving the group fades it.
  document.addEventListener("pointerout", (e) => {
    const from = e.target instanceof Element ? e.target.closest<HTMLElement>(".glide") : null;
    if (!from) return;
    const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    if (to && from.contains(to)) return;
    hide(from);
  });
  document.addEventListener("focusin", (e) => {
    const hit = itemAt(e.target);
    if (hit && hit.item.matches(":focus-visible")) show(hit.box, hit.item);
  });
  document.addEventListener("focusout", (e) => {
    const box = e.target instanceof Element ? e.target.closest<HTMLElement>(".glide") : null;
    const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    if (box && !(to && box.contains(to))) hide(box);
  });
  // A click can re-lay out the group (a panel opens, an item moves): follow the item.
  document.addEventListener("click", (e) => {
    const hit = itemAt(e.target);
    if (hit) requestAnimationFrame(() => hit.box.isConnected && hit.item.isConnected && show(hit.box, hit.item));
  });
}
