#import "template.typ": thesis

// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1,"language":"en-US"}]

#show: thesis.with(
  title: "A Small Thesis on Multilingual Technical Writing",
  author: "Typsastra Examples",
)

#include "chapters/01-introduction.typ"
#include "chapters/02-method.typ"
#include "chapters/03-conclusion.typ"
