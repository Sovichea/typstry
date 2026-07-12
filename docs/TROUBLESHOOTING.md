# Troubleshooting

## Native features do not work in the browser

Use:

```bash
bun run tauri dev
```

`bun run dev` starts only Vite in a browser. Native filesystem access, dialogs, settings persistence, Tinymist, and Tauri IPC will not work there.

## Windows build errors

### `LNK1104: cannot open file 'msvcrt.lib'`

Install the Visual Studio **Desktop development with C++** workload and Windows SDK, then restart the terminal.

### MSI packaging fails with `light.exe` or VBSCRIPT errors

Enable **VBSCRIPT** under Windows Optional Features. This is needed only for MSI generation.

## Linux build errors

### `webkit2gtk-4.1` or `javascriptcoregtk-4.1` missing

Install the WebKitGTK 4.1 packages for your distribution. See [INSTALL.md](./INSTALL.md).

## Shell cannot find `bun` or `cargo`

Restart the terminal and verify that the relevant directories are on `PATH`:

- Bun: `~/.bun/bin`
- Rust: `~/.cargo/bin`

Then verify:

```bash
git --version
rustc --version
cargo --version
bun --version
```

## Tinymist cannot be downloaded

Verify GitHub access and retry from **Settings → Toolchain**. A system `typst` executable does not replace the managed Tinymist requirement.

## Preview or inverse sync problems

Preview behavior is handled by Tinymist and Typstella's preview iframe layer. Developer notes are in [PREVIEW_INTERCEPTION.md](./PREVIEW_INTERCEPTION.md).

When reporting preview issues, include:

- Operating system.
- Typstella version.
- Whether the preview is docked or undocked.
- Whether the file is `main.typ` or an included file.
- Any visible messages from the developer log console.
