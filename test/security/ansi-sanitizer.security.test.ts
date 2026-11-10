import { videoMergeCatalog } from '@minitui/catalog';
import { createInkBinding } from '@minitui/renderer-ink';
import { composeValidation, type CapabilityProvider, type MiniAppSpec } from '@minitui/spec';
import { MERGE_SPEC, mountHeadless, specPatchText } from '@minitui/test-kit';
import { describe, expect, it } from 'vitest';

// Terminal control sequences in the model's text never reach the terminal: the spec goes from the model's
// patch text through the real validation loop, then mounts through the real Ink renderer, and the frame
// carries none of the sequences. The frame does carry the renderer's own styling (the focused button is
// drawn in inverse video), so the rows look for the injected sequences by name, never for any escape.
// Ink drops cursor and screen sequences by itself but keeps OSC and colour or style sequences, so the
// clipboard write and the blink are the payloads only minitui's own strip removes.
const ESC = '\u001b';
const BEL = '\u0007';
const CLIPBOARD_WRITE = `${ESC}]52;c;aGk=${BEL}`;
const CLEAR_SCREEN = `${ESC}[2J`;
const PASTE_START = `${ESC}[200~`;
const BLINK = `${ESC}[5m`;

const capabilities: CapabilityProvider = {
  listCodecs: () => Promise.resolve(['h264']),
  listEncoders: () => Promise.resolve(['libx264']),
  listFilters: () => Promise.resolve(['concat']),
  statFile: () => Promise.resolve({ exists: true, readable: true, isFile: true }),
};

async function* once(text: string): AsyncGenerator<string> {
  yield text;
}

async function* neverAsked(): AsyncGenerator<string> {
  yield* [];
  throw new Error('the loop asked for a regeneration');
}

const mergeButton = MERGE_SPEC.elements.merge;
if (mergeButton === undefined) throw new Error('the merge fixture has no merge button');

const injected: MiniAppSpec = {
  ...MERGE_SPEC,
  elements: {
    ...MERGE_SPEC.elements,
    screen: {
      type: 'Box',
      props: { flexDirection: 'column' },
      children: ['note', 'inputs', 'codec', 'merge', 'progress', 'status'],
    },
    note: {
      type: 'Text',
      props: {
        text: `Ready${CLIPBOARD_WRITE} now${CLEAR_SCREEN} then${PASTE_START}pasted${BLINK}!`,
      },
    },
    merge: { ...mergeButton, props: { label: `Merge${CLEAR_SCREEN}${BLINK}` } },
  },
};

describe('escape sequences from the model never reach the frame', () => {
  it('the validated app mounts with the visible text and none of the injected sequences', async () => {
    const result = await composeValidation({
      stream: once(specPatchText(injected)),
      catalog: videoMergeCatalog,
      capabilities,
      regenerate: () => neverAsked(),
    });
    if (!result.ok) throw new Error('the loop refused the app');
    const host = await mountHeadless({
      spec: result.spec,
      catalog: videoMergeCatalog,
      binding: createInkBinding(videoMergeCatalog),
    });
    try {
      await host.waitFor(() => host.frame().includes('Ready'), 'the note');
      const frame = host.frame();
      expect(frame).toContain('Ready');
      expect(frame).toContain('pasted');
      expect(frame).toContain('Merge');
      for (const sequence of [CLIPBOARD_WRITE, ']52;', CLEAR_SCREEN, PASTE_START, BLINK]) {
        expect(frame).not.toContain(sequence);
      }
      expect(host.frames().join('')).not.toContain(']52;');
      expect(host.frames().join('')).not.toContain(BLINK);
    } finally {
      host.unmount();
    }
  });
});
