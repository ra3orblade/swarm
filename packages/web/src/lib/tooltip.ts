/**
 * The shared chart tooltip, ported from `viz.js`.
 *
 * Marks carry their text in `data-tip`; one `mousemove` listener on the document shows it, rather
 * than one handler per bar. The React dashboard stopped loading `viz.js` and nothing replaced this,
 * so every chart silently lost its numbers on hover.
 *
 * A tip is HTML because the charts bold a heading and colour a swatch, but it also interpolates task
 * names, file paths and session labels — text that comes from whatever repo is being watched. So it
 * is parsed into an inert `<template>` and only the handful of tags the charts use survive, each
 * with just `class` and `style`.
 */

const TAGS = new Set(["B", "BR", "SPAN", "I"]);
const ATTRS = new Set(["class", "style"]);

/** Clean one child in place: allowed elements keep safe attributes, others collapse to text. */
function cleanNode(node: ChildNode): void {
  if (node.nodeType === Node.TEXT_NODE) return;
  if (node.nodeType !== Node.ELEMENT_NODE) {
    node.remove();
    return;
  }
  const el = node as Element;
  if (!TAGS.has(el.tagName)) {
    el.replaceWith(document.createTextNode(el.textContent ?? ""));
    return;
  }
  for (const attr of [...el.attributes]) {
    if (!ATTRS.has(attr.name)) el.removeAttribute(attr.name);
  }
  for (const child of [...el.childNodes]) cleanNode(child);
}

/** Keep only the markup a tooltip is allowed to carry; anything else becomes its text. */
export function sanitizeTip(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const child of [...template.content.childNodes]) cleanNode(child);
  return template.content;
}

let installed = false;

/** Mount `#tip` and follow the pointer. Idempotent — StrictMode and hot reload may call it twice. */
export function installTooltip(): void {
  if (installed) return;
  installed = true;
  const tip = document.createElement("div");
  tip.id = "tip";
  document.body.appendChild(tip);
  let current: Element | null = null;
  let rect: DOMRect | null = null;
  let last: { x: number; y: number } | null = null;
  let frame = 0;
  const place = (): void => {
    frame = 0;
    if (!current || !last) return;
    rect ??= tip.getBoundingClientRect(); // measured once per content, not per mouse move
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, last.x + 14));
    const top =
      last.y + 16 + rect.height > window.innerHeight ? last.y - rect.height - 8 : last.y + 16;
    tip.style.transform = `translate(${left}px,${top}px)`;
  };
  const hide = (): void => {
    current = null;
    tip.style.display = "none";
  };
  document.addEventListener("mousemove", (e) => {
    const el = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
    if (el !== current) {
      current = el;
      rect = null;
      const text = el?.getAttribute("data-tip");
      if (el && text) {
        tip.replaceChildren(sanitizeTip(text));
        tip.style.display = "block";
      } else hide();
    }
    if (current) {
      last = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(place);
    }
  });
  // A view that re-renders under a still pointer, or a pointer that leaves the window, must not
  // leave a stale tip floating.
  document.addEventListener("mouseleave", hide);
  window.addEventListener("blur", hide);
  document.addEventListener("scroll", hide, true);
}
