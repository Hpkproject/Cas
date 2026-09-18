/**
 * app.js
 * -----------------------------------------------------------------------
 * CAS entry point. Wires together first-run setup, PWA file-handler
 * launches (.hpk double-click), manual/drag-and-drop installs, and the
 * launcher UI.
 *
 * Launch handling is deliberately front-loaded: `captureLaunches()` runs
 * before anything that awaits, because launch params are handed to this
 * document once and are lost on navigation. Everything after that reads
 * the files back out of pending-launch.js's durable stash, so an install
 * survives a first-run detour, a re-permission prompt, or the
 * cross-origin-isolation reload.
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";
import { installHpk } from "./hpk-installer.js";
import { installCasPlugin } from "./plugin-installer.js";
import { mountLauncher } from "./launcher.js";
import { bootAll as bootBackgroundWorkers } from "./bw-manager.js";
import {
  captureLaunches,
  onLaunch,
  readPendingLaunches,
  dropPendingLaunch,
} from "./pending-launch.js";

// Claim window.launchQueue synchronously, before the first await below.
captureLaunches();

/** Set once casf is available and the launcher is on screen. */
let installerReady = false;
let refreshLauncher = async () => {};
let draining = false;

// A launch can land at any time — including on an already-open CAS
// window, which is what "launch_handler: focus-existing" gives us.
onLaunch(() => {
  drainPendingLaunches().catch((err) => console.error("[CAS] install failed:", err));
});

async function main() {
  registerServiceWorker();
  wireManualInstallPaths();
  await boot();
}

/**
 * Renders whichever screen the current storage state allows, then works
 * through anything waiting to be installed.
 */
async function boot() {
  const root = document.getElementById("root");

  let restored = false;
  try {
    restored = await fs.restore();
  } catch (err) {
    // requestPermission() throws when called outside a user gesture,
    // which is exactly the case on a cold file-handler launch.
    console.warn("[CAS] could not restore the casf handle without a gesture:", err);
  }

  if (!restored) {
    installerReady = false;
    await renderStorageGate(root);
    return;
  }

  // CAS *is* the desktop shell for this device, so "start background
  // workers on OS boot" reduces to: start them whenever CAS itself boots.
  // (If CAS is instead running as an installed PWA on top of a host OS,
  // getting this to run automatically at real machine boot additionally
  // needs that OS/browser's own "open at login" toggle enabled for CAS —
  // that's a user/install-time setting, not something this script can
  // flip on its own.)
  bootBackgroundWorkers().catch((err) =>
    console.error("[CAS] background worker boot failed:", err)
  );

  const { refresh } = await mountLauncher(root, { onInstallRequest: openInstallPicker });
  refreshLauncher = refresh;
  installerReady = true;

  await drainPendingLaunches();
}

/**
 * Storage gate: the screen shown when casf isn't usable yet, either
 * because this is a first run or because the browser downgraded the
 * stored handle's permission (which can only be re-granted from a
 * click). If a file is waiting to install, it says so — a double-click
 * that lands here used to look like nothing happened at all.
 */
async function renderStorageGate(root) {
  const [pending, hasStoredRoot] = await Promise.all([
    readPendingLaunches(),
    fs.hasStoredRoot().catch(() => false),
  ]);

  const label = hasStoredRoot ? "Reconnect CAS storage folder" : "Choose CAS storage folder";
  const waiting = pending.length
    ? `<p class="cas-gate__note">${escapeHtml(describeFileList(pending))} ${
        pending.length === 1 ? "is" : "are"
      } waiting to install.</p>`
    : "";

  root.innerHTML = `
    <div class="cas-launcher cas-gate">
      ${waiting}
      <button class="cas-btn cas-btn--filled" id="setup-btn" type="button"></button>
    </div>
  `;

  const button = document.getElementById("setup-btn");
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      // Re-granting an existing handle and picking a new one are
      // different calls; both need this click to be in progress.
      if (hasStoredRoot ? await fs.restore() : Boolean(await fs.setupFirstRun())) {
        await boot(); // continue in this document — no reload, no lost launch
        return;
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        alert(`Could not open the CAS storage folder: ${err.message}`);
      }
    }
    button.disabled = false;
  });
}

/** Registers the shell service worker (caches index.html, stamps COOP/COEP). */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./service-worker.js").catch((err) => {
    console.warn("[CAS] service worker registration failed:", err);
  });
}

/**
 * Installs everything sitting in the launch stash, one file at a time.
 * Entries that need another user gesture (a re-permission prompt on the
 * handle) are left in place and retried after the gate is cleared.
 */
async function drainPendingLaunches() {
  if (!installerReady || draining) return;
  draining = true;
  try {
    for (;;) {
      const [entry] = await readPendingLaunches();
      if (!entry) return;

      const file = await readLaunchedFile(entry);
      if (!file) return; // blocked on a gesture; entry stays stashed

      // Dropped before installing, so a file that always throws can't
      // wedge the queue on every subsequent boot.
      await dropPendingLaunch(entry.id);
      await installFromFile(file);
      await refreshLauncher();
    }
  } finally {
    draining = false;
  }
}

/**
 * Resolves a stashed launch entry to a File, or null if the handle needs
 * permission re-granted from a click (which happens when the entry
 * outlived its original document).
 */
async function readLaunchedFile(entry) {
  const handle = entry.handle;
  try {
    if (typeof handle?.queryPermission === "function") {
      const state = await handle.queryPermission({ mode: "read" });
      if (state !== "granted") {
        showResumeBanner(entry, handle);
        return null;
      }
    }
    return await handle.getFile();
  } catch (err) {
    console.error(`[CAS] could not read launched file "${entry.name}":`, err);
    await dropPendingLaunch(entry.id);
    alert(`Could not read "${entry.name}": ${err.message}`);
    return null;
  }
}

/**
 * Banner offering the click a re-permission prompt needs. Without it a
 * stashed launch would just sit there invisibly.
 */
function showResumeBanner(entry, handle) {
  if (document.getElementById("cas-resume-banner")) return;

  const banner = document.createElement("div");
  banner.id = "cas-resume-banner";
  banner.className = "cas-banner";
  banner.innerHTML = `
    <span class="cas-banner__text"></span>
    <button class="cas-btn cas-btn--filled" type="button">Continue</button>
  `;
  banner.querySelector(".cas-banner__text").textContent = `Install ${entry.name}?`;

  banner.querySelector("button").addEventListener("click", async () => {
    banner.remove();
    try {
      const state = await handle.requestPermission({ mode: "read" });
      if (state !== "granted") {
        await dropPendingLaunch(entry.id);
        return;
      }
    } catch (err) {
      await dropPendingLaunch(entry.id);
      alert(`Could not read "${entry.name}": ${err.message}`);
      return;
    }
    await drainPendingLaunches();
  });

  document.body.appendChild(banner);
}

/**
 * Install paths that don't depend on the File Handling API at all: a
 * hidden file input the launcher's Install button opens, and dropping a
 * package anywhere on the window. These are the only way in on browsers
 * without launchQueue, or before CAS has been installed as a PWA (file
 * associations only exist for an installed app).
 */
function wireManualInstallPaths() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".hpk,.casplugin";
  input.multiple = true;
  input.hidden = true;
  input.id = "hpk-fallback-input";
  input.addEventListener("change", async () => {
    const files = [...(input.files ?? [])];
    input.value = "";
    for (const file of files) {
      await installFromFile(file);
    }
    await refreshLauncher();
  });
  document.body.appendChild(input);

  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    document.body.classList.add("cas-dropping");
  });
  window.addEventListener("dragleave", (event) => {
    if (event.relatedTarget === null) document.body.classList.remove("cas-dropping");
  });
  window.addEventListener("drop", async (event) => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    document.body.classList.remove("cas-dropping");
    for (const file of [...event.dataTransfer.files]) {
      await installFromFile(file);
    }
    await refreshLauncher();
  });
}

function hasFiles(dataTransfer) {
  return [...(dataTransfer?.types ?? [])].includes("Files");
}

/** Opens the manual file picker (wired to the launcher's Install button). */
function openInstallPicker() {
  document.getElementById("hpk-fallback-input")?.click();
}

async function installFromFile(file) {
  if (!installerReady) {
    // Shouldn't be reachable — the picker and drop targets only exist on
    // the launcher — but a clear message beats a stack trace from a
    // filesystem call against a null casf root.
    alert("Choose a CAS storage folder before installing packages.");
    return;
  }
  try {
    if (file.name.endsWith(".hpk")) {
      await installHpk(file);
    } else if (file.name.endsWith(".casplugin")) {
      await installCasPlugin(file);
      await bootBackgroundWorkers(); // start the newly-installed plugin immediately
    } else {
      alert(`"${file.name}" isn't a CAS package. Expected a .hpk or .casplugin file.`);
    }
  } catch (err) {
    console.error(`[CAS] install of "${file.name}" failed:`, err);
    alert(`Install of "${file.name}" failed: ${err.message}`);
  }
}

function describeFileList(entries) {
  const names = entries.map((entry) => entry.name);
  return names.length <= 2 ? names.join(" and ") : `${names.length} packages`;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

main().catch((err) => {
  console.error("[CAS] startup failed:", err);
  const root = document.getElementById("root");
  if (root && !root.childElementCount) {
    root.textContent = `CAS failed to start: ${err.message}`;
  }
});
