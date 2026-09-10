/**
 * JSX runtime for lambdock functions. It renders to an HTML string at once.
 * This file is copied to `data/jsx/jsx-runtime` at boot. Do not edit it there.
 *
 * A `handler.tsx` selects it with this first line:
 *
 * ```tsx
 * /** @jsxImportSource ../../jsx *\/
 * ```
 *
 * Deno appends `/jsx-runtime` to that path and adds no extension, so the copy
 * in the data directory has none.
 */
import { type Html, isHtml, raw } from "../lambdock.ts";

export type Child = Html | string | number | bigint | boolean | null | undefined | Child[];

/** Any child renders: an unknown value becomes escaped text. */
export type Props = Record<string, unknown>;

export type Component<P = Props> = (props: P) => Child;

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const ALIAS: Record<string, string> = { className: "class", htmlFor: "for" };

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPE[c]);
}

function renderChild(child: unknown): string {
  if (child === null || child === undefined || typeof child === "boolean") return "";
  if (Array.isArray(child)) return child.map(renderChild).join("");
  if (isHtml(child)) return child.toString();
  return escape(String(child));
}

function renderStyle(style: Record<string, unknown>): string {
  return Object.entries(style)
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}:${v}`)
    .join(";");
}

function renderAttrs(props: Props): string {
  let out = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "dangerouslySetInnerHTML") continue;
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") continue;
    const name = ALIAS[key] ?? key;
    if (value === true) {
      out += ` ${name}`;
      continue;
    }
    const text = name === "style" && typeof value === "object"
      ? renderStyle(value as Record<string, unknown>)
      : String(value);
    out += ` ${name}="${escape(text)}"`;
  }
  return out;
}

export function jsx(type: string | Component, props: Props): Html {
  if (typeof type === "function") return raw(renderChild(type(props)));
  const open = `<${type}${renderAttrs(props)}>`;
  if (VOID.has(type)) return raw(open);
  const inner = props.dangerouslySetInnerHTML as { __html: string } | undefined;
  return raw(`${open}${inner ? inner.__html : renderChild(props.children)}</${type}>`);
}

export { jsx as jsxs };

export function Fragment(props: { children?: unknown }): Html {
  return raw(renderChild(props.children));
}

// deno-lint-ignore no-namespace
export namespace JSX {
  export type Element = Html;
  export type ElementType = string | Component<never>;
  export interface IntrinsicElements {
    [tag: string]: Props;
  }
  export interface ElementChildrenAttribute {
    children: unknown;
  }
}
