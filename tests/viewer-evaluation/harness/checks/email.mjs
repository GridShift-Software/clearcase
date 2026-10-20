import { accepts, keyboardRoundTrip, layout, opens, rejects, sleep } from './common.mjs';

const F = 'email';
const EML = 'postal-mime 4.0.11 + DOMPurify 3.4.17';
const MSG = '@kenjiuno/msgreader 1.29.0 + DOMPurify 3.4.17';
const em = async (c) => (await c.rstate()).email;
const bodyText = (c) => c.inFrame(() => { const f = document.getElementById('body-frame'); return { html: window.__r.email.bodyHtml ?? '', plain: document.getElementById('plain')?.textContent ?? '' }; });

async function attachmentsOpen(c, id, comp, keys) {
  for (const key of keys) {
    const d = c.descriptors.get(id).children.find((x) => x.key === key);
    await c.inFrame((k) => { const b = document.querySelector(`.attachments button[data-key="${k}"]`); setTimeout(() => b.click(), 0); }, key);
    await sleep(800);
    const cur = await c.page.evaluate(() => window.__shell.current());
    const st = await c.rstate();
    c.record(F, id, comp, `attachment ${key} (${d.name}) opens in its own reader from the trusted child list`, cur?.family === c.descriptors.get(d.assetId).family && st?.ready === true, `shell opened ${d.assetId} as ${c.descriptors.get(d.assetId).family} and it reported ready`, { family: cur?.family, ready: st?.ready, error: st?.error });
    await c.open(id);
  }
}

export default async function email(c, { full }) {
  let id = 'email/gmail-download.eml';
  await opens(c, F, id, EML);
  await layout(c, F, id, EML);
  if (!full) { await accepts(c, F, id, EML, { kind: 'attachment', key: 1 }, 'statement.pdf'); return; }
  let st = await em(c);
  c.record(F, id, EML, 'Gmail-shaped EML: headers (encoded-word subject, From/To/Cc/Date/Message-ID)', st.subject.includes('Zoë GMAIL-SUBJECT-TOKEN') && st.from.includes('sender@example.invalid') && st.cc.includes('cc2@example.invalid') && st.messageId.includes('CAsyntheticMessage0001@mail.example.test') && st.headerCount === 10, 'decoded subject, sender, both Cc, Message-ID, 10 header lines in order', st);
  let b = await bodyText(c);
  c.record(F, id, EML, 'HTML and plain-text alternatives both available', b.html.includes('GMAIL-HTML-BODY-TOKEN') && b.plain.includes('GMAIL-PLAIN-BODY-TOKEN'), 'sanitised HTML and plain alternative carry their tokens', null);
  c.record(F, id, EML, 'inline CID image bound to its attachment as data:, no remote load', /src="data:image\/png;base64,/.test(b.html) && st.removed.remoteImages === 0, 'img src rewritten to data:image/png; 0 remote images', st.removed);
  c.record(F, id, EML, 'attachments hashed and matched to the import graph (duplicate names kept)', st.attachments.length === 4 && st.attachments.every((a) => a.hashMatches) && st.attachments.filter((a) => a.name === 'notes.txt').length === 2, '4 attachments, every sha256 matches the descriptor child, two notes.txt', st.attachments.map((a) => [a.key, a.name, a.hashMatches]));
  await accepts(c, F, id, EML, { kind: 'attachment', key: 1 }, 'statement.pdf', async () => (await em(c)).selected === '1');
  await rejects(c, F, id, EML, [[{ kind: 'attachment', name: 'notes.txt' }, 'ambiguous-attachment'], [{ kind: 'attachment', key: 9 }, 'invalid-target'], [{ kind: 'attachment', name: 'missing.pdf' }, 'invalid-target']], async () => (await em(c)).selected);
  await accepts(c, F, id, EML, { kind: 'file' }, 'File-level reference');
  await keyboardRoundTrip(c, F, id, EML);
  await attachmentsOpen(c, id, EML, ['0', '1', '2']);

  id = 'email/outlook-download.eml';
  await opens(c, F, id, EML);
  st = await em(c);
  b = await bodyText(c);
  const raw = await c.inFrame(() => document.querySelector('#all-headers pre').textContent);
  c.record(F, id, EML, 'Outlook-shaped EML: folded subject unfolded, Latin-1 body decoded, duplicate headers kept in order', st.subject.endsWith('folds onto a second header line OUTLOOK-SUBJECT-TOKEN') && b.plain.includes('Café crème') && b.html.includes('Café crème') && raw.indexOf('x-synthetic-duplicate: first') < raw.indexOf('x-synthetic-duplicate: second') && raw.includes('thread-index:'), 'unfolded subject; Café crème in both bodies; both X-Synthetic-Duplicate lines in order; Thread-Index kept', { subject: st.subject });
  c.record(F, id, EML, 'nested message/rfc822 and nested .msg listed with matching hashes', st.attachments.length === 2 && st.attachments.every((a) => a.hashMatches), '2 attachments (forwarded.eml, attached-outlook.msg), hashes match', st.attachments.map((a) => [a.name, a.mime, a.hashMatches]));
  await attachmentsOpen(c, id, EML, ['0', '1']);
  const nested = c.descriptors.get('email/outlook-download.eml#1');
  c.record(F, id, 'candidate import', 'nested MSG inside EML expands recursively to its own attachments (3 levels)', nested?.children?.length === 3 && c.descriptors.get('email/outlook-download.eml#1#2')?.children?.length === 1, 'EML -> MSG (3 children) -> embedded MSG (1 child)', nested?.children?.map((x) => x.name));

  id = 'email/outlook-save-as.msg';
  await opens(c, F, id, MSG);
  st = await em(c);
  b = await bodyText(c);
  c.record(F, id, MSG, 'Outlook-shaped MSG: subject, sender, recipients, transport headers', st.subject.includes('Zoë MSG-SUBJECT-TOKEN') && st.from.includes('sender@example.invalid') && st.to.includes('recipient@example.invalid') && st.messageId.includes('SYNTHMSG0001') && st.headerCount >= 4, 'Unicode subject, SMTP sender, To list, Message-ID from transport headers', st);
  c.record(F, id, MSG, 'MSG HTML body sanitised: CID inline bound, remote pixel removed', b.html.includes('MSG-HTML-BODY-TOKEN') && /src="data:image\/png;base64,/.test(b.html) && st.removed.remoteImages === 1, 'HTML token; CID image as data:; 1 remote image blocked', st.removed);
  c.record(F, id, MSG, 'MSG attachments incl. embedded message, hashes match the import graph', st.attachments.length === 3 && st.attachments.every((a) => a.hashMatches) && st.attachments[2].name.endsWith('.msg'), '3 attachments, the third an embedded .msg', st.attachments.map((a) => [a.name, a.hashMatches]));
  await attachmentsOpen(c, id, MSG, ['1', '2']);

  id = 'email/outlook-rtf-only.msg';
  await opens(c, F, id, MSG);
  st = await em(c);
  c.record(F, id, MSG, 'RTF-only body flagged for a prepared companion (reader and import)', st.rtfOnly === true && c.descriptors.get(id).holds.some((h) => h.code === 'rtf-only-body-needs-companion'), "rtfOnly notice shown and import hold 'rtf-only-body-needs-companion'", { rtfOnly: st.rtfOnly });

  id = 'email/hostile.eml';
  const e0 = c.mon.egress.length;
  await opens(c, F, id, EML);
  await sleep(800);
  st = await c.rstate();
  b = await bodyText(c);
  const forged = c.mon.dialogs.length;
  c.record(F, id, EML, 'hostile HTML: no script, handler, form, remote CSS/image/iframe or refresh survives', !/<script|onload=|onerror=|<form|<iframe|<link|<meta|<style|<svg|javascript:/i.test(b.html) && b.html.includes('HOSTILE-HTML-BODY-TOKEN'), 'sanitised HTML keeps the text token and none of the active constructs', { removed: st.email.removed });
  c.record(F, id, EML, 'hostile HTML: zero egress, zero dialogs', c.egressSince(e0).length === 0 && forged === 0, 'no egress attempts reached the network layer; no dialogs', { egress: c.egressSince(e0), cspBlocked: st.blocked });
  c.record(F, id, 'candidate import', 'malformed base64 part and TNEF attachment hold the message', ['malformed-mime-part', 'tnef-needs-companion'].every((k) => c.descriptors.get(id).holds.some((h) => h.code === k)), "holds include 'malformed-mime-part' and 'tnef-needs-companion'", c.descriptors.get(id).holds.map((h) => h.code));

  id = 'email/gmail-takeout.mbox';
  const mb = await c.open(id);
  c.record(F, id, EML, 'bulk mailbox refused as one email (manual extraction required)', mb.type === 'error' && mb.code === 'bulk-mailbox', "renderer error 'bulk-mailbox'", { code: mb.code });
  c.record(F, id, 'candidate import', 'bulk mailbox held at import', c.descriptors.get(id).holds.some((h) => h.code === 'bulk-mailbox-needs-manual-extraction'), "hold 'bulk-mailbox-needs-manual-extraction'", null);
}
