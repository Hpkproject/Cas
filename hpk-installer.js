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

// Basic zip-bomb / disk-fill guards. Generous enough for a real app
// (icons, an index.html, a modest assets/ tree) while keeping a single
// malicious .hpk from being able to exhaust storage or hang JSZip.
const MAX_HPK_BYTES = 200 * 1024 * 1024;
const MAX_ASSET_ENTRIES = 20000;
const MAX_ASSET_ENTRY_BYTES = 50 * 1024 * 1024;

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
  if (file.size > MAX_HPK_BYTES) {
    throw new Error(`.hpk is too large (${(file.size / 1024 / 1024).toFixed(1)}MB, limit ${MAX_HPK_BYTES / 1024 / 1024}MB).`);
  }

  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);

  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) {
    throw new Error("Invalid .hpk: manifest.json not found at archive root.");
  }
  const manifestRaw = await manifestEntry.async("string");
  const manifest = JSON.parse(manifestRaw);

  for (const field of ["name", "icon", "desc", "type"]) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      throw new Error(`Invalid .hpk: manifest.json field "${field}" must be a non-empty string.`);
    }
  }
  if (!["offline", "online"].includes(manifest.type)) {
    throw new Error(`Invalid .hpk: manifest.type must be "offline" or "online", got "${manifest.type}".`);
  }
  if (manifest.type === "online" && typeof manifest.url !== "string") {
    throw new Error('Invalid .hpk: an "online" app must set manifest.url.');
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
 *
 * `opts.isUpdate` (used by update-checker.js, after it has already
 * verified the new .hpk's signature against the app's pinned public key)
 * skips the base install-confirmation dialog — the user already
 * consented to being an app of this identity — and only prompts for
 * permissions beyond what `opts.previousPermissions` already covers, so
 * an update can't silently expand what an app can do.
 */
export async function installHpk(file, opts = {}) {
  const { isUpdate = false, previousPermissions = new Set() } = opts;
  const { manifest, zip } = await parseHpk(file);
  const iconEntry = zip.file(manifest.icon);
  const iconBlob = iconEntry ? await iconEntry.async("blob") : null;
  const iconObjectUrl = iconBlob ? URL.createObjectURL(iconBlob) : "";

  if (!isUpdate) {
    const confirmed = await showInstallDialog({
      name: manifest.name,
      desc: manifest.desc,
      icon: iconObjectUrl,
    });
    if (!confirmed) {
      if (iconObjectUrl) URL.revokeObjectURL(iconObjectUrl);
      return null;
    }
  }

  // Collect requested permissions: whatever the manifest declares, plus an
  // implicit "background_workers" request if it names a background worker
  // script — declaring one without the permission to run it is meaningless.
  const requested = new Set(declaredPermissions(manifest));
  const bwFile = backgroundWorkerFileName(manifest);
  if (bwFile) requested.add(PERMISSIONS.BACKGROUND_WORKERS);

  // On an update, permissions already granted to the previous version
  // carry forward silently; only genuinely new asks get a dialog. This
  // is what stops a malicious update from quietly requesting more than
  // the version the user originally reviewed.
  const toPrompt = isUpdate ? [...requested].filter((p) => !previousPermissions.has(p)) : [...requested];
  const newlyGranted = await showPermissionDialog({
    name: manifest.name,
    icon: iconObjectUrl,
    requested: toPrompt,
  });
  const granted = isUpdate ? new Set([...previousPermissions, ...newlyGranted]) : newlyGranted;
  if (iconObjectUrl) URL.revokeObjectURL(iconObjectUrl);

  const updateMeta = await resolveUpdateMetadata(manifest, isUpdate);

  if (manifest.type === "online") {
    return appendRegistryEntry({
      name: manifest.name,
      desc: manifest.desc,
      type: "online",
      url: manifest.url,
      permissions: [...granted],
      ...updateMeta,
    });
  }

  return installOfflineApp(manifest, zip, iconBlob, granted, bwFile, updateMeta);
}

/**
 * Pins the app's update identity at first install: if the manifest names
 * an updateUrl, it MUST also ship a publicKey (base64 SPKI, ECDSA P-256)
 * — otherwise there'd be nothing stopping a compromised or spoofed
 * update server from pushing arbitrary code with no way to verify it,
 * so update-checker.js is simply never pointed at this app. The key is
 * pinned once, here, and never changed by an update (key rotation isn't
 * supported by this scheme — publishing a new key means publishing a
 * new app identity).
 */
async function resolveUpdateMetadata(manifest, isUpdate) {
  if (!manifest.updateUrl) return {};
  if (typeof manifest.publicKey !== "string" || !manifest.publicKey.trim()) {
    console.warn(`[CAS] "${manifest.name}" has an updateUrl but no publicKey — auto-update disabled for it.`);
    return {};
  }
  try {
    await importUpdatePublicKey(manifest.publicKey); // validates it's a real ECDSA P-256 SPKI key
  } catch (err) {
    console.warn(`[CAS] "${manifest.name}"'s publicKey is invalid — auto-update disabled for it:`, err);
    return {};
  }
  return {
    version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
    updateUrl: manifest.updateUrl,
    // Only ever set on a fresh install — resolveUpdateMetadata isn't
    // called with a way to change it on an update, by design.
    ...(isUpdate ? {} : { publicKey: manifest.publicKey }),
  };
}

/** Shared with update-checker.js's signature verification. */
export async function importUpdatePublicKey(base64Spki) {
  const der = Uint8Array.from(atob(base64Spki), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

/**
 * Writes an offline app's entry point, icon, and packaged assets to
 * casf/CAS/apps/, copies its background worker (if any + granted) to the
 * protected casf/CAS/bws/ tree, then appends it to the app registry.
 */
async function installOfflineApp(manifest, zip, iconBlob, granted, bwFile, updateMeta = {}) {
  const appName = sanitizeAppName(manifest.name);
  if (!appName) {
    throw new Error(`Invalid .hpk: app name "${manifest.name}" doesn't contain any usable characters (a-z, 0-9, -).`);
  }

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
    ...updateMeta,
  });
}

/**
 * Re-zips the .hpk's assets/ subtree (recursively) into a single
 * assets.zip, preserving nested paths, and saves it to
 * casf/CAS/apps/assets/[appname]/assets.zip. Entries that try to escape
 * the assets/ subtree (zip slip: "assets/../../evil.js") are dropped.
 */
async function packageAssets(zip, appName) {
  const JSZip = await loadJSZip();
  const assetsZip = new JSZip();

  const assetEntries = zip.folder("assets") ? zip.filter((path) => path.startsWith("assets/")) : [];

  if (assetEntries.length === 0) {
    return; // App shipped no assets/ directory — nothing to package.
  }
  if (assetEntries.length > MAX_ASSET_ENTRIES) {
    throw new Error(`Invalid .hpk: too many files under assets/ (${assetEntries.length}).`);
  }

  for (const entry of assetEntries) {
    if (entry.dir) continue;
    const relativePath = sanitizeRelativePath(entry.name.slice("assets/".length));
    if (relativePath === null) {
      console.warn(`[CAS] skipped unsafe asset path in "${appName}": ${entry.name}`);
      continue;
    }
    const content = await entry.async("blob");
    if (content.size > MAX_ASSET_ENTRY_BYTES) {
      throw new Error(`Invalid .hpk: asset "${entry.name}" exceeds the per-file size limit.`);
    }
    assetsZip.file(relativePath, content);
  }

  const packagedBlob = await assetsZip.generateAsync({ type: "blob" });
  await fs.writeFile(
    ["CAS", "apps", "assets", appName, "assets.zip"],
    packagedBlob
  );
}

/** Same zip-slip guard used when re-extracting assets.zip later — see webcontainer-runtime.js. */
function sanitizeRelativePath(name) {
  const out = [];
  for (const raw of String(name).replace(/\\/g, "/").split("/")) {
    const segment = raw.trim();
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length ? out.join("/") : null;
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
