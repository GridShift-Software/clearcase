// Real pinned PDF.js and native canvas; replaces only URL transport with synthetic bytes and
// pauses real RenderTasks via their supported onContinue hook. The adapter itself is unchanged.
import * as core from 'pdfjs-dist/build/pdf.mjs';
export * from 'pdfjs-dist/build/pdf.mjs';
export const controls = { bytes: null, pauseNext: false, paused: null, tasks: [], loads: [], holdPage: null };
export function getDocument(options) {
  // The static adapter normally points to its sibling worker; use the installed pinned worker here.
  core.GlobalWorkerOptions.workerSrc = new URL('../../../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
  const task = core.getDocument({ ...options, url: undefined, data: controls.bytes.slice(), standardFontDataUrl: undefined, cMapUrl: undefined, iccUrl: undefined });
  const wrapped = { destroy: () => task.destroy(), promise: task.promise.then((doc) => ({
    numPages: doc.numPages,
    async getPage(n) {
      if (controls.holdPage) await controls.holdPage(n);
      const page = await doc.getPage(n);
      return { getViewport: (o) => page.getViewport(o), render: (o) => {
        const render = page.render(o); controls.tasks.push(render);
        if (controls.pauseNext) { controls.pauseNext = false; render.onContinue = (next) => { controls.paused = next; }; }
        return render;
      } };
    },
  })) };
  controls.loads.push(wrapped);
  return wrapped;
}
