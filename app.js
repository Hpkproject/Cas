/**
 * app.js
 * -----------------------------------------------------------------------
 * CAS entry point. Wires together first-run setup, PWA file-handler
 * launches (.hpk double-click), and the launcher UI.
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";
import { installHpk } from "./hpk-installer.js";
import { installCasPlugin } from "./plugin-installer.js";
import { mountLauncher } from "./launcher.js";
import { bootAll as bootBackgroundWorkers } from "./bw-manager.js";

async function main() {
  registerServiceWorker();

  const root = document.getElementById("root");
  const restored = await fs.restore();
  if (!restored) {
    renderFirstRunPrompt(root);
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

  const { refresh } = await mountLauncher(root);
  await handleLaunchQueue(refresh);
}

/** First-run screen: a single button to satisfy the user-gesture requirement of showDirectoryPicker(). */
function renderFirstRunPrompt(root) {
  root.innerHTML = `
    <div class="cas-launcher" style="display:flex;align-items:center;justify-content:center;">
      <button class="cas-btn cas-btn--filled" id="setup-btn">Choose CAS storage folder</button>
    </div>
  `;
  document.getElementById("setup-btn").addEventListener("click", async () => {
    await fs.setupFirstRun();
    location.reload();
  });
}

/** Registers the app-shell-only service worker (caches index.html, nothing else). */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./service-worker.js").catch((err) => {
    console.warn("[CAS] service worker registration failed:", err);
  });
}

/**
 * Handles .hpk and .casplugin files opened via the PWA File Handling API
 * (window.launchQueue), e.g. double-clicking one on the desktop with CAS
 * registered as the handler. Falls back to a manual <input> for
 * browsers/environments without launchQueue support.
 */
async function handleLaunchQueue(refresh) {
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (params) => {
      for (const fileHandle of params.files ?? []) {
        const file = await fileHandle.getFile();
        await installFromFile(file);
        await refresh();
      }
    });
  }

  // Manual fallback: a hidden file input the rest of the UI can trigger
  // (e.g. from an "Install app" affordance elsewhere in the launcher).
  const fallbackInput = document.createElement("input");
  fallbackInput.type = "file";
  fallbackInput.accept = ".hpk,.casplugin";
  fallbackInput.hidden = true;
  fallbackInput.id = "hpk-fallback-input";
  fallbackInput.addEventListener("change", async () => {
    const file = fallbackInput.files?.[0];
    if (!file) return;
    await installFromFile(file);
    await refresh();
    fallbackInput.value = "";
  });
  document.body.appendChild(fallbackInput);
}

async function installFromFile(file) {
  try {
    if (file.name.endsWith(".hpk")) {
      await installHpk(file);
    } else if (file.name.endsWith(".casplugin")) {
      await installCasPlugin(file);
      await bootBackgroundWorkers(); // start the newly-installed plugin immediately
    }
  } catch (err) {
    alert(`Install failed: ${err.message}`);
  }
}

main();
