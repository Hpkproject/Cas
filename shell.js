/**
 * shell.js
 * -----------------------------------------------------------------------
 * Renders the persistent chrome once casf is ready: the starfield
 * backdrop and a left sidebar (brand, Home, Install, Settings), with a
 * `<main>` content slot that launcher.js / settings-app.js render into
 * instead of owning the whole page. Switching between Home and Settings
 * is then just "render different content into the same slot" — the
 * sidebar itself never unmounts.
 * -----------------------------------------------------------------------
 */

/**
 * @param {HTMLElement} root
 * @param {{ onHome: () => void, onInstall?: () => void, onSettings?: () => void, brandIconSrc?: string }} opts
 * @returns {{ main: HTMLElement, setActive: (name: "home"|"settings") => void }}
 */
export function mountShell(root, { onHome, onInstall, onSettings, brandIconSrc = "./icons/CAS-96.png" } = {}) {
  const icons = {
    home: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 10 8-6 8 6v9a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/><path d="M9 20h6"/></svg>`,
    install: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M6 10l6 6 6-6M5 20h14"/></svg>`,
    settings: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1A1.7 1.7 0 0 0 6.2 12a1.7 1.7 0 0 0-1.2-2.9h-.2a1.7 1.7 0 0 1 0-3.4H5A1.7 1.7 0 0 0 6.2 2.8l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1A1.7 1.7 0 0 0 11.5 1h.2a1.7 1.7 0 0 1 3.4 0v.2A1.7 1.7 0 0 0 18 2.4l.1-.1a1.7 1.7 0 0 1 2.4 2.4l-.1.1A1.7 1.7 0 0 0 19.2 8v.2a1.7 1.7 0 0 1 0 3.4H19a1.7 1.7 0 0 0 .4 3.4Z" transform="translate(0 3) scale(.75)"/></svg>`,
  };
  root.innerHTML = `
    <div class="cas-space-bg" aria-hidden="true"></div>
    <div class="cas-shell">
      <nav class="cas-sidebar">
        <div class="cas-sidebar__brand"><img src="${brandIconSrc}" alt="" /></div>
        <button class="cas-sidebar__btn" data-nav="home" title="Home" aria-current="true">${icons.home}</button>
        ${onInstall ? `<button class="cas-sidebar__btn" data-nav="install" title="Install package">${icons.install}</button>` : ""}
        <div class="cas-sidebar__spacer"></div>
        ${onSettings ? `<button class="cas-sidebar__btn" data-nav="settings" title="Settings">${icons.settings}</button>` : ""}
      </nav>
      <main class="cas-main" id="cas-main"></main>
    </div>
  `;

  const handlers = { home: onHome, install: onInstall, settings: onSettings };
  const buttons = [...root.querySelectorAll("[data-nav]")];

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      const name = btn.dataset.nav;
      if (name === "home" || name === "settings") setActive(name);
      handlers[name]?.();
    });
  }

  function setActive(name) {
    for (const btn of buttons) {
      if (btn.dataset.nav === "home" || btn.dataset.nav === "settings") {
        btn.setAttribute("aria-current", String(btn.dataset.nav === name));
      }
    }
  }

  return { main: root.querySelector("#cas-main"), setActive };
}
