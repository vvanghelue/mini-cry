// VR detection: a headset's own browser (Meta Quest Browser, Pico, Wolvic...) plays in VR; ?vr=1 /
// ?vr=0 force it. A desktop browser with a PC headset (Quest Link, SteamVR) gets a "Play in VR"
// button that reloads the page in VR mode (offerVR). ?xremu=1 installs IWER, Meta's WebXR runtime
// written in JS, emulating a Quest 3 (desktop debugging, headless tests: window.__xrDevice drives
// the headset and the controllers).

/** The page plays in VR: forced by ?vr=, else a headset browser. */
export function isVRBrowser(params) {
  const p = params.get('vr');
  if (p !== null) return p !== '0';
  return /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent);
}

/** WebXR can start an immersive VR session here (a headset is connected). */
export async function xrSupported() {
  try { return !!(await navigator.xr?.isSessionSupported('immersive-vr')); } catch { return false; }
}

/** Desktop with a headset: a button on the main menu that reloads the page in VR mode. */
export async function offerVR(params) {
  if (params.get('vr') === '0' || !(await xrSupported())) return;
  const b = document.createElement('button');
  b.className = 'vr-offer';
  b.textContent = 'Play in VR';
  b.onclick = () => { const q = new URLSearchParams(location.search); q.set('vr', '1'); location.search = q.toString(); };
  document.body.appendChild(b);
}

/** ?xremu=1: an emulated Meta Quest 3 (IWER) in place of navigator.xr. */
export async function installXREmulator() {
  const { XRDevice, metaQuest3 } = await import('iwer');
  const device = new XRDevice(metaQuest3);
  // three renders through WebXR projection layers (like on the Quest): IWER's layers polyfill
  // provides them, but IWER then replaces its XRWebGLBinding with its own (depth sensing only):
  // keep the polyfill's
  let binding;
  Object.defineProperty(window, 'XRWebGLBinding', { configurable: true, get: () => binding, set: (v) => { if (!binding?.prototype?.createProjectionLayer) binding = v; } });
  device.installRuntime({ forceInstall: true, polyfillLayers: true }); // (over Chrome's own navigator.xr)
  window.__xrDevice = device;
  return device;
}
