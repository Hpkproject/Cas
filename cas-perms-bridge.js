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

import { fs } from "./fs-manager.js";
import {
  PERMISSIONS,
  getGrantedPermissions,
  grantPermission,
  showRuntimePermissionPrompt,
} from "./permissions.js";
import { callPlugin } from "./bw-manager.js";

/**
 * Wires up bidirectional messaging between the host and one source
 * (a Worker instance, or a served app's window). `kind` picks the
 * transport; everything else is identical.
 */
export function attachBridge(source, { appId, appName, kind }) {
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
    else source.postMessage(payload, "*");
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
  const segments = path.split("/").filter(Boolean);
  if (isProtectedPath(segments)) {
    throw new Error(`CAS.fs.modify: "${path}" is a protected CAS path and cannot be modified by apps.`);
  }

  const allowed = await ensurePermission(appId, appName, PERMISSIONS.FILESYSTEM);
  if (!allowed) throw new Error("Filesystem permission denied.");

  await fs.writeFile(segments, content ?? "");
  return { ok: true, path };
}

async function handleNotify(appId, appName, title, desc) {
  const allowed = await ensurePermission(appId, appName, PERMISSIONS.NOTIF);
  if (!allowed) throw new Error("Notification permission denied.");

  if (!("Notification" in window) || Notification.permission !== "granted") {
    throw new Error("CAS itself does not have OS notification permission.");
  }
  new Notification(title ?? appName, { body: desc ?? "" });
  return { ok: true };
}

/** casf/CAS/bws and casf/CAS/apis are CAS-owned and immutable via the app permission API. */
function isProtectedPath(segments) {
  return segments[0] === "CAS" && (segments[1] === "bws" || segments[1] === "apis");
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
