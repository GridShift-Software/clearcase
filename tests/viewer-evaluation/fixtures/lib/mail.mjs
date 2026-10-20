// Synthetic RFC 5322 messages shaped like a Gmail "Download message" export and an Outlook "Download" EML. They are
// structure models written by this generator, not files exported by Gmail or Outlook. Every address is under
// example.invalid; remote URLs point at canary.invalid.
const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/.{76}/g, '$&\r\n');
const lines = (...l) => l.join('\r\n');
const part = (headers, body) => lines(...headers, '', body);
const multipart = (type, boundary, parts) => [`Content-Type: multipart/${type}; boundary="${boundary}"`, lines('', ...parts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`, '')];

const HTML_GMAIL = '<div dir="ltr"><p>GMAIL-HTML-BODY-TOKEN</p><p>Inline image: <img src="cid:ii_synthetic01" alt="inline chart"></p></div>';

export function gmailEml({ pdf, png }) {
  const alt = multipart('alternative', '000000000000alt0001', [
    part(['Content-Type: text/plain; charset="UTF-8"'], 'GMAIL-PLAIN-BODY-TOKEN\r\nInline image: [image: inline chart]'),
    part(['Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: quoted-printable'], HTML_GMAIL.replace(/=/g, '=3D')),
  ]);
  const related = multipart('related', '000000000000rel0001', [
    lines(alt[0], alt[1]),
    part(['Content-Type: image/png; name="chart.png"', 'Content-Disposition: inline; filename="chart.png"', 'Content-Transfer-Encoding: base64', 'Content-ID: <ii_synthetic01>', 'X-Attachment-Id: ii_synthetic01'], b64(png)),
  ]);
  const mixed = multipart('mixed', '000000000000mix0001', [
    lines(related[0], related[1]),
    part(['Content-Type: application/pdf; name="statement.pdf"', 'Content-Disposition: attachment; filename="statement.pdf"', 'Content-Transfer-Encoding: base64', 'X-Attachment-Id: f_synthetic01'], b64(pdf)),
    part(['Content-Type: text/plain; charset="UTF-8"; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', 'Content-Transfer-Encoding: base64'], b64(Buffer.from('GMAIL-NOTES-FIRST'))),
    part(['Content-Type: text/plain; charset="UTF-8"; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', 'Content-Transfer-Encoding: base64'], b64(Buffer.from('GMAIL-NOTES-SECOND'))),
  ]);
  return lines(
    'MIME-Version: 1.0',
    'Date: Tue, 2 Jan 2001 09:15:00 +0200',
    'References: <CAsyntheticParent0001@mail.example.test>',
    'In-Reply-To: <CAsyntheticParent0001@mail.example.test>',
    'Message-ID: <CAsyntheticMessage0001@mail.example.test>',
    'Subject: =?UTF-8?B?' + Buffer.from('Gmail synthetic – Zoë GMAIL-SUBJECT-TOKEN').toString('base64') + '?=',
    'From: Synthetic Sender <sender@example.invalid>',
    'To: Synthetic Recipient <recipient@example.invalid>',
    'Cc: Second Recipient <cc@example.invalid>, Third Recipient <cc2@example.invalid>',
    mixed[0], mixed[1]);
}

/** Outlook-shaped EML: Latin-1 QP body, folded subject, a nested message/rfc822 and a nested .msg attachment. */
export function outlookEml({ msg, nestedPng }) {
  const nested = lines(
    'From: Inner Sender <inner@example.invalid>',
    'To: Synthetic Recipient <recipient@example.invalid>',
    'Subject: OUTLOOK-NESTED-SUBJECT-TOKEN',
    'Date: Mon, 1 Jan 2001 08:00:00 +0000',
    'Message-ID: <inner0001@example.invalid>',
    'MIME-Version: 1.0',
    ...multipart('mixed', 'inner_boundary_01', [
      part(['Content-Type: text/plain; charset="us-ascii"'], 'OUTLOOK-NESTED-BODY-TOKEN'),
      part(['Content-Type: image/png; name="inner.png"', 'Content-Disposition: attachment; filename="inner.png"', 'Content-Transfer-Encoding: base64'], b64(nestedPng)),
    ]));
  const alt = multipart('alternative', '_000_SYNTHETICALT_', [
    part(['Content-Type: text/plain; charset="iso-8859-1"', 'Content-Transfer-Encoding: quoted-printable'], 'OUTLOOK-PLAIN-BODY-TOKEN Caf=E9 cr=E8me'),
    part(['Content-Type: text/html; charset="iso-8859-1"', 'Content-Transfer-Encoding: quoted-printable'], '<html><head><meta http-equiv=3D"Content-Type" content=3D"text/html; charset=3Diso-8859-1"></head><body><p class=3D"MsoNormal">OUTLOOK-HTML-BODY-TOKEN Caf=E9 cr=E8me</p></body></html>'),
  ]);
  const mixed = multipart('mixed', '_004_SYNTHETICMIX_', [
    lines(alt[0], alt[1]),
    part(['Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="forwarded.eml"'], nested),
    part(['Content-Type: application/vnd.ms-outlook; name="attached-outlook.msg"', 'Content-Disposition: attachment; filename="attached-outlook.msg"', 'Content-Transfer-Encoding: base64'], b64(msg)),
  ]);
  return lines(
    'Received: from SYNTH01.example.invalid (192.0.2.10) by SYNTH02.example.invalid',
    ' (192.0.2.11) with Microsoft SMTP Server id 15.20.0000.000; Tue, 2 Jan 2001',
    ' 10:00:00 +0000',
    'From: Synthetic Sender <sender@example.invalid>',
    'To: Synthetic Recipient <recipient@example.invalid>',
    'Subject: Outlook synthetic message with a deliberately long subject line that',
    ' folds onto a second header line OUTLOOK-SUBJECT-TOKEN',
    'Thread-Topic: Outlook synthetic message',
    'Thread-Index: AQHZsynthetic0001',
    'Date: Tue, 2 Jan 2001 10:00:00 +0000',
    'Message-ID: <SYNTH01MB0001@SYNTH01.example.invalid>',
    'Accept-Language: en-US',
    'Content-Language: en-US',
    'X-MS-Has-Attach: yes',
    'X-MS-TNEF-Correlator:',
    'X-Synthetic-Duplicate: first',
    'X-Synthetic-Duplicate: second',
    'MIME-Version: 1.0',
    mixed[0], mixed[1]);
}

/** HTML active content, remote resources and a malformed part. Nothing here may run or fetch. */
export function hostileEml() {
  const html = [
    '<html><head><meta http-equiv="refresh" content="0;url=http://canary.invalid/refresh">',
    '<link rel="stylesheet" href="http://canary.invalid/style.css"><style>@import url("http://canary.invalid/import.css"); body{background:url("http://canary.invalid/bg.png")}</style></head>',
    '<body onload="fetch(\'http://canary.invalid/onload\')"><p>HOSTILE-HTML-BODY-TOKEN</p>',
    '<script>fetch("http://canary.invalid/script");parent.postMessage("forged","*")</script>',
    '<img src="http://canary.invalid/pixel.gif" width="1" height="1">',
    '<img src="x" onerror="fetch(\'http://canary.invalid/onerror\')">',
    '<a href="javascript:fetch(\'http://canary.invalid/js-link\')">HOSTILE-JS-LINK</a>',
    '<form action="http://canary.invalid/form"><input name="q" value="1"><button>Send</button></form>',
    '<svg><script>fetch("http://canary.invalid/svg")</script></svg>',
    '<iframe src="http://canary.invalid/iframe"></iframe>',
    '</body></html>',
  ].join('\n');
  const mixed = multipart('mixed', 'hostile_mix', [
    part(['Content-Type: text/html; charset="utf-8"'], html),
    part(['Content-Type: application/octet-stream; name="broken.bin"', 'Content-Disposition: attachment; filename="broken.bin"', 'Content-Transfer-Encoding: base64'], '!!!not base64@@@'),
    part(['Content-Type: application/ms-tnef; name="winmail.dat"', 'Content-Disposition: attachment; filename="winmail.dat"', 'Content-Transfer-Encoding: base64'], b64(Uint8Array.of(0x78, 0x9f, 0x3e, 0x22, 0x01, 0x00, 0x01, 0x06, 0x90, 0x08, 0x00))),
  ]);
  return lines('From: Hostile <hostile@example.invalid>', 'To: Synthetic Recipient <recipient@example.invalid>', 'Subject: HOSTILE-SUBJECT-TOKEN', 'Date: Tue, 2 Jan 2001 11:00:00 +0000', 'Message-ID: <hostile0001@example.invalid>', 'MIME-Version: 1.0', mixed[0], mixed[1]);
}

/** A Google Takeout-shaped mbox with two messages: a bulk container, not an individual email file. */
export function takeoutMbox() {
  const m = (n) => lines(`From 100000000000000${n}@xxx Tue Jan 02 09:0${n}:00 +0000 2001`, 'X-GM-THRID: 100000000000000' + n, 'X-Gmail-Labels: Inbox', `Message-ID: <mbox000${n}@mail.example.test>`, `Subject: MBOX-MESSAGE-${n}-TOKEN`, 'From: Synthetic Sender <sender@example.invalid>', 'To: Synthetic Recipient <recipient@example.invalid>', 'Date: Tue, 2 Jan 2001 09:00:00 +0000', 'Content-Type: text/plain; charset="UTF-8"', '', `MBOX-BODY-${n}-TOKEN`, '>From a quoted line in the body', '');
  return m(1) + '\r\n' + m(2) + '\r\n';
}

/** A plain multipart/mixed message whose only job is to carry attachments (each {name, mime, data}). */
export function carrierEml({ subject, body = 'CARRIER-BODY-TOKEN', attachments, messageId = 'carrier0001' }) {
  const mixed = multipart('mixed', `carrier_${messageId}`, [
    part(['Content-Type: text/plain; charset="utf-8"'], body),
    ...attachments.map((a) => part([`Content-Type: ${a.mime}; name="${a.name}"`, `Content-Disposition: attachment; filename="${a.name}"`, 'Content-Transfer-Encoding: base64'], b64(a.data))),
  ]);
  return lines('From: Carrier <carrier@example.invalid>', 'To: Synthetic Recipient <recipient@example.invalid>', `Subject: ${subject}`, 'Date: Tue, 2 Jan 2001 12:00:00 +0000', `Message-ID: <${messageId}@example.invalid>`, 'MIME-Version: 1.0', mixed[0], mixed[1]);
}

/**
 * Gmail "Forward as attachment" shape: the outer message carries the forwarded one as message/rfc822, which itself carries
 * a PDF and an earlier message (a thread). The transport headers model what a Gmail "Download message" export keeps
 * (Delivered-To, a Received chain, X-Google-Smtp-Source, ARC and Authentication-Results); every value is invented.
 */
export function gmailForwardedEml({ pdf }) {
  const earlier = carrierEml({ subject: 'GMAIL-EARLIER-THREAD-SUBJECT-TOKEN', body: 'GMAIL-EARLIER-BODY-TOKEN', attachments: [{ name: 'earlier-notes.txt', mime: 'text/plain', data: Buffer.from('GMAIL-EARLIER-NOTES-TOKEN') }], messageId: 'gmailearlier0001' });
  const middleBody = multipart('mixed', 'gfwd_middle_mix', [
    part(['Content-Type: text/plain; charset="UTF-8"'], 'GMAIL-FORWARDED-BODY-TOKEN'),
    part(['Content-Type: application/pdf; name="statement.pdf"', 'Content-Disposition: attachment; filename="statement.pdf"', 'Content-Transfer-Encoding: base64'], b64(pdf)),
    part(['Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="Earlier thread message.eml"'], earlier),
  ]);
  const middle = lines('From: Original Sender <original@example.invalid>', 'To: Synthetic Sender <sender@example.invalid>', 'Subject: GMAIL-FORWARDED-ORIGINAL-SUBJECT-TOKEN', 'Date: Mon, 1 Jan 2001 07:00:00 +0000', 'Message-ID: <gmailmiddle0001@example.invalid>', 'MIME-Version: 1.0', middleBody[0], middleBody[1]);
  const outer = multipart('mixed', 'gfwd_outer_mix', [
    part(['Content-Type: text/plain; charset="UTF-8"'], 'GMAIL-FWD-OUTER-BODY-TOKEN\r\n---------- Forwarded message ---------'),
    part(['Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="Original message.eml"'], middle),
  ]);
  return lines(
    'Delivered-To: recipient@example.invalid',
    'Received: by 2002:a05:6a00:0001:b0:0:0:0 with SMTP id synthetic0001csp1;',
    '        Tue, 2 Jan 2001 01:00:00 -0800 (PST)',
    'X-Google-Smtp-Source: ASYNTHETICxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'X-Received: by 2002:a05:6000:0001::0 with SMTP id synthetic0002mr1;',
    '        Tue, 02 Jan 2001 01:00:00 -0800 (PST)',
    'ARC-Seal: i=1; a=rsa-sha256; t=978426000; cv=none; d=google.invalid; s=arc-20160816; b=SYNTHETICSEAL',
    'ARC-Authentication-Results: i=1; mx.google.invalid; spf=pass smtp.mailfrom=sender@example.invalid',
    'Return-Path: <sender@example.invalid>',
    'Received: from mail-synthetic.example.invalid (mail-synthetic.example.invalid. [192.0.2.20])',
    '        by mx.google.invalid with ESMTPS id synthetic0003',
    'Authentication-Results: mx.google.invalid; spf=pass (google.invalid: synthetic) smtp.mailfrom=sender@example.invalid',
    'X-Gm-Message-State: SYNTHETICSTATE0001',
    'MIME-Version: 1.0',
    'Date: Tue, 2 Jan 2001 09:00:00 +0000',
    'Message-ID: <CAsyntheticFwd0001@mail.example.test>',
    'Subject: Fwd: GMAIL-FWD-OUTER-SUBJECT-TOKEN',
    'From: Synthetic Sender <sender@example.invalid>',
    'To: Synthetic Recipient <recipient@example.invalid>',
    outer[0], outer[1]);
}
