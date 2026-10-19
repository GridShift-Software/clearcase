// Email reader: postal-mime 4 for EML, @kenjiuno/msgreader for Outlook MSG, DOMPurify for the HTML body. Headers,
// body and attachments show together. The sanitised body goes into a script-free sandboxed child frame with only
// data: images (CID parts); remote images, styles, forms and scripts are removed and counted. Attachments open through
// the shell by their key in the trusted descriptor; each one's hash is checked against that descriptor.
import PostalMime from 'postal-mime';
import MsgReaderModule from '@kenjiuno/msgreader';
import DOMPurify from 'dompurify';
import { Buffer } from 'buffer';
import { app, boot, el, fail, okRes, publish, send, state, RenderError } from './common.mjs';
import { sniff } from '../shared/formats.mjs';

globalThis.Buffer ??= Buffer;
const MsgReader = MsgReaderModule.default ?? MsgReaderModule;
boot('email', { open });

const hex = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

async function parse(bytes) {
  const s = sniff(bytes);
  if (s.kind === 'mbox') throw new RenderError('bulk-mailbox', 'this is an mbox mailbox archive, not one email; it needs manual extraction into individual messages');
  if (s.kind === 'ole') {
    const r = new MsgReader(bytes);
    const d = r.getFileData();
    if (d.error) throw new RenderError('msg-unreadable', d.error);
    const html = d.bodyHtml ?? (d.html ? new TextDecoder().decode(d.html) : null);
    const headerLines = d.headers ? d.headers.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).filter(Boolean).map((l) => { const i = l.indexOf(':'); return { key: l.slice(0, i).trim().toLowerCase(), value: l.slice(i + 1).trim() }; }) : [];
    return {
      format: 'msg', subject: d.subject ?? '', from: `${d.senderName ?? ''} <${d.senderSmtpAddress ?? d.senderEmail ?? ''}>`,
      to: (d.recipients ?? []).filter((x) => x.recipType !== 'cc').map((x) => `${x.name} <${x.smtpAddress ?? x.email}>`).join(', '),
      cc: (d.recipients ?? []).filter((x) => x.recipType === 'cc').map((x) => `${x.name} <${x.smtpAddress ?? x.email}>`).join(', '),
      date: headerLines.find((h) => h.key === 'date')?.value ?? '', messageId: headerLines.find((h) => h.key === 'message-id')?.value ?? '',
      headers: headerLines, text: d.body ?? null, html, rtfOnly: !d.body && !html && !!d.compressedRtf,
      attachments: d.attachments.map((a, i) => ({ key: String(i), name: a.innerMsgContent ? `${a.name}.msg` : a.fileName, mime: a.innerMsgContent ? 'application/vnd.ms-outlook' : a.attachMimeTag, cid: a.pidContentId ?? null, content: new Uint8Array(r.getAttachment(a).content) })),
    };
  }
  const e = await PostalMime.parse(bytes, { attachmentEncoding: 'arraybuffer' });
  const addr = (a) => (a ? (a.group ? a.group.map(addr).join(', ') : `${a.name ? `${a.name} ` : ''}<${a.address}>`) : '');
  return {
    format: 'eml', subject: e.subject ?? '', from: addr(e.from), to: (e.to ?? []).map(addr).join(', '), cc: (e.cc ?? []).map(addr).join(', '), date: e.date ?? '', messageId: e.messageId ?? '',
    headers: e.headers, text: e.text ?? null, html: e.html ?? null, rtfOnly: false,
    attachments: e.attachments.map((a, i) => ({ key: String(i), name: a.filename, mime: a.mimeType, cid: a.contentId ? a.contentId.replace(/^<|>$/g, '') : null, inline: a.disposition === 'inline', content: new Uint8Array(a.content) })),
  };
}

function sanitize(html, attachments) {
  const removed = { remoteImages: 0, links: 0 };
  const cidMap = new Map(attachments.filter((a) => a.cid).map((a) => [a.cid, a]));
  DOMPurify.removeAllHooks();
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? '';
      const cid = /^cid:(.+)$/i.exec(src)?.[1];
      const att = cid && cidMap.get(cid);
      if (att && /^image\/(png|jpeg|gif|webp)$/.test(att.mime ?? '')) node.setAttribute('src', `data:${att.mime};base64,${b64(att.content)}`);
      else { node.removeAttribute('src'); node.setAttribute('alt', `[remote image blocked${node.getAttribute('alt') ? `: ${node.getAttribute('alt')}` : ''}]`); removed.remoteImages++; }
    }
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      const href = node.getAttribute('href');
      if (!/^mailto:/i.test(href)) { node.setAttribute('title', `Link not followed: ${href.slice(0, 200)}`); node.removeAttribute('href'); removed.links++; }
    }
    for (const a of ['background', 'style']) if (node.hasAttribute?.(a) && /url\s*\(/i.test(node.getAttribute(a))) node.removeAttribute(a);
  });
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'frame', 'object', 'embed', 'svg', 'math', 'video', 'audio', 'source'], FORBID_ATTR: ['srcset', 'action', 'formaction', 'background', 'ping'], ALLOW_DATA_ATTR: false, WHOLE_DOCUMENT: false });
  removed.elements = DOMPurify.removed.map((r) => r.element?.tagName?.toLowerCase() ?? `@${r.attribute?.name}`).filter(Boolean);
  DOMPurify.removeAllHooks();
  return { clean, removed };
}

async function open(descriptor, bytes, extras, target) {
  const m = await parse(bytes);
  const trusted = new Map((descriptor.children ?? []).map((c) => [c.key, c]));
  for (const a of m.attachments) { a.sha256 = await hex(a.content); a.trusted = trusted.get(a.key) ?? null; a.hashMatches = a.trusted ? a.trusted.sha256 === a.sha256 : false; }
  const E = (state.email = { format: m.format, subject: m.subject, from: m.from, to: m.to, cc: m.cc, date: m.date, messageId: m.messageId, headerCount: m.headers.length, rtfOnly: m.rtfOnly, attachments: m.attachments.map(({ content, trusted, ...a }) => a), removed: null, selected: null });
  const dl = el('dl', { class: 'email-headers' });
  for (const [k, v] of [['From', m.from], ['To', m.to], ['Cc', m.cc], ['Date', m.date], ['Subject', m.subject], ['Message-ID', m.messageId]]) if (v) dl.append(el('dt', {}, k), el('dd', { 'data-h': k.toLowerCase() }, String(v)));
  const raw = el('details', { id: 'all-headers' }, el('summary', {}, `All headers in original order (${m.headers.length})`), el('pre', { class: 'raw-headers' }, m.headers.map((h) => `${h.key}: ${h.value}`).join('\n')));
  app.append(dl, raw);
  if (m.rtfOnly) app.append(el('p', { class: 'notice', id: 'rtf-only' }, 'The body is stored only as RTF. A prepared readable companion is required before publication.'));
  if (m.html) {
    const { clean, removed } = sanitize(m.html, m.attachments);
    E.removed = removed;
    const frame = el('iframe', { class: 'email-body', id: 'body-frame', title: 'Message body (sanitised, scripts disabled)', sandbox: '', referrerpolicy: 'no-referrer' });
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">${clean}`;
    app.append(el('p', { class: 'notice', id: 'removed' }, `Removed for safety: ${removed.remoteImages} remote image(s), ${removed.links} link target(s), ${removed.elements.length} element(s)/attribute(s).`), frame);
    E.bodyHtml = clean;
  }
  if (m.text) app.append(el('details', { id: 'plain', open: !m.html }, el('summary', {}, 'Plain-text body'), el('pre', { class: 'plain-body' }, m.text)));
  const list = el('ul', { class: 'attachments', 'aria-label': 'Attachments' });
  for (const a of m.attachments) {
    list.append(el('li', { 'data-key': a.key }, el('button', { type: 'button', 'data-key': a.key, onclick: () => send({ type: 'open-child', key: a.key }) }, `${a.name ?? '(unnamed)'} — ${a.mime ?? 'unknown type'}, ${a.content.length} bytes${a.cid ? ', inline' : ''}`), a.hashMatches ? null : el('span', { class: 'badge' }, 'hash does not match the import record')));
  }
  app.append(el('h2', {}, `Attachments (${m.attachments.length})`), list);
  publish();
  return {
    async navigate(t) {
      for (const n of list.querySelectorAll('li.target')) n.classList.remove('target');
      if (!t || t.kind === 'file' || t.kind === 'message') return okRes(t?.kind === 'message' ? 'Message' : 'File-level reference: no precise location supplied', { fileLevel: !t || t.kind === 'file' });
      if (t.kind !== 'attachment') return fail('unsupported-target', `target kind ${t.kind} does not apply to an email`, true);
      let hit;
      if (t.key !== undefined) hit = m.attachments.find((a) => a.key === String(t.key));
      else if (t.name !== undefined) {
        const byName = m.attachments.filter((a) => a.name === t.name);
        if (byName.length > 1) return fail('ambiguous-attachment', `${byName.length} attachments are named ${JSON.stringify(t.name)}; cite one by its position`, true);
        hit = byName[0];
      }
      if (!hit) return fail('invalid-target', `no attachment ${JSON.stringify(t.key ?? t.name)}`, true);
      const li = list.querySelector(`li[data-key="${hit.key}"]`);
      li.classList.add('target');
      li.querySelector('button').focus();
      E.selected = hit.key;
      publish();
      return okRes(`Attachment ${Number(hit.key) + 1}: ${hit.name}`);
    },
  };
}
