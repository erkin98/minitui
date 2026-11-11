---
'@minitui/runtime-host': minor
---

The host now exports `RENDER_LOCAL_ACTIONS`, the set of actions it lets a renderer run locally (`setState`, `pushState` and `removeState`), and its router refuses any other render-local name by that set. The set is exported so a check outside the package can hold it equal to a renderer's own list; the router's behaviour is unchanged.
