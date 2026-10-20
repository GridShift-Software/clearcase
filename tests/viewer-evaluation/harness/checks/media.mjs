import { accepts, keyboardRoundTrip, layout, opens, rejects, sleep } from './common.mjs';

const F = 'media';
const C = 'native audio/video (Chrome)';
const near = (a, b, tol = 60) => a && b.every((v, i) => Math.abs(a[i] - v) <= tol);
const COLORS = [[1, [255, 0, 0]], [3, [0, 255, 0]], [5, [0, 0, 255]]];

async function videoChecks(c, id, comp) {
  const r = await c.open(id, { kind: 'file' }, { extra: id === 'media/mp4-h264-aac-faststart.mp4' ? ['media/mp4-h264-aac-faststart.captions.vtt'] : [] });
  const st = (await c.rstate())?.media;
  c.record(F, id, comp, 'decodes (metadata, dimensions, duration)', r.type === 'ready' && st.width === 320 && Math.abs(st.duration - 6) < 0.2, 'ready; 320 px wide; duration 6 s ±0.2', { type: r.type, code: r.code, message: r.message, canPlayType: st?.canPlayType, duration: st?.duration });
  if (r.type !== 'ready') return false;
  const seeks = [];
  for (const [t, rgb] of COLORS) seeks.push({ t, want: rgb, got: (await c.navigate({ kind: 'media-time', seconds: t })).resolution?.seek?.rgb });
  c.record(F, id, comp, 'seek to start/middle/end shows the frame for that time', seeks.every((s) => near(s.got, s.want)), 'centre pixel red at 1 s, green at 3 s, blue at 5 s (long-GOP: one keyframe)', seeks);
  return true;
}

export default async function media(c, { full }) {
  let id = 'media/mp4-h264-aac-faststart.mp4';
  await opens(c, F, id, C);
  await layout(c, F, id, C);
  if (!full) { await accepts(c, F, id, C, { kind: 'media-time', seconds: 3 }, '3.00 s'); return; }
  await videoChecks(c, id, C);
  const st = (await c.rstate()).media;
  c.record(F, id, `${C} + WebVTT companion`, 'captions companion loads as a text track', st.cues === 3, 'textTracks[0].cues.length === 3', st.cues);
  const play = await c.inFrame(() => window.__media.play(600));
  c.record(F, id, C, 'plays (currentTime advances)', play.ok && play.advanced > 0.2, 'currentTime advances > 0.2 s in 600 ms', play);
  await rejects(c, F, id, C, [[{ kind: 'media-time', seconds: 7 }, 'invalid-target'], [{ kind: 'media-time', seconds: -1 }, 'invalid-target']], async () => Math.round((await c.inFrame(() => document.getElementById('player').currentTime)) * 10));
  await c.frame().focus('#player');
  await keyboardRoundTrip(c, F, id, C);

  for (const fid of ['media/mp4-h264-aac-moov-end.mp4', 'media/webm-vp9-opus.webm', 'media/mov-h264-aac.mov', 'media/mkv-h264-aac.mkv']) await videoChecks(c, fid, C);
  id = 'media/mp4-two-audio-tracks.mp4';
  await videoChecks(c, id, C);
  const tracks = (await c.rstate()).media.audioTracks;
  c.record(F, id, C, 'second audio track selectable in the reader', tracks === 2, 'HTMLMediaElement.audioTracks.length === 2 (null = API not exposed)', tracks);
  for (const fid of ['media/mp3-sine.mp3', 'media/wav-pcm.wav', 'media/ogg-opus.ogg', 'media/m4a-aac.m4a']) {
    const r = await c.open(fid);
    const m = (await c.rstate())?.media;
    const s = r.type === 'ready' ? (await c.navigate({ kind: 'media-time', seconds: 4 })).resolution : null;
    c.record(F, fid, C, 'audio decodes and seeks', r.type === 'ready' && Math.abs(m.duration - 6) < 0.3 && s?.ok && Math.abs(s.seek.t - 4) < 0.3, 'duration 6 s ±0.3; seek to 4 s lands within 0.3 s', { type: r.type, code: r.code, duration: m?.duration, seek: s?.seek });
  }
  id = 'media/mp3-one-hour.mp3';
  const r1 = await c.open(id);
  const s1 = r1.type === 'ready' ? (await c.navigate({ kind: 'media-time', seconds: 3540 })).resolution : null;
  c.record(F, id, C, 'one-hour audio: seek to 59:00', r1.type === 'ready' && s1?.ok && Math.abs(s1.seek.t - 3540) < 2, 'seek lands within 2 s of 3540 s', { readyMs: r1.ms, seek: s1?.seek });
  id = 'media/avi-mpeg4-mp3.avi';
  const ra = await c.open(id);
  c.record(F, id, C, 'AVI (MPEG-4 Part 2) not natively playable: explicit failure', ra.type === 'error', 'renderer error (decode failed or unsupported)', { code: ra.code, message: ra.message });
  await videoChecks(c, 'media/avi-mpeg4-mp3.rendition-v1.mp4', 'prepared rendition (ffmpeg H.264/AAC) + native video');
  id = 'media/mp4-truncated.mp4';
  const rt = await c.open(id);
  const sT = rt.type === 'ready' ? (await c.navigate({ kind: 'media-time', seconds: 5 })).resolution : null;
  c.record(F, id, C, 'truncated MP4: failure is explicit (no silent partial playback)', rt.type === 'error' || (sT && !sT.ok), 'error on open, or the seek past the cut fails', { open: rt.type, code: rt.code, seek: sT });
  c.record(F, id, 'candidate import', 'truncated MP4 held at import (box structure runs past the end)', c.descriptors.get(id).holds.some((h) => h.code === 'media-damaged') && ['media/mp4-h264-aac-faststart.mp4', 'media/mp4-h264-aac-moov-end.mp4', 'media/mov-h264-aac.mov', 'media/m4a-aac.m4a'].every((x) => !c.descriptors.get(x).holds.length), "hold 'media-damaged'; the intact MP4/MOV/M4A fixtures have no holds", c.descriptors.get(id).holds);
}
