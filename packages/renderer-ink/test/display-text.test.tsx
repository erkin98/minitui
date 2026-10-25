import { describe, expect, it } from 'vitest';
import { sanitize } from '@minitui/sanitizer';
import type { MinituiCatalog } from '@minitui/catalog';
import type { AppSpec } from '@minitui/types';
import type { ActionDispatcher } from '@minitui/renderer-core';
import { mountInk } from '../src/mount.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import { displayProps, displayText } from '../src/widgets/display-text.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { makeController } from './support/controllers.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';
import { afterEffects, awaitFocusOn, lastOf, until } from './support/focus-waits.js';

// The characters under test, built from code points so this file holds no invisible bytes.
const RLO = String.fromCharCode(0x202e); // right-to-left override
const LRI = String.fromCharCode(0x2066); // left-to-right isolate
const ZWSP = String.fromCharCode(0x200b); // zero-width space
const BOM = String.fromCharCode(0xfeff); // byte order mark
const TAG_A = String.fromCodePoint(0xe0041); // a tag character
const ZWNJ = String.fromCharCode(0x200c);
const ZWJ = String.fromCharCode(0x200d);
const LRM = String.fromCharCode(0x200e);
const RLM = String.fromCharCode(0x200f);
const NBSP = String.fromCharCode(0xa0);
const HEART = String.fromCharCode(0x2764, 0xfe0f); // a heart with a variation selector

const catalog = makeCatalog({
  id: 'display',
  components: {
    Box: { trustTier: 'display' },
    Text: { trustTier: 'display' },
    KeyValue: { trustTier: 'display' },
    Select: { trustTier: 'interactive' },
    Button: { trustTier: 'interactive' },
    FilePicker: { trustTier: 'interactive', capturesText: true },
    OrderList: { trustTier: 'interactive' },
  },
});
const ok: ActionDispatcher = { dispatch: async () => ({ status: 'settled' as const }) };

function mountApp(spec: AppSpec, state: Record<string, unknown>, using: MinituiCatalog = catalog) {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const store = controlledIo(state);
  const handle = mountInk({
    spec,
    catalog: using,
    binding: createInkBinding(using),
    dispatcher: ok,
    store,
    consent: makeController([]),
    io: { stdin: asReadStream(stdin), stdout: asWriteStream(stdout), debug: true },
  });
  return { handle, stdin, store, frame: lastOf(stdout) };
}

describe('displayText and displayProps', () => {
  it('removes CR and the format characters, and keeps LF, TAB and ordinary text', () => {
    const dirty = `a\rb${ZWSP}c${RLO}d${BOM}e${TAG_A}f${LRI}g`;
    expect(displayText(dirty)).toBe('abcdefg');
    const plain = `a\nb\tc${NBSP}d${HEART}`;
    expect(displayText(plain)).toBe(plain);
  });

  it('keeps the four joining and direction marks', () => {
    const kept = `a${ZWNJ}b${ZWJ}c${LRM}d${RLM}e`;
    expect(displayText(kept)).toBe(kept);
  });

  it('strips a value only when the component does not write it back', () => {
    const props = {
      label: 'x\r',
      options: [{ label: `o${ZWSP}`, value: `v${ZWSP}` }],
      value: 'r\r',
    };
    expect(displayProps(props, true)).toEqual({
      label: 'x',
      options: [{ label: 'o', value: `v${ZWSP}` }],
      value: 'r\r',
    });
    expect(displayProps({ value: `x${RLO}`, options: [{ value: `y${ZWSP}` }] }, false)).toEqual({
      value: 'x',
      options: [{ value: 'y' }],
    });
  });
});

describe('what the app frame draws', () => {
  it('a Button label with a carriage return draws without it', async () => {
    const spec: AppSpec = {
      root: 'b',
      elements: { b: { type: 'Button', props: { label: 'Merge 2 files\rDELETE ALL' } } },
    };
    const { handle, frame } = mountApp(spec, {});
    await until(() => frame().includes('Merge 2 files'), 'the label');
    expect(frame()).toContain('Merge 2 filesDELETE ALL');
    expect(frame()).not.toContain('\r');
    handle.unmount();
  });

  it('bound text in an adopted Text draws without format characters', async () => {
    const spec: AppSpec = {
      root: 't',
      elements: { t: { type: 'Text', props: { text: { $state: '/t' } } } },
    };
    const { handle, frame } = mountApp(spec, { t: `abc${RLO}def` });
    await until(() => frame().includes('abc'), 'the text');
    expect(frame()).toContain('abcdef');
    expect(frame()).not.toContain(RLO);
    handle.unmount();
  });

  it('an adopted KeyValue draws its value stripped', async () => {
    const spec: AppSpec = {
      root: 'k',
      elements: { k: { type: 'KeyValue', props: { label: 'k', value: { $state: '/v' } } } },
    };
    const { handle, frame } = mountApp(spec, { v: `ab${RLO}cd` });
    await until(() => frame().includes('ab'), 'the value');
    expect(frame()).toContain('abcd');
    expect(frame()).not.toContain(RLO);
    handle.unmount();
  });

  it('an adopted Select draws its option labels stripped and writes the raw value back', async () => {
    const spec: AppSpec = {
      root: 's',
      elements: {
        s: {
          type: 'Select',
          props: {
            label: 'pick',
            options: [
              { label: `one${ZWSP}`, value: `v${ZWSP}1` },
              { label: 'two', value: 'v2' },
            ],
            value: { $bindState: '/sel' },
          },
        },
      },
    };
    const { handle, stdin, store, frame } = mountApp(spec, { sel: '' });
    // the Select draws no focus marker to wait on, so the label is the first wait and Enter is then
    // repeated until its effect shows: Enter stores the highlighted option, the same value every time
    await until(() => frame().includes('one'), 'the option label');
    expect(frame()).toContain('one');
    expect(frame()).not.toContain(ZWSP);
    await until(() => {
      stdin.write('\r');
      return store.getSnapshot().sel !== '';
    }, 'the selection');
    expect(store.getSnapshot().sel).toBe(`v${ZWSP}1`);
    handle.unmount();
  });

  it('a FilePicker draws its value stripped and writes the raw text back', async () => {
    const spec: AppSpec = {
      root: 'f',
      elements: {
        f: { type: 'FilePicker', props: { label: 'out', value: { $bindState: '/out' } } },
      },
    };
    const { handle, stdin, store, frame } = mountApp(spec, { out: 'a\rb' });
    await awaitFocusOn(frame, 'out');
    expect(sanitize(frame())).toContain('> ab');
    stdin.write('x');
    await until(() => sanitize(frame()).includes('> abx'), 'the typed draft');
    await afterEffects();
    stdin.write('\r');
    await until(() => store.getSnapshot().out !== 'a\rb', 'the write-back');
    expect(store.getSnapshot().out).toBe('a\rbx');
    handle.unmount();
  });

  it('an OrderList draws items stripped and reorders the raw items', async () => {
    const spec: AppSpec = {
      root: 'o',
      elements: { o: { type: 'OrderList', props: { items: { $bindState: '/inputs' } } } },
    };
    const { handle, stdin, store, frame } = mountApp(spec, { inputs: ['x\r1', 'y'] });
    await awaitFocusOn(frame, '1.');
    expect(frame()).toContain('1. x1');
    expect(frame()).not.toContain('\r');
    stdin.write('\x1B[1;2B'); // shift+down
    await until(() => reordered(store), 'the reorder');
    expect(store.getSnapshot().inputs).toEqual(['y', 'x\r1']);
    handle.unmount();
  });
});

// the OrderList row waits for the stored order to change from the seed
function reordered(store: { getSnapshot: () => Record<string, unknown> }): boolean {
  const inputs = store.getSnapshot().inputs;
  return Array.isArray(inputs) && inputs[0] !== 'x\r1';
}
