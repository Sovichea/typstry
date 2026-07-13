#import "template.typ": project
#import "import.typ" as imp

#show: project.with(
  title: imp.project-name + " README Documentation",
  authors: imp.authors,
  logo: "assets/typsastra-icon.png",
)

#include "readme.typ"
#include "chapters/research-workflow.typ"
#include "chapters/khmer-research.typ"

#bibliography("refs.bib", style: "apa")
