/**
 * coi-serviceworker.js
 * -----------------------------------------------------------------------
 * Runs first, before any module script (see index.html). Its only job is
 * to make sure service-worker.js — which stamps the COOP/COEP headers
 * the browser-native preview shell uses — is registered and controlling
 * this page, reloading once if it wasn't already. The actual
 * header-injection logic lives in service-worker.js itself (a scope can
 * only have one controlling worker, so it can't live in a second file
 * registered here).
 *
 * Two rules this bootstrap has to respect:
 *
 *   - Reload AT MOST once per tab. If isolation still doesn't take (a
 *     misconfigured worker, a host that strips the headers), reloading
 *     again just yields an endless loop in which nothing the page does —
 *     installing a double-clicked .hpk included — ever gets to finish.
 *   - Don't reload out from under a pending File Handling API launch.
 *     Launch params belong to this document and are gone after a
 *     navigation, so pending-launch.js is given the chance to claim and
 *     persist them first.
 *
 * A canonical copy of this file is also vendored to
 * casf/CAS/sys/api/3rd-party/coi-serviceworker.js alongside webcontainer.js
 * and jszip.js for version-pinning, but registration always uses this
 * shell-shipped copy: a FileSystemFileHandle inside casf has no URL a
 * browser can register a service worker from.
 * -----------------------------------------------------------------------
 */
(function () {
  const RELOAD_FLAG = "cas-coi-reloaded";

  if (!("serviceWorker" in navigator)) return;
  if (window.crossOriginIsolated) return; // already isolated — nothing to do

  navigator.serviceWorker
    .register(new URL("./service-worker.js?v=2", window.location.href), {
      scope: new URL("./", window.location.href).pathname,
      updateViaCache: "none",
    })
    .then(async (registration) => {
      await navigator.serviceWorker.ready;

      // `ready` only guarantees that a worker is active. On the first load
      // it may still not control this document, so wait for clients.claim()
      // before reloading or the navigation can miss the COOP/COEP headers.
      if (!navigator.serviceWorker.controller && registration.active) {
        await new Promise((resolve) => {
          const onControllerChange = () => {
            navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
            resolve();
          };

          navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
          // clients.claim() may have completed between the first check and
          // listener registration, so close that small race explicitly.
          if (navigator.serviceWorker.controller) onControllerChange();
        });
      }
    })
    .then(async () => {
      if (window.crossOriginIsolated) return;

      if (sessionStorage.getItem(RELOAD_FLAG)) {
        console.warn(
          "[CAS] still not cross-origin isolated after a reload — not reloading again. " +
            "Offline app previews may be affected, but installs and the launcher still work."
        );
        return;
      }

      // Hand any double-clicked .hpk/.casplugin to the durable stash
      // before the navigation throws this document's launch params away.
      try {
        const { launchCaptureSettled } = await import("./pending-launch.js");
        await launchCaptureSettled();
      } catch (err) {
        console.warn("[CAS] could not pre-capture launch params before reload:", err);
      }

      sessionStorage.setItem(RELOAD_FLAG, "1");
      window.location.reload();
    })
    .catch((err) => console.error("[CAS] coi-serviceworker bootstrap failed:", err));
})();
