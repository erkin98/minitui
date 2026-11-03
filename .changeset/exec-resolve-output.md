---
'@minitui/exec': minor
---

A merge whose output sits under a linked directory is now shown for approval, planned, created and run at the real path of that directory. The router takes the real path of the output's directory before the permission gate, after the spelling it was given has passed the path rules and the hard floor, so the consent text, the engine's floor, the host-side create and the command all name one path, and a path refused by its linked spelling stays refused. A directory that cannot be resolved (missing, not a directory, a link loop, not searchable) is refused before the prompt with one fixed message. Operator rules and saved exact grants are matched against the real path, so a rule or grant written against a linked spelling no longer matches, and an argument-shape check on the ffmpeg command is judged on the path ffmpeg receives. The consent text and the result of a settled merge now carry the real path.
