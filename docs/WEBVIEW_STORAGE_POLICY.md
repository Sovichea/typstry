# WebView storage monitoring and maintenance policy

## Purpose

Typsastra must prevent its embedded browser profile from growing without
visibility while preserving user settings and avoiding cleanup work that makes
the editor less responsive. On Windows, the default profile currently appears
under a path such as:

```text
%LOCALAPPDATA%\com.typsastra.editor\EBWebView
```

That example is not an API contract. The application must resolve the active
WebView data directory from its platform configuration and must never hardcode
a user name or Windows path. Linux and macOS use different webview engines and
storage layouts; the same policy applies when their paths and safe cleanup APIs
are qualified.

This policy covers persistent disk use. WebView process RAM, JavaScript heap,
PDF canvas residency, and Tinymist memory remain separate diagnostics.

## Storage classes

Typsastra must classify storage before reporting or removing anything:

| Class | Examples | Policy |
| --- | --- | --- |
| Disposable cache | HTTP disk cache, code cache, GPU/shader cache, webview component download cache | May be cleared through a qualified webview API or an allowlisted stopped-process cleanup path. |
| Persistent application state | Local Storage, IndexedDB, WebStorage, cookies, preferences | Preserve during normal cache maintenance. |
| Runtime and security state | Network state, certificates, trust data, component metadata | Preserve unless the webview runtime owns a documented maintenance API. |
| Diagnostics | Crash reports and logs | Report separately and apply an age-based retention policy after platform validation. |
| Unknown | New directories introduced by a runtime update | Measure only. Never delete automatically. |

Typsastra must never recursively delete the complete `EBWebView` profile as
routine maintenance. A full profile reset is a separate recovery action that
requires explicit confirmation and clearly states which application state will
be lost.

## Monitoring cadence

Monitoring must run outside the critical startup and editing paths:

1. Start the first background scan 60 seconds after the workspace UI becomes
   ready. PDF compilation does not need to finish first.
2. Run a lightweight cache-category scan every 30 minutes while Typsastra is
   open, but only after at least five seconds of input idle time.
3. Delay rather than overlap a scan when the user is typing, dragging panes,
   scrolling a preview, compiling, exporting, installing a provider, or
   applying an update. Only one scan may run at a time.
4. Run a complete profile classification at most once per 24 hours, after an
   application update, and when the user explicitly chooses **Scan now**.
5. Run an immediate verification scan after maintenance and record the
   reclaimed bytes.

Directory traversal belongs in a bounded blocking/native worker, never on the
WebView UI thread. It must not follow symbolic links, junctions, or reparse
points. Every resolved path must remain beneath the resolved webview profile
root.

## Local measurements

Keep at most 32 rolling samples in global application state. A sample contains:

```text
timestamp
Typsastra version
webview runtime and platform
total bytes
disposable-cache bytes
persistent-state bytes
unknown bytes
largest top-level categories
scan duration and incomplete/error state
```

Do not store filenames below the category level, project paths, URLs, document
content, or browsing data. Measurements remain local and are never included in
project exports. A support bundle may include aggregate measurements only after
the user reviews and explicitly approves it.

## Size and growth thresholds

The initial Windows baseline measured on July 22, 2026 was approximately
353.5 MiB, including about 188.9 MiB of HTTP cache, 96.2 MiB of code cache, and
less than 4 MiB of GPU-related caches. Thresholds therefore leave room for an
ordinary WebView2 installation rather than treating normal runtime data as a
leak.

| State | Trigger | User experience |
| --- | --- | --- |
| Healthy | Total below 768 MiB and growth below 256 MiB in 24 hours | No visible notification. Show the current measurement in Settings. |
| Advisory | Total at least 768 MiB, disposable cache at least 512 MiB, or growth at least 256 MiB in 24 hours | Show a non-modal Settings warning and the largest categories. |
| Action recommended | Total at least 1.5 GiB or disposable cache at least 1 GiB | Show one dismissible application notification with **Review storage** and **Clear disposable cache** actions. |
| Critical | Total at least 3 GiB, or free disk space is below 2 GiB while disposable cache is at least 512 MiB | Keep a visible warning until reviewed and offer restart-safe cleanup. Never silently remove persistent state. |

Use hysteresis to prevent repeated warnings. A dismissed threshold must not
notify again until seven days pass, the profile enters a higher state, or usage
falls below 75% of that threshold and later crosses it again.

Thresholds are defaults, not claims that all measured bytes are caused by
Typsastra. Runtime component directories must be shown separately from caches
created while the application is used.

## Cleanup policy

Normal cleanup follows these rules:

- Prefer the embedded webview runtime's browsing-data API over direct file
  deletion.
- Clear only categories classified and tested as disposable.
- Require confirmation before the first cleanup and whenever the operation
  needs an application restart.
- Do not clean while an update, download, export, compilation, or write is in
  progress.
- Preserve Local Storage, IndexedDB, WebStorage, cookies, preferences, provider
  data, workspace state, recent projects, fonts, and managed toolchains.
- Show estimated removable size before confirmation and actual reclaimed size
  afterward.
- Treat locked files and partial cleanup as recoverable results. Never retry in
  a tight loop.
- Never use shell-composed paths or follow links during fallback cleanup.

Automatic maintenance may be considered only after the allowlist and runtime
API pass the validation matrix below. Until then, monitoring is automatic but
cleanup remains user initiated.

## Settings experience

Add **Settings → Storage → WebView data** with:

- resolved profile location and platform runtime;
- last scan time, total size, disposable size, and recent growth;
- largest classified categories;
- **Scan now**, **Reveal folder**, and **Clear disposable cache** actions;
- an explanation that clearing cache may make the next startup or first preview
  slightly slower;
- a separate, deliberately less prominent **Reset WebView profile** recovery
  action that lists persistent state it will remove.

The title bar, status bar, preview, and editor must not show routine healthy
samples. Advisory status belongs in Settings; only action-recommended and
critical states may create an application-level notification.

## Validation gates

Before cleanup ships on a platform, verify:

- cache growth across 20 cold starts and 100 preview replacements;
- long PDF scrolling, zooming, and recompilation;
- settings, theme, release-summary state, and recent projects survive normal
  cleanup;
- language providers, generated-font variants, workspaces, and Tinymist remain
  untouched;
- automatic updates still verify, install, and relaunch;
- cleanup interruption, locked files, disk-full state, and application crash;
- canonical-path and link traversal protection;
- before/after sizes agree within a documented tolerance;
- Windows WebView2 first, followed by separately qualified WebKitGTK and
  WKWebView behavior rather than assuming their directory layouts match.

## Delivery sequence

1. **Read-only monitoring (implemented for Windows WebView2):** runtime path resolution, classified background
   scanning, rolling local samples, Settings display, and warning hysteresis.
2. **Manual cache maintenance:** qualified runtime API, confirmation, restart
   coordination where required, and before/after reporting.
3. **Retention refinement:** age-based diagnostic cleanup and evidence-based
   threshold tuning from representative installations.
4. **Optional automatic maintenance:** only for proven disposable categories
   and only after the full validation matrix passes.

This sequence keeps the initial change suitable for the v0.5.x maintenance line.
Automatic deletion or a cross-platform profile manager is a larger storage
subsystem and must not be added to a maintenance release without qualification.
