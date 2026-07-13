= A scalable research workflow <workflow>

A research document is larger than its currently open source file. This chapter is deliberately stored separately while `main.typ` remains the document entry point. Opening this file keeps the full-document preview.

The project keeps reusable concerns separate:

- `template.typ` owns page and text styling.
- `import.typ` owns project metadata.
- chapter files own prose and local figures.
- `refs.bib` owns references.
- `assets/` owns portable figures.

#figure(
  image("../assets/typsastra-icon.png", width: 18%),
  caption: [A figure referenced from an included chapter.],
) <workflow-icon>

Figure @workflow-icon and the bibliography entry @research2025 remain resolvable when the complete project is compiled. The standalone view is intended for focused chapter work; final numbering belongs to the main document.
