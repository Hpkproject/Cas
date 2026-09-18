/**
 * storage-sync.js
 * -----------------------------------------------------------------------
 * Because each offline app runs in a fresh WebContainer-served window,
 * the browser gives it a clean localStorage every time. These helpers
 * round-trip that state through casf/CAS/apps/localstorage/[appname]/
 * key-values.json so state survives across launches.
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";

function registryPath(appName) {
  return ["CAS", "apps", "localstorage", appName, "key-values.json"];
}

/** Reads the persisted key-value snapshot for an app, or {} if none exists. */
export async function loadPersistedStorage(appName) {
  const raw = await fs.readText(registryPath(appName));
  return raw ? JSON.parse(raw) : {};
}

/** Writes a full localStorage snapshot back to disk for an app. */
export async function savePersistedStorage(appName, keyValues) {
  await fs.writeFile(registryPath(appName), JSON.stringify(keyValues, null, 2));
}

/**
 * Serializes the browser's `localStorage` object into a plain
 * { [key]: value } object suitable for JSON persistence.
 */
export function snapshotLocalStorage(storage) {
  const snapshot = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    snapshot[key] = storage.getItem(key);
  }
  return snapshot;
}

/**
 * Produces a small bootstrap script, injected into the served page
 * *before* the app's own scripts run, that:
 *   1. hydrates localStorage from the values captured at container boot,
 *   2. captures + reports the final localStorage state on unload so the
 *      host page can persist it back to disk (postMessage, since the
 *      WebContainer page is a separate origin/window).
 */
export function buildStorageSyncScript(initialKeyValues) {
  return `
<script>
  (function () {
    var initial = ${JSON.stringify(initialKeyValues)};
    try {
      Object.keys(initial).forEach(function (k) {
        window.localStorage.setItem(k, initial[k]);
      });
    } catch (e) {
      console.warn("[CAS] localStorage hydration failed:", e);
    }

    function reportState() {
      var snapshot = {};
      for (var i = 0; i < window.localStorage.length; i++) {
        var key = window.localStorage.key(i);
        snapshot[key] = window.localStorage.getItem(key);
      }
      window.parent.postMessage({ type: "cas:localstorage-sync", snapshot: snapshot }, "*");
    }
    window.addEventListener("beforeunload", reportState);
    window.addEventListener("pagehide", reportState);
  })();
</script>`;
}
