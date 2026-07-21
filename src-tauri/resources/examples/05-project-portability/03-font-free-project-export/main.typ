#set document(title: "Font-free Project Export")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1,"language":"en-US"}]
#set text(
  font: ((name: "New Computer Modern", covers: regex("\p{scx=Latin}")),),
  size: 11pt,
)
// typsastra:typography:end

= Font-free project export

Typsastra project archives contain ordinary project files, portable workspace
settings, a generated integrity manifest, and an exact toolchain requirement.
They never contain font binaries, generated PDFs, preview caches, `.git`,
`node_modules`, or build output.

The font named above is an external runtime dependency. A recipient installs an
appropriate font separately. Exact Typst and Tinymist versions improve source
compatibility but cannot promise identical rendering when fonts differ.

Use **Export Typsastra Project** for a version-bound `.typsastra` archive or
**Export Source ZIP** for a lightweight source-only snapshot.
