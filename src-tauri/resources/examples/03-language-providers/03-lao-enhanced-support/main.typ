#import "template.typ": lao_document

// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1,"language":"en-US"},{"family":"Noto Sans Lao","script":"lao","scale":1,"language":"lo-LA"}]

#set document(
  title: "ເອກະສານລາວ - Lao Document",
  author: "Typsastra Examples",
)

#show: lao_document

#include "sections/01-introduction.typ"
#include "sections/02-lao-tools.typ"
#include "sections/03-mixed-scripts.typ"
