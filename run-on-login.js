/**
 * run-on-login.js
 * -----------------------------------------------------------------------
 * "Run on OS Login" is a real, shipped Chromium feature (Chrome/Edge 91+)
 * for installed PWAs — but it is deliberately NOT exposed to page
 * JavaScript. An installed app can never flip it on for itself; only the
 * user (via the browser's app-management UI) or an enterprise policy can.
 * See https://developer.chrome.com/blog/run-on-login.
 *
 * Two real paths, both used here instead of pretending there's a JS call
 * for this:
 *
 *   1. Unmanaged devices: this module shows a one-time, OS-aware M3
 *      dialog during first-run setup walking the user through enabling
 *      it themselves. There is no way to deep-link to chrome://apps from
 *      page content (browsers block navigation to chrome: URLs), so the
 *      dialog just names the exact steps.
 *   2. Managed Cora OS devices: since CAS *is* the shell here, a Cora OS
 *      image can ship Chromium's WebAppSettings enterprise policy
 *      pre-configured with `run_on_os_login: "run_windowed"` for CAS's
 *      manifest_id, making this fully automatic with no per-user step at
 *      all. See enterprise-policy/webapp-settings.sample.json.
 * -----------------------------------------------------------------------
 */

function detectPlatformSteps() {
  const ua = navigator.userAgent;
  if (/Mac/.test(ua)) {
    return 'Open the CAS window, click the three-dot menu in the title bar, choose "App info", then turn on "Start automatically". (Or: right-click the CAS icon in the Dock → "Options".)';
  }
  if (/Linux/.test(ua) && !/Android/.test(ua)) {
    return 'Open the CAS window, click the three-dot menu in the title bar, choose "App info", then turn on "Start automatically".';
  }
  // Windows and unrecognized platforms get the most common path.
  return 'Type chrome://apps into your browser\'s address bar, right-click the CAS icon, and choose "Start automatically".';
}

/** Shown once, right after first-run setup finishes. Resolves when dismissed. */
export function showRunOnLoginPrompt() {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "cas-dialog";
    dialog.innerHTML = `
      <div class="cas-dialog__body">
        <h2 class="cas-dialog__title">Start CAS automatically?</h2>
        <p class="cas-dialog__desc">
          Background workers and plugins only run while CAS is open. For them to
          start the moment you log in, enable "Start automatically" for CAS —
          the browser has to do this, CAS can't turn it on for itself.
        </p>
        <p class="cas-dialog__desc">${detectPlatformSteps()}</p>
      </div>
      <div class="cas-dialog__actions">
        <button class="cas-btn cas-btn--filled" data-action="ok">Got it</button>
      </div>
    `;
    dialog.addEventListener("click", (e) => {
      if (e.target?.dataset?.action !== "ok") return;
      dialog.close();
      dialog.remove();
      resolve();
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}
