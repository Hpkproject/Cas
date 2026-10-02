# CAS — Cora App Services

Modular reference implementation: `casf` setup, the `.hpk`/`.casplugin`
install pipelines, a Material 3 launcher, a WebContainer-based offline-app
runtime, cross-origin isolation, a per-app permission system with a Settings
app to manage it, a signed update system, and background workers.

## File map

| File | Responsibility |
|---|---|
| `fs-manager.js` | `casf` picker, IndexedDB handle persistence, folder scaffolding, dependency downloads, CAS's own Notification permission request |
| `pending-launch.js` | Durable stash for File Handling API launches, so a double-clicked `.hpk`/`.casplugin` survives first-run, a re-permission prompt, or the COI reload |
| `hpk-installer.js` | `.hpk` parsing, install + permission dialogs, background-worker extraction, update-metadata pinning, registry writes |
| `plugin-installer.js` | `.casplugin` parsing, install dialog, writes `api.js`/`main.js` to their two homes |
| `permissions.js` | Permission ids/copy, install-time + one-off runtime consent dialogs, per-app/plugin grant storage, HTML-escaping helper |
| `update-checker.js` | Fetches `updateUrl`, verifies the new `.hpk`'s signature against the app's pinned public key, applies the update |
| `settings-app.js` | Built-in Settings screen: per-app/plugin permission toggles, manual "Check for updates" |
| `bw-manager.js` | Boots every app/plugin background worker at CAS startup (idempotently); routes `CAS.import(x).method()` calls to the right running plugin worker |
| `cas-perms-client.js` | Source of the injected `CAS` global (`CAS.fs.modify`, `CAS.notify`, `CAS.import`) — runs inside apps, app background workers, and plugin workers |
| `cas-perms-bridge.js` | Host-side counterpart: receives `CAS.*` calls over `postMessage`, checks permissions, does the actual filesystem/Notification work |
| `launcher.js` | Reads `index.json`, renders the search + grid UI, dispatches launches, Install/Settings buttons |
| `webcontainer-runtime.js` | Boots WebContainer, mounts app files, extracts `assets.zip`, injects the favicon + `CAS` bridge script, starts Express, opens the app window |
| `storage-sync.js` | `localStorage` hydration/report script + `key-values.json` read/write |
| `service-worker.js` | Caches `index.html` **and** stamps COOP/COEP headers on same-origin responses (one worker, one scope) |
| `coi-serviceworker.js` | Page-context bootstrap: registers `service-worker.js`, reloads at most once, and hands any pending File Handling API launch to `pending-launch.js` first |
| `run-on-login.js` | One-time onboarding dialog guiding the user through Chromium's real "Run on OS Login" setting (unmanaged devices) |
| `app.js` | Entry point: storage gate, launch draining, manual/drag-and-drop installs, boots background workers, mounts the launcher/Settings |
| `m3-theme.css` | Material 3 tokens + dialog/launcher/permission-list/settings component styles |
| `index.html`, `manifest.json` | Shell page (loads `coi-serviceworker.js` first) and PWA manifest (`file_handlers` for `.hpk`/`.casplugin`, stable `id`, `launch_handler: focus-existing`) |
| `enterprise-policy/webapp-settings.sample.json` | Sample Chromium `WebAppSettings` policy for managed Cora OS devices — makes CAS start on login automatically, no per-user step |

## How permissions work

A `.hpk` manifest can declare `"permissions": ["notif", "filesystem", "background_workers"]`
and, for a background worker, `"Background_Worker": "sw.js"` (naming a script
inside the archive). At install time, `hpk-installer.js` shows one dialog for
the app itself and a second listing exactly the permissions it asked for —
nothing implicit. If an app calls `CAS.notify()` / `CAS.fs.modify()` at
runtime without having declared the matching permission, it gets a one-off
consent prompt instead of a hard failure. `CAS.fs.modify(path, content)`
writes relative to `casf`, but the entire `CAS/` tree is hard-blocked
regardless of what permission was granted — apps get everything else in
`casf` to themselves, never CAS's own internals (including the app/plugin
registries that record who has what permission — see Security below for why
that boundary is drawn at the whole tree rather than a few subfolders).

The **Settings app** (gear icon in the launcher) lists every installed app
and plugin with checkboxes for each permission, backed by the same
`grantPermission`/`revokePermission` calls the install-time dialogs use.
Unchecking "Run in the background" for an app also terminates its running
worker immediately, not just future calls — see `bw-manager.js`'s
`syncAppWorkerState`.

## The update system

A `.hpk` manifest can additionally declare:

```json
{
  "updateUrl": "https://example.com/myapp/update.json",
  "publicKey": "<base64 SPKI DER, ECDSA P-256>",
  "version": "1.0.0"
}
```

`publicKey` is **pinned at first install** and never changes on an update —
publishing a new key means publishing a new app identity, not rotating an
old one. Without both `updateUrl` and a valid `publicKey`, auto-update is
silently disabled for that app (logged, not fatal) rather than falling back
to unsigned updates.

`updateUrl` must serve JSON in this shape:

```json
{
  "version": "1.2.0",
  "hpkUrl": "https://example.com/myapp/myapp-1.2.0.hpk",
  "signature": "<base64 ECDSA P-256 / SHA-256 signature over the .hpk file's raw bytes>",
  "notes": "What changed in this version"
}
```

The publisher signs the `.hpk` file's raw bytes with the private half of the
pinned key (any offline tooling — `openssl`, Web Crypto in a build script,
etc.) and serves the base64 signature alongside the download URL.
`update-checker.js` fetches `updateUrl`, compares `version` against what's
installed, downloads `hpkUrl` only if newer, and verifies the signature
against the *pinned* key before ever reinstalling — an update response can
say anything about itself except supply its own key. Only permissions the
new version added beyond what was already granted get a fresh consent
dialog; existing grants carry forward untouched.

## How background workers and plugins work

An app's declared `Background_Worker` script is copied to `casf/CAS/bws/[app]/sw.js`
(not the app's own install folder) if — and only if — the background
permission was granted. A `.casplugin` package's `main.js` + `api.js` go to
`casf/CAS/bws/plugins/[name]/` and always run, no separate permission step:
installing a plugin is the consent, per spec. `bw-manager.js` boots every
qualifying worker (idempotently — safe to call `bootAll()` repeatedly)
whenever `app.js`'s `main()` runs.

`api.js`'s convention: it should assign `self.PLUGIN_API = { methodName(...) {...}, ... }`.
A guest app calling `CAS.import("helloworld")` gets back a `Proxy` — not a
promise — so `CAS.import("helloworld").alert("hi")` works directly; each
method call is relayed to the live `helloworld` background worker and
resolves once it responds.

## Starting CAS at OS login

"Run on OS Login" is a real, shipped Chromium feature (Chrome/Edge 91+) for
installed PWAs — but it's deliberately not exposed to page JavaScript; an
app can never enable its own auto-start. Two real paths, both used here:

- **Unmanaged devices:** `run-on-login.js` shows a one-time, OS-aware dialog
  right after first-run setup, walking the user through turning it on via
  the browser's own app-management UI.
- **Managed Cora OS devices:** a Cora OS image can ship Chromium's
  `WebAppSettings` enterprise policy pre-configured with
  `run_on_os_login: "run_windowed"` for CAS's manifest ID — see
  `enterprise-policy/webapp-settings.sample.json`. Fully automatic, no
  per-user step at all.

## Cross-origin isolation

`coi-serviceworker.js` is vendored into `casf/CAS/sys/api/3rd-party/` like
`webcontainer.js`/`jszip.js` for version-pinning, but the copy that's actually
*registered* is the one shipped next to `index.html`. It reloads **at most
once** per tab (a second failed attempt would loop forever) and, before that
reload, hands any pending File Handling API launch to `pending-launch.js` —
otherwise a double-clicked `.hpk` that triggers the very first load would
have its launch params silently discarded by the isolation reload itself.

## Security

This is meant to run as an open ecosystem — third-party `.hpk`/`.casplugin`
authors, not just a trusted first party — so the things worth calling out
explicitly:

- **`CAS.fs.modify` blocks the entire `CAS/` tree**, not just the obviously
  sensitive subfolders. An app that could still reach `CAS/apps/index.json`
  could rewrite its own (or another app's) granted permissions, which would
  make the whole permission system pointless.
- **Path traversal is rejected, not clamped**, both in `CAS.fs.modify`
  (`cas-perms-bridge.js`) and when extracting `assets.zip` (checked once at
  package time in `hpk-installer.js`, and again at extract time in
  `webcontainer-runtime.js`, since the zip is a plain file on disk between
  those two moments). A path that tries to climb above its root is dropped
  outright rather than silently reinterpreted.
- **Dialog content is HTML-escaped.** Manifest fields like an app's `name`
  are attacker-controlled strings that end up in the CAS shell's own
  `innerHTML` (permission dialogs, Settings). `permissions.js` exports
  `escapeHtml` and everything interpolates through it.
- **`postMessage` responses are pinned to the app's actual served origin**,
  not sent with `"*"`, so a reply — which can carry file contents or a
  plugin's `api.js` source — can't leak to wherever a reused window happens
  to navigate next.
- **Size caps** on `.hpk`/update downloads, per-asset-file size, and
  individual `CAS.fs.modify` writes guard against zip bombs and simple
  disk-fill DoS.
- **Update signatures are non-negotiable**: no `publicKey` pinned at install
  means no auto-update path exists for that app at all — there's no
  "unsigned but allowed" tier.

Everything else — the `.hpk`/`.casplugin` formats, the `casf` folder layout,
`assets.zip` packaging, and the `localStorage` round-trip — runs entirely
client-side, no build step required.
