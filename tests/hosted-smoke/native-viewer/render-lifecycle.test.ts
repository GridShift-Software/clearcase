// Real PDF.js RenderTasks, paused mid-render, not a browser or byte-route acceptance check.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
// @ts-expect-error Test-only transport controls for the pinned PDF.js module.
import { controls } from './pdfjs-transport.mjs';
function pdf() {
  const ops = '0 0 20 20 re f\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    ...[1, 2].map(() => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 5 0 R >>'),
    `<< /Length ${ops.length} >>\nstream\n${ops}endstream`];
  let text = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const start = text.length;
  text += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}
let reader: any;
beforeAll(async () => {
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D, window: Object.assign(new EventTarget(), {
    requestAnimationFrame: (run: FrameRequestCallback) => setTimeout(() => run(performance.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  }) });
  // @ts-expect-error Static browser adapter is intentionally not a Worker/TypeScript module.
  await import('../../../src/lib/viewer/hosted/static/pdf-reader.mjs');
});
beforeEach(() => { Object.assign(controls, { bytes: pdf(), pauseNext: false, paused: null, tasks: [], loads: [], holdPage: null }); });
afterEach(async () => { reader?.destroy(); reader = null; await Promise.allSettled(controls.loads.map((t: any) => t.destroy())); });
const open = (canvas = createCanvas(100, 100), signal?: AbortSignal) => (window as any).clearcasePdfReader.open({ src: '/synthetic.pdf', canvas, signal });

it('cancels and awaits a running RenderTask before rapid page/zoom canvas reuse', async () => {
  const canvas = createCanvas(100, 100); reader = await open(canvas); controls.pauseNext = true;
  const first = reader.draw(1, 1); first.catch(() => {});
  await vi.waitFor(() => expect(controls.paused).toBeTypeOf('function'));
  const second = reader.draw(2, 1.5), third = reader.draw(1, 2); second.catch(() => {}); third.catch(() => {});
  await expect(Promise.all([first, second, third])).resolves.toEqual([undefined, undefined, undefined]);
  expect(canvas.width).toBe(200); expect(canvas.height).toBe(200);
  expect(controls.tasks).toHaveLength(2); // Only the first and latest request actually render.
});

it('destroy cancels an in-flight render and prevents later draw or canvas mutation', async () => {
  const canvas = createCanvas(100, 100); reader = await open(canvas); controls.pauseNext = true;
  const first = reader.draw(1, 1); first.catch(() => {});
  await vi.waitFor(() => expect(controls.paused).toBeTypeOf('function'));
  reader.destroy(); await expect(first).resolves.toBeUndefined();
  await reader.draw(2, 3); expect(controls.tasks).toHaveLength(1); expect(canvas.width).toBe(100);
});

it('drops a delayed old getPage completion and draws only the latest zoom', async () => {
  const canvas = createCanvas(100, 100); reader = await open(canvas);
  let release!: () => void, entered = false;
  const held = new Promise<void>((r) => { release = r; });
  controls.holdPage = async () => { if (!entered) { entered = true; await held; } };
  const first = reader.draw(1, 1); first.catch(() => {});
  await vi.waitFor(() => expect(entered).toBe(true));
  const second = reader.draw(2, 2); second.catch(() => {}); release();
  await Promise.all([first, second]); expect(canvas.width).toBe(200); expect(controls.tasks).toHaveLength(1);
});

it('abort destroys the loading task even before open settles', async () => {
  const controller = new AbortController(), opening = open(createCanvas(100, 100), controller.signal); opening.catch(() => {});
  const destroy = vi.spyOn(controls.loads[0], 'destroy'); controller.abort();
  await Promise.allSettled([opening]); expect(destroy).toHaveBeenCalledOnce();
});
