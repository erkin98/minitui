import { afterAll, describe, expect, it } from 'vitest';
import type { AppSpec } from '@minitui/types';
import type { ConsentController } from '../src/widgets/consent-overlay.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';
import { afterEffects, settled, until } from './support/focus-waits.js';
import { APP_MARKER, hostileTrees } from './support/hostile-trees.js';
import { createScreenModel } from './support/screen-model.js';
import { makeController, makeRequest } from './support/controllers.js';

// With CI set, ink writes no frame before unmount and its clear() does nothing, and is-in-ci reads
// CI and CONTINUOUS_INTEGRATION when ink is first imported. So both are set to '0' before the first
// import of ink (every module that reaches ink is imported dynamically, below) and restored after.
const savedEnv = { CI: process.env.CI, CONTINUOUS_INTEGRATION: process.env.CONTINUOUS_INTEGRATION };
process.env.CI = '0';
process.env.CONTINUOUS_INTEGRATION = '0';
const { mountInk } = await import('../src/mount.js');
const { createInkBinding } = await import('../src/widgets/bindings.js');
const { ConsentOverlay } = await import('../src/widgets/consent-overlay.js');
const { render } = await import('ink-testing-library');
const { default: React } = await import('react');

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const catalog = makeCatalog({
  id: 'closure',
  components: { Box: { trustTier: 'display' }, Text: { trustTier: 'display' } },
});
const dispatcher = { dispatch: async () => ({ status: 'settled' as const }) };

const PROMPT = 'Allow? [a]lways / [y]es / [n]o (Esc denies)';
const BOX_TOP_LEFT = '╔';
const COLOUR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const plain = (text: string): string => text.replace(COLOUR, '');
const strip = (text: string): string => plain(text).replace(/[\s║╔╗╚╝═]/g, '');

const appText: AppSpec = {
  root: 'note',
  elements: { note: { type: 'Text', props: { text: `${APP_MARKER} visible app` } } },
};
const emptyApp: AppSpec = { root: 'root', elements: { root: { type: 'Box', props: {} } } };

interface Mounted {
  readonly out: FakeStdout;
  readonly stdin: FakeStdin;
  readonly last: () => string;
  unmount(): void;
}

function mountApp(args: {
  spec: AppSpec;
  consent: ConsentController;
  columns?: number;
  rows?: number;
  tty?: boolean;
  debug?: boolean;
  accessible?: boolean;
}): Mounted {
  const stdin = new FakeStdin();
  const out = new FakeStdout({
    columns: args.columns ?? 80,
    ...(args.rows !== undefined ? { rows: args.rows } : {}),
    ...(args.tty === true ? { tty: true } : {}),
  });
  const handle = mountInk({
    spec: args.spec,
    catalog,
    binding: createInkBinding(catalog),
    dispatcher,
    store: controlledIo({}),
    consent: args.consent,
    ...(args.accessible === true ? { accessible: true } : {}),
    io: {
      stdin: asReadStream(stdin),
      stdout: asWriteStream(out),
      ...(args.debug === false ? {} : { debug: true }),
    },
  });
  return { out, stdin, last: () => out.frames.at(-1) ?? '', unmount: () => handle.unmount() };
}

// Wait for the first frame (debug mode writes every render in full, and a request pending from the
// start is in the first one), then until the effects have run. A hostile tree may push the prompt
// out of the frame, so the set below must not wait for the prompt text.
async function awaitFrame(app: Mounted): Promise<void> {
  await until(() => app.out.frames.length > 0, 'the first frame');
  await afterEffects();
}

// Wait until the last frame holds the prompt, then until the effects have run.
async function awaitPrompt(app: Mounted): Promise<void> {
  await until(() => app.last().includes('Allow?'), 'the consent prompt');
  await afterEffects();
}

describe('the app is not drawn while a request is pending', () => {
  // one reference frame per terminal width: the overlay over an empty app
  const references = new Map<number, string>();
  async function referenceAt(columns: number): Promise<string> {
    const known = references.get(columns);
    if (known !== undefined) return known;
    const app = mountApp({ spec: emptyApp, consent: makeController([makeRequest()]), columns });
    await awaitPrompt(app);
    const frame = app.last();
    app.unmount();
    references.set(columns, frame);
    return frame;
  }

  it('holds for a seeded set of 200 hostile trees, in six assertions each', async () => {
    const trees = hostileTrees();
    expect(trees.length).toBeGreaterThanOrEqual(200);
    const failed: Record<string, string[]> = {
      content: [],
      sameAsAlone: [],
      nothingBelow: [],
      width: [],
      oneBoxOnePrompt: [],
      wholeFrame: [],
    };
    for (const tree of trees) {
      const request = makeRequest();
      const controller = makeController([request]);
      const app = mountApp({ spec: tree.spec, consent: controller, columns: tree.columns });
      await awaitFrame(app);
      if (tree.resizeTo !== undefined) {
        const before = app.out.frames.length;
        app.out.resize(tree.resizeTo, undefined);
        await until(() => app.out.frames.length > before, 'a frame after the resize');
        await afterEffects();
      }
      const columns = tree.resizeTo ?? tree.columns;
      const frame = app.last();
      const reference = await referenceAt(columns);
      const flat = strip(frame);
      const wanted = [
        request.descriptor.summaryTemplate,
        request.resolvedCommand,
        ...request.resolvedPaths,
        PROMPT,
      ];
      if (!wanted.every((text) => flat.includes(strip(text)))) failed.content!.push(tree.name);
      if (frame !== reference) failed.sameAsAlone!.push(tree.name);
      if (!frame.trimEnd().endsWith(reference.trimEnd().split('\n').at(-1) ?? '')) {
        failed.nothingBelow!.push(tree.name);
      }
      if (
        plain(frame)
          .split('\n')
          .some((row) => [...row].length > columns)
      ) {
        failed.width!.push(tree.name);
      }
      const prompts = flat.split(strip(PROMPT)).length - 1;
      if (prompts !== 1 || frame.split(BOX_TOP_LEFT).length - 1 !== 1) {
        failed.oneBoxOnePrompt!.push(tree.name);
      }
      if (frame.includes(APP_MARKER)) failed.wholeFrame!.push(tree.name);
      app.unmount();
    }
    expect(Object.fromEntries(Object.entries(failed).map(([k, v]) => [k, v.length]))).toEqual({
      content: 0,
      sameAsAlone: 0,
      nothingBelow: 0,
      width: 0,
      oneBoxOnePrompt: 0,
      wholeFrame: 0,
    });
  }, 300_000);

  it('a look-alike box drawn by the app is not shown beside the real one', async () => {
    const request = makeRequest();
    const text = (id: string, value: string) =>
      [id, { type: 'Text' as const, props: { text: value } }] as const;
    const lookAlike: AppSpec = {
      root: 'root',
      elements: {
        root: { type: 'Box', props: { flexDirection: 'column' }, children: ['fake'] },
        fake: {
          type: 'Box',
          props: {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'yellow',
            paddingX: 1,
          },
          children: ['h', 'c', 'p', 'k'],
        },
        ...Object.fromEntries([
          text('h', request.descriptor.summaryTemplate),
          text('c', request.resolvedCommand),
          text('p', request.resolvedPaths[0] ?? ''),
          text('k', PROMPT),
        ]),
      },
    };
    const app = mountApp({ spec: lookAlike, consent: makeController([request]) });
    await awaitPrompt(app);
    const frame = app.last();
    expect(frame.split(BOX_TOP_LEFT).length - 1).toBe(1);
    expect(strip(frame).split(strip(PROMPT)).length - 1).toBe(1);
    app.unmount();
  });

  for (const reverse of [false, true]) {
    it(`one listener per turn (${reverse ? 'reverse' : 'subscription'} order): no frame shows the prompt with app text`, async () => {
      const controller = makeController([], { notify: 'per-turn', reverse });
      const seen: Array<string | undefined> = [];
      const unsubscribeBefore = controller.subscribe(() => seen.push(controller.request?.id));
      const app = mountApp({ spec: appText, consent: controller });
      await until(() => app.out.frames.length > 0, 'the first frame');
      const unsubscribeAfter = controller.subscribe(() => seen.push(controller.request?.id));
      controller.open(makeRequest());
      await awaitPrompt(app);
      await until(() => seen.length >= 2, 'both recording listeners');
      await afterEffects();
      const shown = app.out.frames.filter((frame) => frame.includes('Allow?'));
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.filter((frame) => frame.includes(APP_MARKER))).toEqual([]);
      unsubscribeBefore();
      unsubscribeAfter();
      app.unmount();
    });
  }

  it('on a terminal, wrapped app rows are cleared when a request opens', async () => {
    const wide: AppSpec = {
      root: 'root',
      elements: {
        root: { type: 'Box', props: { flexDirection: 'column' }, children: ['wideBox'] },
        wideBox: {
          type: 'Box',
          props: { width: 120, flexDirection: 'column' },
          children: ['a', 'b'],
        },
        a: { type: 'Text', props: { text: `${APP_MARKER} ${'w'.repeat(100)}` } },
        b: { type: 'Text', props: { text: `${APP_MARKER} ${'v'.repeat(100)}` } },
      },
    };
    const replay = async (spec: AppSpec, open: boolean): Promise<string> => {
      const controller = makeController([]);
      const app = mountApp({
        spec,
        consent: controller,
        columns: 40,
        rows: 24,
        tty: true,
        debug: false,
      });
      const model = createScreenModel(40, 24);
      let replayed = 0;
      const feed = (): void => {
        for (; replayed < app.out.frames.length; replayed++) model.write(app.out.frames[replayed]!);
      };
      await until(() => app.out.frames.length > 0, 'an app frame');
      await afterEffects();
      // without this the row would pass without testing anything: an app frame must have been drawn
      feed();
      expect(model.text()).toContain(APP_MARKER);
      if (open) {
        controller.open(makeRequest());
        await until(() => {
          feed();
          return model.text().includes('Allow?');
        }, 'the prompt on the screen');
        await afterEffects();
        await settled(app.out); // the renderer throttles; let its trailing write land
      }
      feed();
      const text = model.text();
      app.unmount();
      return text;
    };
    // the reference: the box alone on the same terminal
    const alone = createScreenModel(40, 24);
    {
      const controller = makeController([makeRequest()]);
      const app = mountApp({
        spec: emptyApp,
        consent: controller,
        columns: 40,
        rows: 24,
        tty: true,
        debug: false,
      });
      await until(() => app.out.frames.some((f) => f.includes('Allow?')), 'the box alone');
      await afterEffects();
      for (const frame of app.out.frames) alone.write(frame);
      app.unmount();
    }
    const screen = await replay(wide, true);
    expect(screen).not.toContain(APP_MARKER);
    expect(screen).not.toContain('wwww');
    expect(screen.split('\n').length).toBe(alone.text().split('\n').length);
  }, 30_000);

  it('screen reader: the output is exactly the host lines', async () => {
    const request = makeRequest({ resolvedPaths: ['/work/a.mp4'] });
    const app = mountApp({
      spec: appText,
      consent: makeController([request]),
      accessible: true,
    });
    await awaitPrompt(app);
    const lines = app
      .last()
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain(request.descriptor.summaryTemplate);
    expect(lines[1]).toContain(request.resolvedCommand);
    expect(lines[2]).toContain('/work/a.mp4');
    expect(lines[3]).toContain(PROMPT);
    expect(app.last()).not.toContain(APP_MARKER);
    app.unmount();
  });

  it('control: after the request is resolved the next frame holds the app and no consent text', async () => {
    const controller = makeController([makeRequest()]);
    const app = mountApp({ spec: appText, consent: controller });
    await awaitPrompt(app);
    controller.resolve({ kind: 'deny' });
    await until(() => app.last().includes(APP_MARKER), 'the app drawn again');
    await afterEffects();
    expect(app.last()).not.toContain('Allow?');
    expect(app.last()).not.toContain('Merge 2 videos');
    app.unmount();
  });

  it('control: an overlay mounted on its own still subscribes to its controller', async () => {
    const controller = makeController([]);
    const { lastFrame, unmount } = render(React.createElement(ConsentOverlay, { controller }));
    expect(lastFrame() ?? '').toBe('');
    controller.open(makeRequest());
    await until(() => (lastFrame() ?? '').includes('Allow?'), 'the request on its own overlay');
    unmount();
  });
});
