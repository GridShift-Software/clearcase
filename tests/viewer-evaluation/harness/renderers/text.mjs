// Plain-text reader for text attachments and archive members: UTF-8 (lenient) into a <pre> as a text node.
import { app, boot, el, fail, okRes, publish, state } from './common.mjs';

boot('text', {
  async open(descriptor, bytes) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    state.text = { chars: text.length, replacementChars: (text.match(/�/g) ?? []).length, head: text.slice(0, 200) };
    app.append(el('pre', { class: 'plain-body', tabindex: '0', id: 'text', 'aria-label': descriptor.name }, text));
    publish();
    return { navigate: async (t) => (!t || t.kind === 'file' ? okRes('File-level reference: no precise location supplied', { fileLevel: true }) : fail('unsupported-target', `target kind ${t.kind} does not apply to plain text`, true)) };
  },
});
