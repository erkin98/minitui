import { z } from 'zod';
import { guardedRecord } from './pointer.js';

export { ActionKindSchema, type ActionKind } from './catalog.js';

// The typed permission contract every non-render-local action carries.
// resourceTemplate/summaryTemplate hold ${/json/pointer} holes resolved by the
// host against state — the agent never supplies the resolved value.
export const PermissionDescriptorSchema = z
  .object({
    danger: z.boolean(),
    resourceTemplate: z.string(),
    summaryTemplate: z.string(),
  })
  .readonly();
export type PermissionDescriptor = z.infer<typeof PermissionDescriptorSchema>;

// What a renderer emits when an interactive widget fires an action.
export const ActionRequestSchema = z
  .object({
    actionName: z.string(),
    elementKey: z.string(),
    // Renderer-emitted params: values stay `unknown` (runtime widget emission,
    // not the agent-authored JsonValue subset), but the KEY routes through the
    // reserved-key guard so hostile container keys are rejected here.
    params: guardedRecord(z.unknown()),
  })
  .readonly();
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ActionResultSchema = z
  .object({
    actionName: z.string(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  })
  .readonly();
export type ActionResult = z.infer<typeof ActionResultSchema>;

// The canonical fault shape for ActionOutcome { status: 'failed'; fault }.
// actionKey identifies the element that ran;
// stderrExcerpt is the sanitized tail of the child's stderr. Sole owner — no
// sibling plan redefines this under {code,detail} or {code,message}.
export const RuntimeFaultSchema = z
  .object({
    actionKey: z.string(),
    exitCode: z.number().int(),
    stderrExcerpt: z.string(),
  })
  .readonly();
export type RuntimeFault = z.infer<typeof RuntimeFaultSchema>;
