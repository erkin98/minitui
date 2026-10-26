---
'@minitui/transport': minor
---

Patch and pointer errors are fixed strings that carry no document text, including the messages for a failed `test` operation, an engine rejection and a store schema rejection (`value is not canonical JSON`). The public state folds reject a value that is not canonical JSON (a `Date`, an accessor object, an own `__proto__` key) before sanitising it, and the store then keeps its state and reports one diagnostic. Events without a visibility class stay local. Diagnostics sinks that throw or reject are contained at every call site, and the remote pump reports one diagnostic per stall episode instead of one per eviction. A subscriber removed during delivery is not called in that commit. The package now declares its licence, Apache-2.0.
