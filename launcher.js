/**
 * launcher.js
 * -----------------------------------------------------------------------
 * Renders the CAS home screen: reads the app registry, draws a filterable
 * icon grid, and dispatches launches to the right runtime (new tab for
 * "online" apps, WebContainer runtime for "offline" apps).
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";
import { launchOfflineApp } from "./webcontainer-runtime.js";

/**
 * Mounts the launcher into `container` and returns a `refresh()` you can
 * call after installing a new app.
 */
export async function mountLauncher(container) {
  container.innerHTML = `
    <div class="cas-launcher">
      <input class="cas-search" type="search" placeholder="Search apps" aria-label="Search apps" />
      <div class="cas-grid" role="list"></div>
      <p class="cas-empty" hidden>No apps installed yet. Open a .hpk file to install one.</p>
    </div>
  `;

  const searchInput = container.querySelector(".cas-search");
  const grid = container.querySelector(".cas-grid");
  const emptyState = container.querySelector(".cas-empty");

  let apps = [];

  async function refresh() {
    apps = await loadRegistry();
    renderGrid(apps, searchInput.value);
  }

  function renderGrid(list, query) {
    const q = query.trim().toLowerCase();
    const filtered = q ? list.filter((a) => a.name.toLowerCase().includes(q)) : list;

    grid.innerHTML = "";
    emptyState.hidden = list.length !== 0;

    for (const app of filtered) {
      const btn = document.createElement("button");
      btn.className = "cas-app";
      btn.setAttribute("role", "listitem");
      btn.dataset.appKey = app.appId ?? app.name;

      const icon = document.createElement("img");
      icon.className = "cas-app__icon";
      icon.alt = "";
      icon.src = ""; // filled in async below

      const label = document.createElement("span");
      label.className = "cas-app__name";
      label.textContent = app.name;

      btn.append(icon, label);
      btn.addEventListener("click", () => launchApp(app));
      grid.appendChild(btn);

      resolveIconSrc(app).then((src) => {
        if (src) icon.src = src;
      });
    }
  }

  searchInput.addEventListener("input", () => renderGrid(apps, searchInput.value));

  await refresh();
  return { refresh };
}

/** Reads and parses casf/CAS/apps/index.json, defaulting to an empty list. */
async function loadRegistry() {
  const raw = await fs.readText(["CAS", "apps", "index.json"]);
  return raw ? JSON.parse(raw) : [];
}

/** Loads a locally-stored icon.png as an object URL for offline apps. */
async function resolveIconSrc(app) {
  if (app.type !== "offline") return null;
  try {
    const dir = await fs.getDir(["CAS", "apps", app.appId]);
    const fileHandle = await dir.getFileHandle("icon.png");
    const file = await fileHandle.getFile();
    return URL.createObjectURL(file);
  } catch {
    return null; // App has no icon — grid shows the empty placeholder box.
  }
}

/** Routes a click on a grid item to the correct runtime. */
async function launchApp(app) {
  if (app.type === "online") {
    window.open(app.url, "_blank", "noopener,noreferrer");
    return;
  }
  await launchOfflineApp(app);
}
