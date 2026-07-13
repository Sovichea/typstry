# Packaged `.typsastra` Import Tests

Run this checklist against release artifacts, not `bun run tauri dev`. Record the application version, OS version, architecture, installer type, and result in the release issue.

## Fixture set

- A valid small project.
- A valid project whose archive and destination paths contain spaces, Khmer, and non-BMP characters.
- A large project near the documented entry and size limits.
- A corrupt/non-ZIP `.typsastra` file.
- Archives with traversal paths, a missing main file, a modified file/hash mismatch, and an unavailable toolchain version.

## Every supported package

Test Windows MSI/NSIS, Linux AppImage/deb/rpm where shipped, and the macOS app/dmg where shipped.

- Install cleanly and confirm `.typsastra` displays the Typsastra icon/description. Confirm `.typ` and `.typst` ownership is unchanged.
- With Typsastra closed, double-click a valid archive. Confirm one window opens, preflight is shown after initialization, and the normal import workflow completes.
- With Typsastra open, double-click the same archive repeatedly. Confirm the existing window focuses and one deduplicated import runs.
- Repeat cold and warm launch using the Unicode/space-path fixture.
- Cancel at every dialog or file chooser. Confirm no destination or staging directory remains.
- Open each hostile/corrupt fixture. Confirm a controlled error, no extracted files, and no overwrite of existing folders.
- Import an unavailable-version fixture; test both download and explicit incompatible override paths.
- Simulate insufficient disk space in a disposable VM/volume. Confirm the destination is never promoted and staging cleanup succeeds after space is restored.
- Uninstall Typsastra. Confirm its `.typsastra` association is removed without removing another application's `.typ`, `.typst`, or ZIP associations.

## Round trip

On Windows, Linux, and macOS: export the same Unicode fixture, import it into a fresh directory, compare all source hashes with the manifest, compile with the selected exact toolchain, and repeat export. Archive bytes should remain deterministic when the same Typsastra/toolchain inputs are used.
