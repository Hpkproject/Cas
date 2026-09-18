/**
 * fs-manager.js
 * -----------------------------------------------------------------------
 * Owns the user's chosen storage root ("casf"), persists the directory
 * handle across sessions via IndexedDB, scaffolds the CAS folder tree,
 * and fetches third-party runtime dependencies exactly once.
 * -----------------------------------------------------------------------
 */

const IDB_NAME = "cas-fs-handles";
const IDB_STORE = "handles";
const IDB_KEY = "casf-root";

const REQUIRED_DIRS = [
  ["CAS", "apps"],
  ["CAS", "apps", "assets"],
  ["CAS", "apps", "localstorage"],
  ["CAS", "sys", "api", "3rd-party"],
  ["CAS", "apis"],
  ["CAS", "apis", "plugins"],
  ["CAS", "bws"],
  ["CAS", "bws", "plugins"],
];

// Paths (root-relative, forward-slash joined) that CAS.fs.modify() — the
// API exposed to guest apps — must never write to, no matter what
// filesystem permission an app was granted. Apps may only touch files
// outside CAS's own internal tree. Enforced centrally in perm-host.js.
export const PROTECTED_PREFIXES = ["CAS/apis", "CAS/sys", "CAS/bws"];

// Real download URLs for the runtime dependencies CAS vendors locally.
// NOTE on coi-serviceworker.js: it only enables crossOriginIsolated when
// registered as a real Service Worker *at the CAS shell's own origin*
// (a FileSystemFileHandle inside casf can't be used as a <script src> —
// the platform has no URL for it). This copy is vendored into casf so it
// travels with the rest of CAS's dependencies, but the shell also ships
// its own same-named file next to index.html, since that's the one the
// browser can actually register early in <head>. See index.html.
const DEPENDENCIES = [
  {
    url: "https://unpkg.com/@webcontainer/api@1.5.1/dist/index.js",
    path: ["CAS", "sys", "api", "3rd-party", "webcontainer.js"],
  },
  {
    url: "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js",
    path: ["CAS", "sys", "api", "3rd-party", "jszip.js"],
  },
  {
    url: "https://raw.githubusercontent.com/gzuidhof/coi-serviceworker/master/coi-serviceworker.js",
    path: ["CAS", "sys", "api", "3rd-party", "coi-serviceworker.js"],
  },
];

/** Minimal promise-wrapped IndexedDB helpers (no external deps). */
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Walks/creates a chain of subdirectories under a given root handle.
 */
async function ensureDirPath(rootHandle, segments) {
  let dir = rootHandle;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

/**
 * Resolves a "casf/CAS/apps/foo/bar.png"-style path (array of segments,
 * root-relative) into its parent directory handle + leaf file name.
 */
async function resolvePath(rootHandle, segments, { createDirs = true } = {}) {
  const dirSegments = segments.slice(0, -1);
  const fileName = segments[segments.length - 1];
  const dir = createDirs
    ? await ensureDirPath(rootHandle, dirSegments)
    : await walkExisting(rootHandle, dirSegments);
  return { dir, fileName };
}

async function walkExisting(rootHandle, segments) {
  let dir = rootHandle;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: false });
  }
  return dir;
}

export class FsManager {
  /** @type {FileSystemDirectoryHandle | null} */
  root = null;

  /**
   * Restores a previously-granted directory handle, re-requesting
   * permission if the browser has downgraded it. Returns true if a
   * usable handle was restored, false if first-run setup is required.
   */
  async restore() {
    const handle = await idbGet(IDB_KEY);
    if (!handle) return false;

    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm === "granted") {
      this.root = handle;
      return true;
    }
    // Re-prompt is required by spec; must happen inside a user gesture,
    // so callers should retry `restore()` after a click if this fails.
    const requested = await handle.requestPermission({ mode: "readwrite" });
    if (requested === "granted") {
      this.root = handle;
      return true;
    }
    return false;
  }

  /**
   * True if a casf handle was persisted by a previous session, whether or
   * not it's still usable. Lets callers tell "never set up" (show the
   * folder picker) apart from "set up, but the browser downgraded the
   * permission" (re-request it from a click instead of picking again).
   */
  async hasStoredRoot() {
    return (await idbGet(IDB_KEY)) !== null;
  }

  /**
   * First-run flow: ask the user to pick (or create) the casf root
   * directory, persist the handle, and scaffold the folder tree.
   */
  async setupFirstRun() {
    const handle = await window.showDirectoryPicker({
      id: "cas-storage-root",
      mode: "readwrite",
      startIn: "documents",
    });
    await idbSet(IDB_KEY, handle);
    this.root = handle;
    await this.scaffold();
    await this.ensureDependencies();
    await requestCasNotificationPermission();
    return handle;
  }

  /** Creates the CAS folder tree inside casf if it's missing. */
  async scaffold() {
    for (const segments of REQUIRED_DIRS) {
      await ensureDirPath(this.root, segments);
    }
  }

  /**
   * Downloads webcontainer.js / jszip.js into 3rd-party/ once, skipping
   * files that already exist locally.
   */
  async ensureDependencies(onProgress = () => {}) {
    for (const dep of DEPENDENCIES) {
      const { dir, fileName } = await resolvePath(this.root, dep.path);
      const exists = await fileExists(dir, fileName);
      if (exists) {
        onProgress({ file: fileName, status: "cached" });
        continue;
      }
      onProgress({ file: fileName, status: "downloading" });
      const res = await fetch(dep.url);
      if (!res.ok) {
        throw new Error(`Failed to fetch dependency ${dep.url}: ${res.status}`);
      }
      const blob = await res.blob();
      await writeFile(dir, fileName, blob);
      onProgress({ file: fileName, status: "saved" });
    }
  }

  /** Reads a text file relative to casf root, or null if missing. */
  async readText(segments) {
    try {
      const { dir, fileName } = await resolvePath(this.root, segments, {
        createDirs: false,
      });
      const fileHandle = await dir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (err) {
      if (err.name === "NotFoundError") return null;
      throw err;
    }
  }

  /** Writes text/blob content relative to casf root, creating dirs as needed. */
  async writeFile(segments, data) {
    const { dir, fileName } = await resolvePath(this.root, segments);
    await writeFile(dir, fileName, data);
  }

  /** Returns a directory handle relative to casf root, creating it if needed. */
  async getDir(segments) {
    return ensureDirPath(this.root, segments);
  }
}

async function fileExists(dirHandle, fileName) {
  try {
    await dirHandle.getFileHandle(fileName);
    return true;
  } catch (err) {
    if (err.name === "NotFoundError") return false;
    throw err;
  }
}

async function writeFile(dirHandle, fileName, data) {
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

/**
 * Asks the browser, once, for permission to show notifications from the
 * CAS origin itself. This is separate from any per-app "notifications"
 * permission declared in a manifest: the per-app permission only gates
 * whether CAS.notify() is *callable* from that app; this is what lets
 * CAS actually raise a system notification at all.
 */
export async function requestCasNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

export const fs = new FsManager();
