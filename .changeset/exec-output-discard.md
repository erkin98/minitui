---
'@minitui/exec': minor
---

A merge that does not finish now removes the output file the host made for it, so the same output name can be used again. The host keeps that file open for the length of the run and, when the run ends in anything but success (a failed exit, a cancel, an exception), removes it, but only if the path still names the same file; a finished merge keeps its output. The optional `ensureOutputFile` dependency of `ExecLocalDeps` may now return a function that the handler calls once after the run, with `true` only for a run that settled; an implementation that returns nothing keeps working as before.
