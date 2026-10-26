// Synthetic Kit-shaped server and adapter entry; no framework build or provider input.
var manifest = (() => {
  return {
    app_dir: "_app",
    app_path: "_app",
    assets: new Set(["favicon.svg"]),
    client: {
      start: "_app/immutable/entry/start.js",
      app: "_app/immutable/entry/app.js",
      imports: [],
      stylesheets: [],
      fonts: []
    }
  };
})();
function create_server(manifest) {
  return {
    respond(request) {
      const { start, app } = manifest.client;
      return new Response(`<!doctype html><link rel="icon" href="/favicon.svg"><main id="app"></main><script type="module">import { start } from "/${start}"; import * as app from "/${app}"; start(app, document.querySelector("#app"));</script>`, {
        headers: { "content-type": "text/html" }
      });
    }
  };
}
var server = create_server(manifest);
export default { fetch(request) { return server.respond(request); } };
