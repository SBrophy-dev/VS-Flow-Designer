// Tiny DOM helpers for the webview (no framework, so the bundle stays small and CSP-friendly).

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

const PROPERTY_KEYS = new Set(['value', 'checked', 'selected', 'disabled', 'textContent', 'title', 'placeholder', 'spellcheck', 'draggable', 'tabIndex']);

function apply(el: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.setAttribute('class', String(value));
    } else if (key === 'style' && typeof value === 'object') {
      const style = (el as HTMLElement).style;
      for (const [prop, v] of Object.entries(value as Record<string, string>)) {
        if (prop.startsWith('--')) {
          style.setProperty(prop, v);
        } else {
          (style as unknown as Record<string, string>)[prop] = v;
        }
      }
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign((el as HTMLElement).dataset, value);
    } else if (PROPERTY_KEYS.has(key)) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    el.append(typeof child === 'object' ? child : String(child));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
