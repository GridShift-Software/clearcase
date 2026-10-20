// Checks every family repeats: open-and-ready, layout at the current viewport, keyboard round trip between shell and
// renderer, and target resolution that must fail without moving the view.

export async function opens(c, family, fixture, component, target, opts) {
  const r = await c.open(fixture, target, opts);
  c.record(family, fixture, component, 'opens in the protected shell and reports ready', r.type === 'ready', "shell receives 'ready' from the renderer generation it created", { type: r.type, ms: r.ms, code: r.code, message: r.message });
  return r;
}

/** Shell and renderer chrome fit the viewport: no horizontal page scroll, toolbar inside the viewport. */
export async function layout(c, family, fixture, component) {
  const shell = await c.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
  const inner = await c.inFrame(() => {
    const bar = document.querySelector('.toolbar, .tabs, .email-headers, table.entries, video, audio, .img-wrap');
    const r = bar?.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().height);
    return { sw: document.documentElement.scrollWidth, w: innerWidth, barRight: r ? Math.round(r.right) : null, minButton: buttons.length ? Math.min(...buttons) : null };
  });
  const pass = shell.sw <= shell.w + 1 && inner.sw <= inner.w + 1 && (inner.barRight === null || inner.barRight <= inner.w + 1);
  const shot = await c.shot(`${family}-${fixture}`);
  c.record(family, fixture, component, 'layout fits the viewport (no horizontal scroll of shell or reader chrome)', pass, 'shell.scrollWidth<=innerWidth && reader.scrollWidth<=innerWidth && controls inside viewport', { shell, inner, screenshot: shot });
  if (c.viewport.startsWith('mobile')) c.record(family, fixture, component, 'touch targets at least 24 CSS px high', inner.minButton === null || inner.minButton >= 24, 'min visible button height >= 24', { minButton: inner.minButton });
}

/** Tab from the shell's last control lands inside the reader; Escape inside the reader returns focus to the shell. */
export async function keyboardRoundTrip(c, family, fixture, component) {
  await c.page.focus('#viewer-close');
  await c.page.keyboard.press('Tab');
  const inside = await c.inFrame(() => { const a = document.activeElement; return a && a !== document.body ? (a.id || a.tagName) : null; });
  await c.page.keyboard.press('Escape');
  await sleep(150);
  const back = await c.page.evaluate(() => document.activeElement?.id ?? null);
  c.record(family, fixture, component, 'keyboard: Tab enters the reader, Escape returns focus to the shell', !!inside && back === 'viewer-close', 'focused element inside frame after Tab; #viewer-close focused after Escape', { inside, back });
}

/** Each target must fail with the expected code, and the view must not move. */
export async function rejects(c, family, fixture, component, cases, where) {
  for (const [target, code] of cases) {
    const before = await where();
    const r = await c.navigate(target);
    const after = await where();
    const res = r.resolution ?? r;
    c.record(family, fixture, component, `target ${JSON.stringify(target)} is refused, not clamped`, res.ok === false && res.code === code && JSON.stringify(before) === JSON.stringify(after), `resolution.code==='${code}' && view unchanged`, { res, before, after });
  }
}

export async function accepts(c, family, fixture, component, target, label, verify) {
  const r = await c.navigate(target);
  const res = r.resolution ?? r;
  const v = verify ? await verify() : true;
  c.record(family, fixture, component, `target ${JSON.stringify(target)} opens the cited location`, res.ok === true && v === true && (!label || res.label.includes(label)), `resolution.ok${label ? ` && label includes '${label}'` : ''}${verify ? ' && location verified in the DOM' : ''}`, { res, verified: v });
  return res;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
