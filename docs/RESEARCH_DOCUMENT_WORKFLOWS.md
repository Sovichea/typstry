# Research-document workflows

Typstella treats a research project as one document with many source files. The workspace root and configured main file own the document identity; an included chapter is a source inside that document, not a second document.

## Identity and preview ownership

```text
document = normalized workspace path + normalized configured main path
source = document + normalized source path
preview session = document + preview root + render mode
cache = workspace/.typstella
```

Opening a normal included or imported file reuses the main document's preview session and scroll state. A first-line `// @standalone-preview` directive explicitly gives that source an independent preview root. It does not replace the configured main file or affect sibling chapters.

## Recommended project structure

```text
project/
  main.typ
  template.typ
  chapters/
    introduction.typ
    methods.typ
  figures/
  references.bib
```

Keep project-wide typography and page configuration in the template applied by `main.typ`. Example 11 is the maintained end-to-end fixture: it contains a template, metadata import, included chapters, standalone-preview content, bibliography, figures, Latin, Khmer, spaces, and a Unicode filename.

## Render modes

- **On type** mirrors unsaved Typst sources into `.typstella/cache`, debounces revisions, and compiles the latest revision.
- **On save** compiles original workspace files only after a successful save and does not depend on the mirror cache.

A render failure is non-terminal: the queued latest revision is processed after the failed request completes. LSP restarts clear stale document and source-map session state before reopening the active document.

## External changes

File-watcher updates use one ordered path:

```text
reload clean editor tabs
→ prepare the render mirror when required
→ notify open LSP documents and workspace file changes
→ refresh the explorer
→ refresh the owned preview once
```

Dirty tabs are never overwritten; Typstella reports an external-change conflict instead.

## Cache portability

`.typstella/` contains generated render mirrors, source maps, and scaled render-only fonts. It is hidden in the Explorer and ignored by Git. The directory can be regenerated and the original project must compile with the standard Typst CLI without it.

## Contributor validation

1. Run frontend tests and the production build.
2. Run native library tests.
3. Open Example 11, configure `main.typ`, and switch between its included chapters.
4. Confirm the ordinary Khmer chapter retains the main preview while the directive chapter previews independently.
5. Test both render modes, introduce and repair a Typst error, then restart with an empty saved tab list.
6. Run `typst compile main.typ` inside Example 11 with `.typstella/` absent.
