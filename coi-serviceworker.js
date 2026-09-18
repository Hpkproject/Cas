/**
 * coi-serviceworker.js
 * -----------------------------------------------------------------------
 * Runs first, before any module script (see index.html). Its only job is
 * to make sure service-worker.js — which stamps the COOP/COEP headers
 * WebContainer needs — is registered and controlling this page, reloading
 * once if it wasn't already. The actual header-injection logic lives in
 * service-worker.js itself (a scope can only have one controlling worker,
 * so it can't live in a second file registered here).
 *
 * A canonical copy of this file is also vendored to
 * casf/CAS/sys/api/3rd-party/coi-serviceworker.js alongside webcontainer.js
 * and jszip.js for version-pinning, but registration always uses this
 * shell-shipped copy: a FileSystemFileHandle inside casf has no URL a
 * browser can register a service worker from.
 * -----------------------------------------------------------------------
 */
(function () {
  if (!("serviceWorker" in navigator)) return;
  if (window.crossOriginIsolated) return; // already isolated — nothing to do

  navigator.serviceWorker
    .register("./service-worker.js")
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      if (navigator.serviceWorker.controller && !window.crossOriginIsolated) {
        window.location.reload();
      }
      // If there's no controller yet, this is the very first load of this
      // origin — the worker will control (and headers will apply) starting
      // with the *next* navigation, which app.js's own registration call
      // and normal use will trigger naturally.
    })
    .catch((err) => console.error("[CAS] coi-serviceworker bootstrap failed:", err));
})();
