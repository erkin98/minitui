---
'@minitui/agent-core': patch
'@minitui/catalog': patch
'@minitui/exec': patch
'@minitui/renderer-ink': patch
'@minitui/spec': patch
'@minitui/types': patch
---

zod moves to 4.6.7, which fixes GHSA-mrhx-c7xc-m3w5: parsing an array schema with no length bound could exhaust memory.
