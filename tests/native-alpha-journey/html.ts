// Reading the hosted pages' stable `data-*` hooks out of server-rendered HTML, without a DOM. A page that lacks a hook
// yields nothing, and the scenario then fails on the missing fact: no hook is assumed.
export type Attrs = Record<string, string>;
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The attributes of every start tag that has `attr`, optionally with one given value. */
export function tagsWith(html: string, attr: string, value?: string): Attrs[] {
  const found: Attrs[] = [];
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)\b([^<>]*)>/g)) {
    const attrs: Attrs = {};
    for (const a of m[2].matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?/g)) attrs[a[1].toLowerCase()] = unescape(a[2] ?? a[3] ?? a[4] ?? '');
    if (Object.hasOwn(attrs, attr) && (value === undefined || attrs[attr] === value)) found.push({ ...attrs, _tag: m[1].toLowerCase() });
  }
  return found;
}
export const attrOf = (html: string, attr: string): string | null => tagsWith(html, attr)[0]?.[attr] ?? null;

/** Text of the element that starts at the first tag with `attr`, up to the next closing tag of any kind (a hook's short text). */
export function textAfter(html: string, attr: string, value?: string): string | null {
  const re = new RegExp(`<[^<>]*\\b${attr.replace(/[-]/g, '\\-')}\\b[^<>]*>`, 'g');
  for (const m of html.matchAll(re)) {
    if (value !== undefined && !m[0].includes(`"${value}"`)) continue;
    const rest = html.slice(m.index + m[0].length);
    return unescape(rest.slice(0, rest.indexOf('<') < 0 ? undefined : rest.indexOf('<')).trim());
  }
  return null;
}
export const visibleText = (html: string): string => unescape(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
