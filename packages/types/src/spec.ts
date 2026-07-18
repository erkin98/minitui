import { z } from 'zod';
import { JsonValueSchema, JsonObjectSchema, guardedRecord } from './pointer.js';

// One event/watch binding: invokes a catalog action by name with JSON-shaped
// params (json-render's ActionBinding vocabulary). STRICT: this is the gated
// SUBSET minitui accepts — spec-supplied `confirm` dialogs and onSuccess/
// onError chains are REJECTED (not silently stripped): consent is host-owned
// (invariant e) and chained actions would dodge the catalog allowlist.
export const ActionBindingSchema = z
  .object({
    action: z.string(),
    params: JsonObjectSchema.optional(),
  })
  .strict()
  .readonly();
export type ActionBinding = z.infer<typeof ActionBindingSchema>;

const BindingOrListSchema = z.union([ActionBindingSchema, z.array(ActionBindingSchema).readonly()]);

// One node of the flat KEYED element map — json-render's keyed-map element
// vocabulary (its `UIElement`): identity IS the map key, so no `key` field
// lives inside the element (json-render's key/parentKey belong only to the
// array-form FlatElement). Actions bind under on[event]/watch (ledger F2);
// there is NO flat `action` field, and no permission text rides on the spec —
// PermissionDescriptor stays on the trusted catalog's MinituiActionDef.
// `visible` is a json-render VisibilityCondition (boolean or condition object,
// JSON-shaped); its operator grammar is validated by @minitui/spec against
// @json-render/core's own schemas.
export const SpecElementSchema = z
  .object({
    type: z.string(),
    props: JsonObjectSchema,
    children: z.array(z.string()).readonly().optional(),
    visible: JsonValueSchema.optional(),
    repeat: z.object({ statePath: z.string(), key: z.string().optional() }).readonly().optional(),
    on: guardedRecord(BindingOrListSchema).optional(),
    watch: guardedRecord(BindingOrListSchema).optional(),
  })
  .readonly();
export type SpecElement = z.infer<typeof SpecElementSchema>;

// The declarative mini-app wire view: a flat key->element map (NOT a nested
// tree). root names the entry element. STATE-FREE (ledger §B7/v7) — the JSON-
// Pointer data model lives on MiniAppSpec, owned by @minitui/spec (plan 07:
// brands json-render's Spec + requires state, ledger G7), and its field is
// `state`, never `data`.
//
// STRIP-BY-DESIGN (ledger §Z105): ActionBinding is the SOLE `.strict()` wire
// schema — an unmodeled key there (`confirm`/`onSuccess`) would dodge the frozen
// catalog allowlist. SpecElement / AppSpec / AgentEvent are ordinary z.object and
// STRIP unknown keys by design (forward-compat wire vocab; dispatch reads only the
// typed on/watch → ActionBinding, so a stray key is inert, not an injection).
export const AppSpecSchema = z
  .object({
    root: z.string(),
    elements: guardedRecord(SpecElementSchema),
  })
  .readonly();
export type AppSpec = z.infer<typeof AppSpecSchema>;
