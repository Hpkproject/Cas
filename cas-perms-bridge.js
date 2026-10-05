/**
 * cas-perms-bridge.js
 * -----------------------------------------------------------------------
 * Runs on the host (main CAS thread). Listens for {type:"cas:call"}
 * messages from a Worker (app/plugin background worker) or a served
 * app's window, enforces permissions, executes the requested effect, and
 * replies with {type:"cas:result"}. This is the only place CAS.fs.modify
 * and CAS.notify actually touch disk / the Notification API.
 * -----------------------------------------------------------------------
 */

import { fs, PROTECTED_PREFIXES } from "./fs-manager.js";
import {
  PERMISSIONS,
  getGrantedPermissions,
  grantPermission,
  showRuntimePermissionPrompt,
} from "./permissions.js";
import { callPlugin } from "./bw-manager.js";

// Apps write arbitrarily-sized content through fs.modify; without a cap a
// single call could fill the user's disk. 25MB comfortably covers real
// app data files without making this a practical DoS vector.
const MAX_WRITE_BYTES = 25 * 1024 * 1024;

/**
 * Wires up bidirectional messaging between the host and one source
 * (a Worker instance, or a served app's window). `kind` picks the
 * transport; everything else is identical. `origin` pins the exact
 * origin a window-hosted app's WebContainer preview was served from —
 * responses are only ever sent there, never to "*", so a reply (which
 * can carry file contents or a plugin's api.js source) can't leak to
 * wherever that window happens to navigate next.
 */
export function attachBridge(source, { appId, appName, kind, origin }) {
  async function handleMessage(event) {
    const msg = event.data;
    if (!msg || msg.type !== "cas:call") return;
    if (kind === "window" && event.source !== source) return;

    const { callId, method, args } = msg;
    try {
      const result = await dispatch(appId, appName, method, args ?? []);
      respond({ type: "cas:result", callId, ok: true, result });
    } catch (err) {
      respond({ type: "cas:result", callId, ok: false, error: String(err?.message ?? err) });
    }
  }

  function respond(payload) {
    if (kind === "worker") source.postMessage(payload);
    else source.postMessage(payload, origin ?? "*");
  }

  const target = kind === "worker" ? source : window;
  target.addEventListener("message", handleMessage);
  return () => target.removeEventListener("message", handleMessage);
}

async function dispatch(appId, appName, method, args) {
  switch (method) {
    case "fs.modify":
      return handleFsModify(appId, appName, args[0], args[1]);
    case "notify":
      return handleNotify(appId, appName, args[0], args[1]);
    case "plugin.call":
      return callPlugin(args[0], args[1], args[2] ?? []);
    default:
      throw new Error(`Unknown CAS API method "${method}".`);
  }
}

async function handleFsModify(appId, appName, path, content) {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("CAS.fs.modify: path is required.");
  }
  const size = byteLength(content);
  if (size > MAX_WRITE_BYTES) {
    throw new Error(`CAS.fs.modify: write of ${size} bytes exceeds the ${MAX_WRITE_BYTES}-byte limit.`);
  }

  const segments = normalizePathSegments(path);
  if (isProtectedPath(segments)) {
    throw new Error(`CAS.fs.modify: "${path}" is a protected CAS path and cannot be modified by apps.`);
  }

  const allowed = await ensurePermission(appId, appName, PERMISSIONS.FILESYSTEM);
  if (!allowed) throw new Error("Filesystem permission denied.");

  await fs.writeFile(segments, content ?? "");
  return { ok: true, path: segments.join("/") };
}

async function handleNotify(appId, appName, title, desc) {
  const allowed = await ensurePermission(appId, appName, PERMISSIONS.NOTIF);
  if (!allowed) throw new Error("Notification permission denied.");

  if (!("Notification" in window) || Notification.permission !== "granted") {
    throw new Error("CAS itself does not have OS notification permission.");
  }
  // Notification title/body render as plain text in the OS's own
  // notification UI (never interpreted as markup), so no escaping is
  // needed here the way it is for anything landing in a dialog's innerHTML.
  new Notification(String(title ?? appName), { body: String(desc ?? "") });
  return { ok: true };
}

/**
 * Splits a path into clean segments and collapses "." / ".." so a caller
 * can't climb out of casf with a path like "../../etc/passwd" or land
 * back inside a protected tree via "CAS/apps/../apis/plugins/x/api.js".
 * Anything that still tries to climb above casf root after normalizing
 * is rejected outright rather than being clamped, since clamping could
 * silently redirect the write somewhere the caller didn't intend.
 */
function normalizePathSegments(path) {
  const out = [];
  for (const raw of String(path).split("/")) {
    const segment = raw.trim();
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) {
        throw new Error("CAS.fs.modify: path escapes the CAS storage root.");
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  if (out.length === 0) {
    throw new Error("CAS.fs.modify: path is required.");
  }
  return out;
}

/** The entire CAS/ tree is CAS-owned and immutable via the app permission API — see PROTECTED_PREFIXES. */
function isProtectedPath(segments) {
  const normalized = segments.join("/");
  return PROTECTED_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

function byteLength(content) {
  if (content == null) return 0;
  if (content instanceof Blob) return content.size;
  if (content instanceof ArrayBuffer) return content.byteLength;
  if (ArrayBuffer.isView(content)) return content.byteLength;
  return new Blob([typeof content === "string" ? content : JSON.stringify(content)]).size;
}

/**
 * Declared-at-install permissions are granted silently. Anything an app
 * didn't declare gets a one-off runtime consent prompt instead, and the
 * answer is remembered for next time.
 */
async function ensurePermission(appId, appName, permission) {
  const granted = await getGrantedPermissions(appId);
  if (granted.has(permission)) return true;

  const allow = await showRuntimePermissionPrompt(appName, permission);
  if (allow) await grantPermission(appId, permission);
  return allow;
}
