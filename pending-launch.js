/**
 * pending-launch.js
 * -----------------------------------------------------------------------
 * Owns the File Handling API launch queue for the CAS shell.
 *
 * Launch params (the .hpk/.casplugin file handles produced by
 * double-clicking a file with CAS registered as its handler) are
 * delivered to `window.launchQueue` exactly once, to the document the
 * launch navigated to. Two things can silently swallow them:
 *
 *   1. Never calling setConsumer() on that document (e.g. bailing out
 *      early into a first-run screen).
 *   2. Navigating away before consuming them — including the single
 *      `location.reload()` coi-serviceworker.js performs to pick up
 *      cross-origin isolation.
 *
 * So the consumer is claimed here, synchronously, at module evaluation
 * time, and every handle it receives is immediately persisted to
 * IndexedDB. Whoever is able to run an install picks the handles back up
 * from that stash, on this load or after a reload, and removes them once
 * they're dealt with.
 *
 * Handles live in the same IndexedDB store fs-manager.js uses (same
 * name/version/store, different key) so neither module needs a schema
 * migration to coexist with the other.
 * -----------------------------------------------------------------------
 */

const IDB_NAME = "cas-fs-handles";
const IDB_STORE = "handles";
const IDB_KEY = "pending-launch";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(key) {
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbSet(key, value) {
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

// All reads-then-writes of the stash go through this chain, so two
// launches arriving back to back can't clobber each other's entry.
let writeChain = Promise.resolve();
function serialize(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

/** Appends launch entries to the durable stash. */
function stash(handles) {
  return serialize(async () => {
    const existing = (await idbGet(IDB_KEY)) ?? [];
    const added = handles.map((handle) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      name: handle.name,
      handle,
    }));
    await idbSet(IDB_KEY, [...existing, ...added]);
    return added;
  });
}

/** Returns the stashed launch entries, oldest first. */
export function readPendingLaunches() {
  return serialize(async () => (await idbGet(IDB_KEY)) ?? []);
}

/** Removes one entry from the stash, by id. */
export function dropPendingLaunch(id) {
  return serialize(async () => {
    const existing = (await idbGet(IDB_KEY)) ?? [];
    await idbSet(
      IDB_KEY,
      existing.filter((entry) => entry.id !== id)
    );
  });
}

const listeners = new Set();
let consumerClaimed = false;
let captureSettled = null;
let resolveCaptureSettled = () => {};

/**
 * Claims window.launchQueue. Idempotent, and safe to call from both the
 * module graph (app.js) and the COI bootstrap's dynamic import — they
 * share this module instance, so the queue is only ever consumed once.
 *
 * Must be called before the first `await` of whatever boots the page:
 * params queued for this document are dropped on navigation, not held
 * for the next one.
 */
export function captureLaunches() {
  if (consumerClaimed) return;
  consumerClaimed = true;

  captureSettled = new Promise((resolve) => {
    resolveCaptureSettled = resolve;
  });

  if (!("launchQueue" in window) || typeof window.launchQueue?.setConsumer !== "function") {
    // No File Handling API here (non-Chromium, or CAS isn't installed as
    // a PWA). Nothing will ever arrive; the manual picker and drag-drop
    // in app.js are the only install paths.
    resolveCaptureSettled();
    return;
  }

  window.launchQueue.setConsumer(async (params) => {
    const handles = [...(params?.files ?? [])];
    if (handles.length === 0) {
      resolveCaptureSettled();
      return;
    }
    try {
      const added = await stash(handles);
      for (const listener of listeners) {
        try {
          listener(added);
        } catch (err) {
          console.error("[CAS] launch listener failed:", err);
        }
      }
    } catch (err) {
      console.error("[CAS] failed to record launched file(s):", err);
    } finally {
      resolveCaptureSettled();
    }
  });
}

/** Notifies `listener` whenever new launch entries land in the stash. */
export function onLaunch(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Resolves once any launch params already queued for this document have
 * been written to the durable stash — or after `timeoutMs`, since a
 * document opened normally never receives any and must not hang.
 * coi-serviceworker.js awaits this before reloading.
 */
export function launchCaptureSettled(timeoutMs = 300) {
  captureLaunches();
  return Promise.race([
    captureSettled,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
