#set document(title: "Unicode and Mathematics")
#set page(margin: 24mm)
// typsastra:typography:start
// typsastra:document-scripts [{"family":"New Computer Modern","script":"latin","scale":1,"language":"en-US"}]
#set text(
  font: ((name: "New Computer Modern", covers: regex("\p{scx=Latin}")),),
  size: 11pt,
)
// typsastra:typography:end
#set heading(numbering: "1.")

= Unicode and Mathematics

Typst supports readable mathematical input and direct Unicode symbols in surrounding prose.

== Symbols in prose

Common symbols include arrows $arrow.r, arrow.l, arrow.l.r$, relations
$<=, >=, !=, approx$, sets $emptyset, NN, ZZ, QQ, RR, CC$, and operators
$sum, product, integral$.

== Equations

The Fourier transform of a signal $f(t)$ can be written as

$ F(omega) = integral_(-infinity)^(infinity) f(t) e^(-i omega t) dif t. $

Euler's identity is

$ e^(i pi) + 1 = 0. $

A vector and matrix example:

$ bold(v) = mat(x, y, z), quad A = mat(1, 2; 3, 4). $

== Greek in prose and math

The parameters α, β, and γ are ordinary Unicode characters in this sentence. Inside math mode, `$alpha$, $beta$, and $gamma$` use Typst's mathematical symbols.
