/**
 * update-checker.js
 * -----------------------------------------------------------------------
 * An app that declared both `updateUrl` and `publicKey` in its manifest
 * (see hpk-installer.js's resolveUpdateMetadata) gets a real update path:
 *
 *   1. Fetch `updateUrl` -> { version, hpkUrl, signature, notes? }
 *      (see UPDATE_MANIFEST_FORMAT below for the exact shape).
 *   2. If `version` is newer than what's installed, fetch `hpkUrl`.
 *   3. Verify `signature` (base64 ECDSA P-256 / SHA-256) against the
 *      downloaded bytes, using the SAME public key pinned at first
 *      install — never a key the update response itself supplies, which
 *      would make the signature check meaningless.
 *   4. Only on a valid signature: reinstall through the normal
 *      hpk-installer.js path, which re-validates the .hpk itself, only
 *      re-prompts for permissions the new version added, and carries the
 *      pinned public key forward untouched.
 *
 * An unsigned update, a bad signature, a downgrade, or a network error
 * all just mean "no update available" from the caller's point of view —
 * nothing is ever installed from an unverified source.
 * -----------------------------------------------------------------------
 */

import { fs } from "./fs-manager.js";
import { installHpk, importUpdatePublicKey } from "./hpk-installer.js";

/**
 * The JSON document `updateUrl` must serve:
 * {
 *   "version": "1.2.0",              // required, compared with compareVersions()
 *   "hpkUrl": "https://.../app.hpk",  // required, https
 *   "signature": "base64...",         // required, ECDSA P-256/SHA-256 over the raw .hpk bytes
 *   "notes": "What changed"           // optional, shown in the Settings app
 * }
 */
export const UPDATE_MANIFEST_FORMAT = Object.freeze({
  version: "string, required",
  hpkUrl: "string (https URL), required",
  signature: "string (base64 ECDSA P-256/SHA-256 signature over the .hpk file's raw bytes), required",
  notes: "string, optional",
});

const MAX_UPDATE_HPK_BYTES = 200 * 1024 * 1024;

/** Reads the app registry, filtered to entries that can actually be auto-updated. */
async function updatableApps() {
  const raw = await fs.readText(["CAS", "apps", "index.json"]);
  const registry = raw ? JSON.parse(raw) : [];
  return registry.filter((e) => e.updateUrl && e.publicKey);
}

/**
 * Fetches and validates the update descriptor for one app. Returns
 * `{ app, version, hpkUrl, signature, notes }` if a newer version is
 * available, or `null` (not an error — logged and swallowed) for
 * anything that isn't a clean, newer, well-formed descriptor.
 */
export async function checkForUpdate(app) {
  try {
    const res = await fetch(app.updateUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const descriptor = await res.json();

    if (typeof descriptor.version !== "string") throw new Error("missing version");
    if (typeof descriptor.hpkUrl !== "string" || !descriptor.hpkUrl.startsWith("https://")) {
      throw new Error("hpkUrl must be an https URL");
    }
    if (typeof descriptor.signature !== "string" || !descriptor.signature.trim()) {
      throw new Error("missing signature");
    }
    if (compareVersions(descriptor.version, app.version ?? "0.0.0") <= 0) {
      return null; // already up to date (or the server tried to downgrade us)
    }

    return {
      app,
      version: descriptor.version,
      hpkUrl: descriptor.hpkUrl,
      signature: descriptor.signature,
      notes: typeof descriptor.notes === "string" ? descriptor.notes : "",
    };
  } catch (err) {
    console.warn(`[CAS] update check failed for "${app.name}":`, err.message ?? err);
    return null;
  }
}

/** Runs checkForUpdate() across every updatable app. Returns only the ones with something new. */
export async function checkAllForUpdates() {
  const apps = await updatableApps();
  const results = await Promise.all(apps.map(checkForUpdate));
  return results.filter(Boolean);
}

/**
 * Downloads, verifies, and installs one update returned by
 * checkForUpdate(). Throws on any verification failure rather than
 * failing silently — callers are expected to be a user-initiated
 * "Update" click, where an error should surface, not just log.
 */
export async function applyUpdate({ app, hpkUrl, signature }) {
  const res = await fetch(hpkUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to download update: HTTP ${res.status}`);

  const blob = await res.blob();
  if (blob.size > MAX_UPDATE_HPK_BYTES) {
    throw new Error(`Update .hpk is too large (${(blob.size / 1024 / 1024).toFixed(1)}MB).`);
  }

  const valid = await verifyHpkSignature(blob, signature, app.publicKey);
  if (!valid) {
    throw new Error(
      `Signature verification failed for "${app.name}"'s update — refusing to install it. ` +
        "Either the update was tampered with, or it wasn't signed with this app's original key."
    );
  }

  const file = new File([blob], `${app.appId ?? app.name}-update.hpk`, { type: "application/x-hpk" });
  const result = await installHpk(file, {
    isUpdate: true,
    previousPermissions: new Set(app.permissions ?? []),
  });

  // installHpk's update path doesn't re-pin a public key (see
  // resolveUpdateMetadata) — carry the originally pinned one forward
  // explicitly so update-checker keeps trusting the same identity.
  if (result && !result.publicKey) {
    await restorePinnedPublicKey(result, app.publicKey);
  }
  return result;
}

async function verifyHpkSignature(blob, signatureBase64, publicKeyBase64) {
  try {
    const key = await importUpdatePublicKey(publicKeyBase64);
    const signatureBytes = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));
    const dataBytes = new Uint8Array(await blob.arrayBuffer());
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signatureBytes,
      dataBytes
    );
  } catch (err) {
    console.error("[CAS] signature verification error:", err);
    return false;
  }
}

async function restorePinnedPublicKey(entry, publicKey) {
  const raw = await fs.readText(["CAS", "apps", "index.json"]);
  const registry = raw ? JSON.parse(raw) : [];
  const match = registry.find((e) => (e.appId ?? e.name) === (entry.appId ?? entry.name));
  if (!match) return;
  match.publicKey = publicKey;
  await fs.writeFile(["CAS", "apps", "index.json"], JSON.stringify(registry, null, 2));
}

/** Simple dotted-numeric semver-ish comparison: "1.10.0" > "1.9.0". Non-numeric parts sort as 0. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}
