import { fileURLToPath } from 'node:url';
import type { MiniAppSpec } from '@minitui/spec';
import { scriptedRun, type ScriptedRun } from '../llm/scripted-run.js';
import type { ScriptedTool } from '../tools/mock-tool-registry.js';

const fixturePath = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

/** Absolute paths of the committed JSON specs, resolved next to this module (the package runs from source). */
export const SPEC_FILES = Object.freeze({
  validMergeBasic: fixturePath('./specs/valid/merge-basic.spec.json'),
  invalidUnknownComponent: fixturePath('./specs/invalid/unknown-component.spec.json'),
  invalidDanglingBinding: fixturePath('./specs/invalid/dangling-binding.spec.json'),
});

/**
 * The canonical "merge two videos" app, typed directly as MiniAppSpec so the compiler checks it against the
 * real contract. The committed valid JSON spec holds the same value (a test compares them). Paths are
 * absolute and the codec is the stream copy, as the real model writes them; the merge action is bound
 * under `on.press` with its parameters read from state, and the status line and the progress bar read the
 * pointers the catalog names for that action.
 */
export const MERGE_SPEC: MiniAppSpec = {
  root: 'screen',
  elements: {
    screen: {
      type: 'Box',
      props: { flexDirection: 'column' },
      children: ['inputs', 'codec', 'merge', 'progress', 'status'],
    },
    inputs: { type: 'OrderList', props: { items: { $bindState: '/inputs' } } },
    codec: {
      type: 'Select',
      props: {
        label: 'Codec',
        value: { $state: '/codec' },
        options: [
          { label: 'Copy (no re-encode)', value: 'copy' },
          { label: 'H.264', value: 'h264' },
        ],
      },
    },
    merge: {
      type: 'Button',
      props: { label: 'Merge' },
      on: {
        press: {
          action: 'merge',
          params: {
            inputs: { $state: '/inputs' },
            codec: { $state: '/codec' },
            output: { $state: '/output' },
          },
        },
      },
    },
    progress: { type: 'ProgressBar', props: { progress: { $state: '/merge/progress' } } },
    status: { type: 'Text', props: { text: { $state: '/merge/status' } } },
  },
  state: {
    inputs: ['/videos/a.mp4', '/videos/b.mp4'],
    codec: 'copy',
    output: '/videos/out.mp4',
    merge: { progress: 0, status: '' },
  },
};

// One JSON Pointer token: `~` and `/` escaped as RFC 6901 says.
const token = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * A spec as the model writes it for the validation loop: one JSON patch line each for the root, every
 * element and the state.
 */
export function specPatchText(spec: MiniAppSpec): string {
  const lines = [
    { op: 'add', path: '/root', value: spec.root },
    ...Object.entries(spec.elements).map(([key, value]) => ({
      op: 'add',
      path: `/elements/${token(key)}`,
      value,
    })),
    { op: 'add', path: '/state', value: spec.state },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** The model's reply as the cli receives it: the spec as patch text, then a finish. No tool call. */
export const MERGE_RUN: ScriptedRun = scriptedRun().text(specPatchText(MERGE_SPEC)).finish('stop');

export const MERGE_TOOL_OK: ScriptedTool = {
  kind: 'exec-local',
  lifecycle: [
    { phase: 'started' },
    { phase: 'progress', progress: 0.5, message: 'merging' },
    { phase: 'progress', progress: 1, message: 'finalizing' },
    { phase: 'result', outcome: { exitCode: 0, stdout: 'out.mp4', kind: 'exec-local' } },
  ],
};

export const MERGE_TOOL_FAIL: ScriptedTool = {
  kind: 'exec-local',
  lifecycle: [
    { phase: 'started' },
    {
      phase: 'error',
      outcome: { exitCode: 1, stderr: 'Unknown encoder h265', kind: 'exec-local' },
    },
  ],
};
