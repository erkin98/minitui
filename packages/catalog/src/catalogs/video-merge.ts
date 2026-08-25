import { z } from 'zod';
import { defineMinituiCatalog, type MinituiCatalog } from '../define-catalog.js';
import {
  standardComponentDefinitions,
  standardActionDefinitions,
  type ActionDefinition,
} from '../schema-bridge.js';
import { defineComponent } from '../contract/catalog-component.js';
import { defineAction } from '../contract/catalog-action.js';

// Re-tag a std json-render ComponentDefinition with a minitui trust tier. Every
// std def pulled into this Slice-1 catalog (Box/Select/ProgressBar/Text) is
// non-free-text, so capturesText is false — the app-shell `q` quits while one is
// focused. A future std TextInput would pass capturesText:true.
function tag(
  name: keyof typeof standardComponentDefinitions,
  trustTier: 'display' | 'interactive',
  capturesText = false,
) {
  return defineComponent({ ...standardComponentDefinitions[name], trustTier, capturesText });
}
// Re-tag a std action as render-local (the STATE trio only). Takes the def directly
// (not a key) so params stays one concrete type — indexing standardActionDefinitions
// by a generic key widens it to all five std actions and breaks defineAction's inference.
function localAction(def: ActionDefinition) {
  return defineAction({ ...def, kind: 'render-local' as const });
}

/**
 * Slice-1 video-merge catalog. FilePicker + OrderList + Button are CUSTOM
 * components (json-render's 27 std Ink defs ship no file picker, no reorderable
 * list, and NO Button — the interactive std defs are TextInput/Select/MultiSelect/
 * ConfirmInput). Their props zod is the same source renderer-ink resolves the widget
 * factory against, so the allowlist and prompt include them. Box/Select/ProgressBar/
 * Text ARE std — pulled from standardComponentDefinitions via tag() (the spread
 * carries the required `slots`). Text renders the /merge/status line the exec→store
 * bridge writes.
 */
export const videoMergeCatalog: MinituiCatalog = defineMinituiCatalog({
  id: 'video-merge',
  components: {
    Box: tag('Box', 'display'),
    Select: tag('Select', 'interactive'),
    ProgressBar: tag('ProgressBar', 'display'),
    Text: tag('Text', 'display'),
    // Custom widgets (not in json-render's 27 std defs):
    Button: defineComponent({
      props: z.object({ label: z.string() }).strict(),
      slots: [],
      description: 'Press-to-run trigger that fires its bound action (no std Ink Button).',
      trustTier: 'interactive',
      capturesText: false, // Enter/Space activates — never consumes typed text
    }),
    FilePicker: defineComponent({
      props: z
        .object({
          value: z.string(), // the picked path; bind with $bindState so the choice writes back
          label: z.string().optional(),
          mode: z.enum(['file', 'dir']).optional(), // omitted => any
        })
        .strict(),
      slots: [],
      description: 'Select a file/dir; the chosen path writes back through its bound value.',
      trustTier: 'interactive',
      // Free-text path entry: the focused widget appends typed characters to build
      // the path draft, so `q` must stay literal while it is focused — the app-shell
      // q-predicate reads this bit.
      capturesText: true,
    }),
    OrderList: defineComponent({
      props: z
        .object({
          items: z.array(z.string()), // the array being reordered; bind with $bindState so the new order writes back
        })
        .strict(),
      slots: [],
      description:
        'Reorderable list — move items to set merge order; the new order writes back through its bound items.',
      trustTier: 'interactive',
      capturesText: false, // arrow-key reordering — no free-text entry
    }),
  },
  actions: {
    // The STATE trio (render-local STATE-only allowlist).
    setState: localAction(standardActionDefinitions.setState),
    pushState: localAction(standardActionDefinitions.pushState),
    removeState: localAction(standardActionDefinitions.removeState),
    // The one dangerous discrete action. The merge params ARE the typed slots the
    // exec-local gate consumes. inputs[] and output are PATH slots (validated
    // absolute + control-free, surfaced as resolved paths); codec is a SCALAR slot
    // (injection-checked, never treated as a filesystem path). The host derives BOTH
    // the consent command and the spawn argv from one resolved execution plan — it
    // does not treat the raw template as a path, so the codec scalar never trips the
    // absolute-path check. Consent surfaces EVERY input, not just the template holes.
    merge: defineAction({
      params: z.object({
        inputs: z.array(z.string()).min(2), // PATH slots: each becomes a resolved path
        codec: z.string(), //                  SCALAR slot: injection-checked, never a resolved path
        output: z.string(), //                 PATH slot: becomes a resolved path
      }),
      description: 'Merge the ordered input videos into one file with ffmpeg.',
      kind: 'exec-local',
      permission: {
        danger: true,
        // Model-facing display shape plus the generation-time hole-resolution check —
        // NOT the gate's argv source: the host builds the authoritative host-resolved
        // consent + argv from the typed slots above.
        resourceTemplate: 'ffmpeg -i ${/inputs/0} -i ${/inputs/1} -c:v ${/codec} ${/output}',
        summaryTemplate: 'Merge the selected videos into ${/output} using ${/codec}',
      },
      // Builder-owned: the dangerous action is user-driven only — the agent cannot
      // auto-fire it (an agent-widen to remoteOnly is rejected by the visibility
      // check). Every other component defaults to the clientOnly field-visibility class.
      callableFrom: 'clientOnly',
    }),
  },
});
