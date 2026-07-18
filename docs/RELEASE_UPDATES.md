# Signed application updates

Typsastra checks the latest published GitHub release silently at startup. When a
newer signed version is available, the title bar displays an update badge. The
application downloads and installs an update only after the user clicks the
badge and confirms the action.

## Signing key

The updater public key is committed in `src-tauri/tauri.conf.json`. The matching
private key must remain secret and must not be committed. The initial private
key was generated at:

```text
%USERPROFILE%\.tauri\typsastra-updater.key
```

Back up this key securely. Losing it prevents existing installations from
accepting future updates. Replacing it requires distributing a regular installer
that contains the replacement public key.

Before running the release workflow, add a GitHub Actions repository secret
named `TAURI_SIGNING_PRIVATE_KEY`. Its value must be the complete contents of
the private key file. The current key has no password; if it is replaced by a
password-protected key, also set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

PowerShell can copy the private key value without printing it:

```powershell
Get-Content -Raw "$HOME\.tauri\typsastra-updater.key" | Set-Clipboard
```

## Release behavior

The release workflow creates signed updater artifacts and uploads their
signatures plus `latest.json` to the GitHub release. Releases are created as
drafts. The updater endpoint does not expose a draft, so publish the draft only
after every platform build is present and verified.

All application version declarations must match before pushing a release tag:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

The tag must use the matching `vMAJOR.MINOR.PATCH` form.

## Development simulation

Run the desktop application with a simulated newer version:

```powershell
bun run tauri:dev:update
```

This opens the normal development application with an `Update v0.6.0` badge.
Clicking it exercises the production confirmation dialog, unsaved-change warning,
and download/install progress states. The final step reports completion without
downloading an installer, closing the development process, or modifying the
installed application.

The simulation is enabled only in Vite development builds and only when the
validated `test-app-update` query parameter is present. Production builds ignore
the parameter.
