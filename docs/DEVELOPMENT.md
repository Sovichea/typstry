# Development

## Tech stack

- Core framework: [Tauri v2](https://v2.tauri.app/)
- Backend: Rust in `src-tauri/`
- Frontend: Bun + Vite + TypeScript in `src/`
- Editor: CodeMirror 6
- Typst preview and diagnostics: Tinymist

## Local development

```bash
git clone --recurse-submodules https://github.com/Sovichea/typstry.git
cd typstry
bun install --frozen-lockfile
bun run tauri dev
```

The first launch requires internet access to retrieve the selected stable Tinymist binary from GitHub. Later launches use the managed copy in the platform application-data directory.

## Dependency lockfiles

`bun.lock` is committed and is the reproducible dependency source for local development and CI. After changing `package.json`, run `bun install` and commit both files. Routine setup and CI should keep using:

```bash
bun install --frozen-lockfile
```

## Validation

Run the frontend and Rust checks before submitting changes:

```bash
bun test
bun run build
cargo fmt --manifest-path src-tauri/Cargo.toml --package typstry -- --check
cargo check --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## Architecture notes

- Tauri handles native windows, filesystem access, dialogs, settings persistence, and the LSP lifecycle.
- CodeMirror owns editor state, syntax behavior, autocomplete, selection, and decorations.
- Tinymist provides Typst diagnostics, preview, export, and source synchronization.
- Language analysis is handled by the Rust provider registry. Bundled providers include custom Khmer support and English Hunspell support.
- Script-aware cursor movement and deletion use the frontend policy registry documented in [SCRIPT_EDITING_POLICIES.md](./SCRIPT_EDITING_POLICIES.md).
- Settings are stored in a versioned `settings.json` in the platform application-config directory.

## Preview behavior

Each preview root has a uniquely identified Tinymist task whose iframe is cached across tab switches. Imported files normally preview through the top-level `main.typ` and update on save.

Put `// @allow-preview` on an imported file's first line to give that chapter an independent on-type preview. When `main.typ` applies a local template with `#show: template.with(...)`, Typstry creates a temporary preview entry that applies the same template without modifying the chapter. References to labels outside the chapter appear as explanatory placeholders in this standalone view; open `main.typ` to inspect final numbering and reference output.

Preview DOM interception is documented in [PREVIEW_INTERCEPTION.md](./PREVIEW_INTERCEPTION.md).

## Release builds

```bash
bun run tauri build
```

Build on each target operating system. Cross-platform installer output is not produced by a normal local Tauri build.
