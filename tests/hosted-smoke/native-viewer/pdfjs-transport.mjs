// Synthetic URL transport over the real pinned PDF.js bundle that scripts/hosted-pdf-assets.ts derived from the
// locked dependency. It pauses real RenderTasks via their supported onContinue hook; the adapter is unchanged.
export const controls = { bytes: null, pauseNext: false, paused: null, tasks: [], loads: [], holdPage: null };
export function withSyntheticTransport(core) {
  function getDocument(options) {
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
  return { ...core, getDocument };
}
