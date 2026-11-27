---
'@minitui/renderer-ink': patch
---

The line under the app for a refused or failed action keeps its lead, `Action "<name>" did not complete:`, on one line and shows the end of the reason, cut from the front with `…` to the width that is left, so the cause reads first rather than a tool's banner.
