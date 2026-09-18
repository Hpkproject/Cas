# CAS — Cora App Services

Modular reference implementation: `casf` setup, the `.hpk` install pipeline,
a Material 3 launcher, a WebContainer-based offline-app runtime, cross-origin
isolation via `coi-serviceworker.js`, a per-app permission system, background
workers, and a `.casplugin` extension system.

## File map

| File | Responsibility |
|---|---|
| `fs-manager.js` | `casf` picker, IndexedDB handle persistence, folder scaffolding, dependency downloads, CAS's own Notification permission request |
| `hpk-installer.js` | `.hpk` parsing, install dialog, permission dialog, background-worker extraction, registry writes |
| `plugin-installer.js` | `.casplugin` parsing, install dialog, writes `api.js`/`main.js` to their two homes |
| `permissions.js` | Permission ids/copy, install-time + one-off runtime consent dialogs, per-app/plugin grant storage |
| `bw-manager.js` | Boots every app/plugin background worker at CAS startup; routes `CAS.import(x).method()` calls to the right running plugin worker |
| `cas-perms-client.js` | Source of the injected `CAS` global (`CAS.fs.modify`, `CAS.notify`, `CAS.import`) — runs inside apps, app background workers, and plugin workers |
| `cas-perms-bridge.js` | Host-side counterpart: receives `CAS.*` calls over `postMessage`, checks permissions, does the actual filesystem/Notification work |
| `launcher.js` | Reads `index.json`, renders the search + grid UI, dispatches launches |
| `webcontainer-runtime.js` | Boots WebContainer, mounts app files, extracts `assets.zip`, injects the favicon + `CAS` bridge script, starts Express, opens the app window |
| `storage-sync.js` | `localStorage` hydration/report script + `key-values.json` read/write |
| `service-worker.js` | Caches `index.html` **and** stamps COOP/COEP headers on same-origin responses (one worker, one scope) |
| `coi-serviceworker.js` | Page-context bootstrap: registers `service-worker.js` and reloads once so `crossOriginIsolated` goes true |
| `app.js` | Entry point: first-run flow, `.hpk`/`.casplugin` file-handler wiring, boots background workers, mounts the launcher |
| `m3-theme.css` | Material 3 tokens + dialog/launcher/permission-list component styles |
| `index.html`, `manifest.json` | Shell page (loads `coi-serviceworker.js` first, before any module script) and PWA manifest (`file_handlers` for both `.hpk` and `.casplugin`) |

## How permissions work

A `.hpk` manifest can declare `"permissions": ["notif", "filesystem", "background_workers"]`
and, for a background worker, `"Background_Worker": "sw.js"` (naming a script
inside the archive). At install time, `hpk-installer.js` shows one dialog for
the app itself and a second listing exactly the permissions it asked for —
nothing implicit. If an app calls `CAS.notify()` / `CAS.fs.modify()` at
runtime without having declared the matching permission, it gets a one-off
consent prompt instead of a hard failure, the same way an undeclared browser
permission request would. `CAS.fs.modify(path, content)` writes relative to
`casf`, but `CAS/apis`, `CAS/sys`, and `CAS/bws` are hard-blocked regardless
of what permission was granted — apps can modify their own data and anything
else in `casf`, never CAS's own internals.

## How background workers and plugins work

An app's declared `Background_Worker` script is copied to `casf/CAS/bws/[app]/sw.js`
(not the app's own install folder) if — and only if — the background
permission was granted. A `.casplugin` package's `main.js` + `api.js` go to
`casf/CAS/bws/plugins/[name]/` and always run, no separate permission step:
installing a plugin is the consent, per spec. `bw-manager.js` boots every
qualifying worker as a dedicated Web Worker whenever CAS itself starts —
since CAS *is* the desktop shell here, "start on OS boot" reduces to "start
these the moment CAS's own `app.js` runs." (If CAS instead runs as an
installed PWA on top of some other OS, getting `app.js` to run at real
machine boot additionally needs that OS/browser's own "open at login" toggle
enabled for CAS — a user/install-time setting, not something scriptable.)

`api.js`'s convention: it should assign `self.PLUGIN_API = { methodName(...) {...}, ... }`.
A guest app calling `CAS.import("helloworld")` gets back a `Proxy` — not a
promise — so `CAS.import("helloworld").alert("hi")` works directly; each
method call is relayed to the live `helloworld` background worker and
resolves once it responds.

## Cross-origin isolation

`coi-serviceworker.js` is vendored into `casf/CAS/sys/api/3rd-party/` like
`webcontainer.js`/`jszip.js` for version-pinning, but the copy that's actually
*registered* is the one shipped next to `index.html` — a `FileSystemFileHandle`
inside `casf` has no URL a browser can register a service worker from. That
bootstrap and the header-injection logic both end up pointed at the same
`service-worker.js`, since a scope can only have one controlling worker at a
time; splitting them into two separately-registered files would just have
the second replace the first.

Everything else — the `.hpk`/`.casplugin` formats, the `casf` folder layout,
`assets.zip` packaging, and the `localStorage` round-trip — runs entirely
client-side, no build step required.
