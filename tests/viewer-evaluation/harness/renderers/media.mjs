// Native <audio>/<video> reader over a blob URL. Records canPlayType, actual decode (metadata, dimensions), seeking and
// the frame colour after a seek, captions from a WebVTT companion, and audio track count where the API exists.
import { app, boot, el, fail, okRes, publish, state, RenderError } from './common.mjs';
import { sniff } from '../shared/formats.mjs';

boot('media', { open });

async function open(descriptor, bytes, extras) {
  const s = sniff(bytes);
  if (s.kind !== 'media') throw new RenderError('not-media', `content sniffed as ${s.mime}`);
  const video = !s.mime.startsWith('audio/');
  const m = el(video ? 'video' : 'audio', { controls: true, preload: 'auto', playsinline: true, id: 'player', 'aria-label': descriptor.name });
  const M = (state.media = { mime: s.mime, canPlayType: m.canPlayType(s.mime), duration: null, width: null, height: null, error: null, cues: null, audioTracks: null });
  const vtt = extras.find((x) => x.descriptor.name.endsWith('.vtt'));
  if (vtt) m.append(el('track', { kind: 'captions', label: 'Captions (prepared)', srclang: 'en', default: true, src: URL.createObjectURL(new Blob([vtt.bytes], { type: 'text/vtt' })) }));
  m.src = URL.createObjectURL(new Blob([bytes], { type: s.mime }));
  app.append(m);
  const t0 = performance.now();
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new RenderError('media-timeout', 'no metadata within 15 s')), 15000);
    m.addEventListener('loadedmetadata', () => { clearTimeout(to); resolve(); }, { once: true });
    m.addEventListener('error', () => { clearTimeout(to); reject(new RenderError('media-decode-failed', `MediaError ${m.error?.code}: ${m.error?.message ?? ''} (canPlayType "${M.canPlayType}")`)); }, { once: true });
  });
  M.metadataMs = Math.round(performance.now() - t0);
  M.duration = m.duration; M.width = m.videoWidth ?? null; M.height = m.videoHeight ?? null;
  M.audioTracks = m.audioTracks ? m.audioTracks.length : null;
  if (vtt) { await new Promise((r) => setTimeout(r, 300)); M.cues = m.textTracks[0]?.cues?.length ?? 0; }
  publish();
  window.__media = {
    async seek(t) {
      const t1 = performance.now();
      m.currentTime = t;
      await new Promise((r, j) => { const to = setTimeout(() => j(new Error('seek timeout')), 8000); m.addEventListener('seeked', () => { clearTimeout(to); r(); }, { once: true }); });
      if (video) await Promise.race([new Promise((r) => m.requestVideoFrameCallback?.(() => r())), new Promise((r) => setTimeout(r, 400))]);
      let rgb = null;
      if (video) { const cv = document.createElement('canvas'); cv.width = m.videoWidth; cv.height = m.videoHeight; const g = cv.getContext('2d'); g.drawImage(m, 0, 0); rgb = [...g.getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data].slice(0, 3); }
      return { t: m.currentTime, ms: Math.round(performance.now() - t1), rgb, seekable: m.seekable.length ? [m.seekable.start(0), m.seekable.end(0)] : null };
    },
    async play(ms) { try { await m.play(); } catch (e) { return { ok: false, error: String(e.message ?? e) }; } const a = m.currentTime; await new Promise((r) => setTimeout(r, ms)); m.pause(); return { ok: true, advanced: m.currentTime - a }; },
  };
  return {
    async navigate(t) {
      if (!t || t.kind === 'file') return okRes('File-level reference: no precise location supplied', { fileLevel: true });
      if (t.kind !== 'media-time') return fail('unsupported-target', `target kind ${t.kind} does not apply to media`, true);
      if (typeof t.seconds !== 'number' || !(t.seconds >= 0) || t.seconds > m.duration) return fail('invalid-target', `time ${t.seconds} s is outside 0-${m.duration.toFixed(2)} s`, true);
      const r = await window.__media.seek(t.seconds);
      return okRes(`${t.seconds.toFixed(2)} s of ${m.duration.toFixed(2)} s`, { seek: r });
    },
  };
}
