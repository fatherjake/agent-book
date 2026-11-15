'use strict';
// Preloaded by /opt/frugal/task/pw-node: default Chromium launch flags that work under the
// sandbox hardening (read-only root, cap-drop ALL, small /dev/shm). Loaded lazily: scripts that
// never require playwright pay nothing.
const Module = require('module');
const EXTRA_ARGS = ['--disable-dev-shm-usage', '--disable-gpu', '--no-first-run'];
let patched = false;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const mod = origLoad.apply(this, arguments);
  if (!patched && (request === 'playwright' || request === 'playwright-core') && mod && mod.chromium) {
    patched = true;
    const c = mod.chromium;
    const withArgs = (o) => ({ ...(o || {}), args: [...EXTRA_ARGS, ...((o && o.args) || [])] });
    const launch = c.launch.bind(c);
    const persistent = c.launchPersistentContext.bind(c);
    c.launch = (o) => launch(withArgs(o));
    c.launchPersistentContext = (dir, o) => persistent(dir, withArgs(o));
  }
  return mod;
};
