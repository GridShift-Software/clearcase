// Synthetic Outlook .msg (MS-OXMSG) writer over SheetJS's cfb compound-file library. It writes the property streams
// an Outlook "Save as .msg" carries for subject, sender, recipients, bodies, transport headers and attachments,
// including an embedded message (attach method 5). It is a structure model, not an Outlook export.
import CFB from 'cfb';

const utf16 = (s) => Buffer.from(s + '', 'utf16le');
const NAMES = { subject: '0037001F', normalizedSubject: '0E1D001F', senderName: '0C1A001F', senderSmtp: '5D01001F', senderEmail: '0C1F001F', body: '1000001F', html: '10130102', headers: '007D001F', rtf: '10090102', messageClass: '001A001F' };

function props(headerBytes, entries) {
  const buf = Buffer.alloc(headerBytes + entries.length * 16);
  entries.forEach(([tag, value], i) => {
    const o = headerBytes + i * 16;
    buf.writeUInt32LE(tag, o); buf.writeUInt32LE(6, o + 4); buf.writeUInt32LE(value, o + 8);
  });
  return buf;
}

/** Add one message's streams under `base` ('' for the root). */
function addMessage(cfb, base, m, headerBytes) {
  const put = (name, data) => CFB.utils.cfb_add(cfb, `${base}/${name}`, data);
  put('__substg1.0_' + NAMES.messageClass, utf16('IPM.Note'));
  put('__substg1.0_' + NAMES.subject, utf16(m.subject));
  put('__substg1.0_' + NAMES.normalizedSubject, utf16(m.subject));
  put('__substg1.0_' + NAMES.senderName, utf16(m.from[0]));
  put('__substg1.0_' + NAMES.senderSmtp, utf16(m.from[1]));
  put('__substg1.0_' + NAMES.senderEmail, utf16(m.from[1]));
  if (m.body) put('__substg1.0_' + NAMES.body, utf16(m.body));
  if (m.html) put('__substg1.0_' + NAMES.html, Buffer.from(m.html, 'utf8'));
  if (m.headers) put('__substg1.0_' + NAMES.headers, utf16(m.headers));
  if (m.rtf) put('__substg1.0_' + NAMES.rtf, m.rtf);
  const recips = m.to ?? [];
  recips.forEach(([name, addr], i) => {
    const d = `__recip_version1.0_#${String(i).padStart(8, '0')}`;
    put(`${d}/__substg1.0_3001001F`, utf16(name));
    put(`${d}/__substg1.0_3003001F`, utf16(addr));
    put(`${d}/__substg1.0_39FE001F`, utf16(addr));
    put(`${d}/__properties_version1.0`, props(8, [[0x0c150003, 1]]));
  });
  const atts = m.attachments ?? [];
  atts.forEach((a, i) => {
    const d = `__attach_version1.0_#${String(i).padStart(8, '0')}`;
    if (a.message) {
      put(`${d}/__substg1.0_3001001F`, utf16(a.name));
      put(`${d}/__properties_version1.0`, props(8, [[0x37050003, 5]]));
      addMessage(cfb, `${base}/${d}/__substg1.0_3701000D`, a.message, 24);
    } else {
      put(`${d}/__substg1.0_3707001F`, utf16(a.name));
      put(`${d}/__substg1.0_3704001F`, utf16(a.name.slice(0, 8)));
      put(`${d}/__substg1.0_370E001F`, utf16(a.mime));
      if (a.cid) put(`${d}/__substg1.0_3712001F`, utf16(a.cid));
      put(`${d}/__substg1.0_37010102`, Buffer.from(a.data));
      put(`${d}/__properties_version1.0`, props(8, [[0x37050003, 1]]));
    }
  });
  const h = Buffer.alloc(headerBytes);
  if (headerBytes >= 24) { h.writeUInt32LE(recips.length, 8); h.writeUInt32LE(atts.length, 12); h.writeUInt32LE(recips.length, 16); h.writeUInt32LE(atts.length, 20); }
  put('__properties_version1.0', Buffer.concat([h, props(0, [])]));
}

export function buildMsg(m) {
  const cfb = CFB.utils.cfb_new();
  addMessage(cfb, '', m, 32);
  return new Uint8Array(CFB.write(cfb, { type: 'buffer' }));
}

/** Uncompressed ("MELA") compressed-RTF container, as Outlook stores an RTF-only body. */
export function melaRtf(rtf) {
  const raw = Buffer.from(rtf, 'latin1');
  const h = Buffer.alloc(16);
  h.writeUInt32LE(raw.length + 12, 0); h.writeUInt32LE(raw.length, 4); h.write('MELA', 8, 'latin1'); h.writeUInt32LE(0, 12);
  return Buffer.concat([h, raw]);
}
