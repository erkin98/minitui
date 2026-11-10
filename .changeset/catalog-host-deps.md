---
'@minitui/catalog': minor
---

The catalog now exports the lookups a runtime host needs from it: `hostCatalogDeps(catalog)` returns the parameter check, who may call an action, its kind and its permission descriptor, and `checkActionParams` is the parameter check on its own, with its input type `ParamsCatalog`. The parameter check is strict: the action's schema must be an object schema, accept the parameters, and own every key, so a key a renderer added is refused even though a plain parse of the schema would drop it and pass. These moved here from the `minitui` command, which now imports them, so every host built over the catalog uses the same check.
