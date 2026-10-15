/**
 * storage-sync.js
 * -----------------------------------------------------------------------
 * Browser-native offline apps share one origin, so each app gets a
 * storage shim that behaves like localStorage while persisting its state
 * through casf/CAS/apps/localstorage/[appname]/key-values.json.
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
 *      host page can persist it back to disk (postMessage to the preview
 *      shell).
 */
export function buildStorageSyncScript(initialKeyValues) {
  return `
<script>
  (function () {
    var state = ${JSON.stringify(initialKeyValues)};

    function ownKeys() {
      return Object.keys(state);
    }

    function getValue(key) {
      key = String(key);
      return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : null;
    }

    function setValue(key, value) {
      state[String(key)] = String(value);
    }

    function removeValue(key) {
      delete state[String(key)];
    }

    function clearValues() {
      ownKeys().forEach(function (key) {
        delete state[key];
      });
    }

    function storageSnapshot() {
      var snapshot = {};
      ownKeys().forEach(function (key) {
        snapshot[key] = state[key];
      });
      return snapshot;
    }

    var shim = {
      get length() {
        return ownKeys().length;
      },
      key: function (index) {
        return ownKeys()[index] ?? null;
      },
      getItem: getValue,
      setItem: setValue,
      removeItem: removeValue,
      clear: clearValues,
    };

    try {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: shim,
      });
    } catch (err) {
      try {
        var storage = window.localStorage;
        Object.defineProperty(storage, "length", {
          configurable: true,
          get: function () {
            return ownKeys().length;
          },
        });
        storage.getItem = getValue;
        storage.setItem = setValue;
        storage.removeItem = removeValue;
        storage.clear = clearValues;
        storage.key = shim.key;
      } catch (patchErr) {
        console.warn("[CAS] localStorage shim could not be installed:", patchErr);
      }
    }

    function reportState() {
      var snapshot = storageSnapshot();
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "cas:localstorage-sync", snapshot: snapshot }, "*");
      }
    }
    window.addEventListener("beforeunload", reportState);
    window.addEventListener("pagehide", reportState);
  })();
</script>`;
}
