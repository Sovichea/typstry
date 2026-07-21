#set document(title: "Portable Workspace State")
#set page(margin: 24mm)

= Portable workspace state

Typsastra stores project identity, the main file, accepted project terminology,
open tabs, cursor positions, folds, expanded directories, layout, and selected
toolchain under `.typsastra`.

Project-owned settings use relative `/`-separated paths. Therefore, copying or
moving the whole project preserves its configured main file. Preview caches and
scaled font variants stay in Typsastra's private global cache and are not portable settings.

Try setting this file as main, opening `notes.typ`, moving the project directory,
and reopening it. The workspace UI state loads before asynchronous PDF
compilation begins.
