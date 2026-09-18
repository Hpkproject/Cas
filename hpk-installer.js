/**
 * hpk-installer.js
 * -----------------------------------------------------------------------
 * Parses .hpk archives (ZIP-with-a-different-extension) using the
 * locally-vendored jszip.js, shows a Material 3 install confirmation
 * dialog, and routes installation to disk under casf/CAS/apps/.
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";
import { PERMISSIONS, declaredPermissions, showPermissionDialog } from "./permissions.js";
import { installAppBackgroundWorker } from "./bw-manager.js";

/** Accepts the manifest key in whatever casing the .hpk author used. */
function backgroundWorkerFileName(manifest) {
  return manifest.Background_Worker ?? manifest.background_worker ?? manifest.backgroundWorker ?? null;
}

let JSZipCtor = null;

/** Lazily loads the locally-vendored JSZip build as a real ES module. */
async function loadJSZip() {
  if (JSZipCtor) return JSZipCtor;
  const text = await fs.readText(["CAS", "sys", "api", "3rd-party", "jszip.js"]);
  if (!text) {
    throw new Error("jszip.js is missing from 3rd-party/ — run FsManager.ensureDependencies() first.");
  }
  // jszip.min.js is a UMD bundle; executing it in a scoped Function
  // attaches `JSZip` to the returned scope without touching window.
  const factory = new Function(`${text}\nreturn JSZip;`);
  JSZipCtor = factory();
  return JSZipCtor;
}

/**
 * Reads a .hpk File, extracts manifest.json, and returns a parsed
 * manifest plus the live JSZip instance for later extraction.
 */
export async function parseHpk(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);

  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) {
    throw new Error("Invalid .hpk: manifest.json not found at archive root.");
  }
  const manifestRaw = await manifestEntry.async("string");
  const manifest = JSON.parse(manifestRaw);

  for (const field of ["name", "icon", "desc", "type"]) {
    if (!(field in manifest)) {
      throw new Error(`Invalid .hpk: manifest.json missing required field "${field}".`);
    }
  }
  if (!["offline", "online"].includes(manifest.type)) {
    throw new Error(`Invalid .hpk: manifest.type must be "offline" or "online", got "${manifest.type}".`);
  }

  return { manifest, zip };
}

/**
 * Renders the M3 install confirmation modal and resolves true/false
 * depending on whether the user confirms.
 */
export function showInstallDialog({ name, desc, icon }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "cas-dialog";
    dialog.innerHTML = `
      <div class="cas-dialog__body">
        <img class="cas-dialog__icon" alt="" />
        <h2 class="cas-dialog__title"></h2>
        <p class="cas-dialog__desc"></p>
      </div>
      <div class="cas-dialog__actions">
        <button class="cas-btn cas-btn--text" data-action="cancel">Cancel</button>
        <button class="cas-btn cas-btn--filled" data-action="install">Install</button>
      </div>
    `;
    dialog.querySelector(".cas-dialog__icon").src = icon;
    dialog.querySelector(".cas-dialog__title").textContent = name;
    dialog.querySelector(".cas-dialog__desc").textContent = desc;

    dialog.addEventListener("click", (e) => {
      const action = e.target?.dataset?.action;
      if (!action) return;
      dialog.close();
      dialog.remove();
      resolve(action === "install");
    });

    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/**
 * Full install flow for one .hpk File: parse -> confirm -> write to disk.
 * Returns the installed app's registry entry, or null if the user
 * cancelled or the manifest declared an "online" app (nothing to write).
 */
export async function installHpk(file) {
  const { manifest, zip } = await parseHpk(file);
  const iconEntry = zip.file(manifest.icon);
  const iconBlob = iconEntry ? await iconEntry.async("blob") : null;
  const iconObjectUrl = iconBlob ? URL.createObjectURL(iconBlob) : "";

  const confirmed = await showInstallDialog({
    name: manifest.name,
    desc: manifest.desc,
    icon: iconObjectUrl,
  });
  if (!confirmed) {
    if (iconObjectUrl) URL.revokeObjectURL(iconObjectUrl);
    return null;
  }

  // Collect requested permissions: whatever the manifest declares, plus an
  // implicit "background_workers" request if it names a background worker
  // script — declaring one without the permission to run it is meaningless.
  const requested = new Set(declaredPermissions(manifest));
  const bwFile = backgroundWorkerFileName(manifest);
  if (bwFile) requested.add(PERMISSIONS.BACKGROUND_WORKERS);

  const granted = await showPermissionDialog({
    name: manifest.name,
    icon: iconObjectUrl,
    requested: [...requested],
  });
  if (iconObjectUrl) URL.revokeObjectURL(iconObjectUrl);

  if (manifest.type === "online") {
    return appendRegistryEntry({
      name: manifest.name,
      desc: manifest.desc,
      type: "online",
      url: manifest.url,
      permissions: [...granted],
    });
  }

  return installOfflineApp(manifest, zip, iconBlob, granted, bwFile);
}

/**
 * Writes an offline app's entry point, icon, and packaged assets to
 * casf/CAS/apps/, copies its background worker (if any + granted) to the
 * protected casf/CAS/bws/ tree, then appends it to the app registry.
 */
async function installOfflineApp(manifest, zip, iconBlob, granted, bwFile) {
  const appName = sanitizeAppName(manifest.name);

  const entryPointEntry = zip.file("index.html");
  if (!entryPointEntry) {
    throw new Error(`Invalid .hpk: offline app "${manifest.name}" is missing index.html.`);
  }
  const entryPointBlob = await entryPointEntry.async("blob");
  await fs.writeFile(["CAS", "apps", appName, "index.html"], entryPointBlob);

  if (iconBlob) {
    await fs.writeFile(["CAS", "apps", appName, "icon.png"], iconBlob);
  }

  await packageAssets(zip, appName);

  let hasBackgroundWorker = false;
  if (bwFile && granted.has(PERMISSIONS.BACKGROUND_WORKERS)) {
    const bwEntry = zip.file(bwFile);
    if (!bwEntry) {
      throw new Error(`Invalid .hpk: declared background worker "${bwFile}" not found in archive.`);
    }
    const bwBlob = await bwEntry.async("blob");
    // Copied into casf/CAS/bws/, not the app's own install folder — that
    // tree is protected and apps can't touch it via CAS.fs.modify either.
    await installAppBackgroundWorker(appName, bwBlob);
    hasBackgroundWorker = true;
  }

  return appendRegistryEntry({
    name: manifest.name,
    desc: manifest.desc,
    type: "offline",
    appId: appName,
    iconPath: `CAS/apps/${appName}/icon.png`,
    permissions: [...granted],
    backgroundWorker: hasBackgroundWorker,
  });
}

/**
 * Re-zips the .hpk's assets/ subtree (recursively) into a single
 * assets.zip, preserving nested paths, and saves it to
 * casf/CAS/apps/assets/[appname]/assets.zip.
 */
async function packageAssets(zip, appName) {
  const JSZip = await loadJSZip();
  const assetsZip = new JSZip();

  const assetEntries = zip.folder("assets") ? zip.filter((path) => path.startsWith("assets/")) : [];

  if (assetEntries.length === 0) {
    return; // App shipped no assets/ directory — nothing to package.
  }

  for (const entry of assetEntries) {
    if (entry.dir) continue;
    const relativePath = entry.name.slice("assets/".length); // preserve nesting
    const content = await entry.async("blob");
    assetsZip.file(relativePath, content);
  }

  const packagedBlob = await assetsZip.generateAsync({ type: "blob" });
  await fs.writeFile(
    ["CAS", "apps", "assets", appName, "assets.zip"],
    packagedBlob
  );
}

/** Appends an app entry to casf/CAS/apps/index.json, replacing any prior entry with the same appId/name. */
async function appendRegistryEntry(entry) {
  const raw = await fs.readText(["CAS", "apps", "index.json"]);
  const registry = raw ? JSON.parse(raw) : [];

  const key = entry.appId ?? entry.name;
  const filtered = registry.filter((e) => (e.appId ?? e.name) !== key);
  filtered.push(entry);

  await fs.writeFile(
    ["CAS", "apps", "index.json"],
    JSON.stringify(filtered, null, 2)
  );
  return entry;
}

function sanitizeAppName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}
