import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ConsentOverlay } from '../src/widgets/consent-overlay.js';
import { mountInk } from '../src/mount.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import { afterEffects, until } from './support/focus-waits.js';
import { makeController, makeRequest } from './support/controllers.js';
import { makeCatalog } from './support/make-catalog.js';
import { controlledIo } from './support/store-io.js';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream } from './support/fake-streams.js';

const REPLACEMENT = String.fromCodePoint(0xfffd);
const cp = (code: number): string => String.fromCodePoint(code);

// One member of the consent-forbidden class of each kind the overlay must show as the mark.
const members: Array<[string, string]> = [
  ['CR', '\r'],
  ['TAB', '\t'],
  ['LF', '\n'],
  ['DEL', cp(0x7f)],
  ['U+0085', cp(0x85)],
  ['U+202E', cp(0x202e)],
  ['U+FEFF', cp(0xfeff)],
  ['U+200C', cp(0x200c)],
  ['U+200D', cp(0x200d)],
  ['U+E000', cp(0xe000)],
  ['U+3164', cp(0x3164)],
  ['U+2800', cp(0x2800)],
];

const frameOf = (request: ReturnType<typeof makeRequest>): string => {
  const { lastFrame, unmount } = render(<ConsentOverlay controller={makeController([request])} />);
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
};

const headline = (middle: string) =>
  makeRequest({
    descriptor: {
      danger: false,
      resourceTemplate: 'ffmpeg',
      summaryTemplate: `Merge ${middle} clips`,
    },
  });
const command = (middle: string) =>
  makeRequest({ resolvedCommand: `ffmpeg -i a${middle}b.mp4 out.mp4` });
const path = (middle: string) => makeRequest({ resolvedPaths: [`/work/a${middle}b.mp4`] });

const strings: Array<[string, (middle: string) => ReturnType<typeof makeRequest>, string]> = [
  ['the headline', headline, `Merge ${REPLACEMENT} clips`],
  ['the command', command, `ffmpeg -i a${REPLACEMENT}b.mp4 out.mp4`],
  ['a path', path, `/work/a${REPLACEMENT}b.mp4`],
];

describe('the display rule', () => {
  for (const [where, build, shown] of strings) {
    it.each(members)(
      `${where}: %s is shown as U+FFFD, in the same number of rows`,
      (_name, char) => {
        const frame = frameOf(build(char));
        expect(frame).toContain(shown);
        // LF is the row separator of every frame; the row count below is what shows it was replaced
        if (char !== '\n') expect(frame).not.toContain(char);
        expect(frame.split('\n').length).toBe(frameOf(build('x')).split('\n').length);
      },
    );
  }

  it('two paths that differ only by U+0085 render differently', () => {
    const withControl = frameOf(makeRequest({ resolvedPaths: [`a${cp(0x85)}b`] }));
    const without = frameOf(makeRequest({ resolvedPaths: ['ab'] }));
    expect(withControl).not.toBe(without);
  });

  it('control: ordinary non-ASCII text and U+FFFD itself are shown unchanged', () => {
    const han = cp(0x6f22) + cp(0x5b57);
    const frame = frameOf(makeRequest({ resolvedPaths: [`/work/${han}${REPLACEMENT}.mp4`] }));
    expect(frame).toContain(`/work/${han}${REPLACEMENT}.mp4`);
  });
});

describe('request identity', () => {
  it('after a request that lists a path twice, the next request shows only its own rows', async () => {
    const first = makeRequest({ resolvedPaths: ['/work/dup.mp4', '/work/dup.mp4'] });
    const second = makeRequest({ resolvedPaths: ['/work/only.mp4'] });
    const controller = makeController([first, second]);
    const { lastFrame, unmount } = render(<ConsentOverlay controller={controller} />);
    expect(lastFrame() ?? '').toContain('/work/dup.mp4');
    controller.resolve({ kind: 'deny' });
    await until(() => (lastFrame() ?? '').includes('/work/only.mp4'), 'the second request');
    await afterEffects();
    expect(lastFrame() ?? '').not.toContain('/work/dup.mp4');
    unmount();
  });

  it('two decision keys in one tick resolve the request on screen and no other', async () => {
    const first = makeRequest();
    const second = makeRequest();
    const controller = makeController([first, second]);
    const { stdin, unmount } = render(<ConsentOverlay controller={controller} />);
    await afterEffects();
    stdin.write('y');
    stdin.write('y');
    await afterEffects();
    expect(controller.decisions).toEqual([{ kind: 'allow' }]);
    expect(controller.request?.id).toBe(second.id);
    unmount();
  });
});

// ---- the fit rule ----

const fitCatalog = makeCatalog({
  id: 'fit',
  components: { Box: { trustTier: 'display' } },
});
const emptyApp = { root: 'r', elements: { r: { type: 'Box' as const, props: {} } } };

// 22 one-row paths, a one-row command and a one-row headline: the uncut box is 30 rows
const tallRequest = () =>
  makeRequest({
    descriptor: { danger: false, resourceTemplate: 'ffmpeg', summaryTemplate: 'Merge many clips' },
    resolvedCommand: 'ffmpeg -i list.txt out.mp4',
    resolvedPaths: Array.from({ length: 22 }, (_, i) => `/work/clip-${i}.mp4`),
  });

function mountFit(args: {
  request?: ReturnType<typeof makeRequest>;
  rows: number | undefined;
  columns?: number;
}) {
  const controller = makeController(args.request === undefined ? [] : [args.request]);
  const stdin = new FakeStdin();
  const out = new FakeStdout({
    columns: args.columns ?? 80,
    ...(args.rows !== undefined ? { rows: args.rows } : {}),
  });
  const handle = mountInk({
    spec: emptyApp,
    catalog: fitCatalog,
    binding: createInkBinding(fitCatalog),
    dispatcher: { dispatch: async () => ({ status: 'settled' as const }) },
    store: controlledIo({}),
    consent: controller,
    io: { stdin: asReadStream(stdin), stdout: asWriteStream(out), debug: true },
  });
  return {
    controller,
    stdin,
    out,
    last: () => out.frames.at(-1) ?? '',
    unmount: () => handle.unmount(),
  };
}
const heightOf = (frame: string): number => frame.split('\n').length;
const NOTICE = '+6 rows not shown; enlarge the terminal to 30 rows to allow';

async function framed(app: ReturnType<typeof mountFit>): Promise<string> {
  await until(
    () => app.last().includes('Allow?') || app.last().includes('rows not shown'),
    'the box',
  );
  await afterEffects();
  return app.last();
}

describe('the fit rule', () => {
  it('the uncut box of the tall request is 30 rows', async () => {
    const app = mountFit({ request: tallRequest(), rows: 100 });
    expect(heightOf(await framed(app))).toBe(30);
    app.unmount();
  });

  it('on a 24-row terminal the frame is cut, ends the paths in the fixed line, and cannot be allowed', async () => {
    const request = tallRequest();
    const app = mountFit({ request, rows: 24 });
    const frame = await framed(app);
    expect(heightOf(frame)).toBeLessThanOrEqual(24);
    expect(frame).toContain('Merge many clips');
    expect(frame).toContain('Allow? [a]lways / [y]es / [n]o (Esc denies)');
    const rows = frame.split('\n');
    const noticeRow = rows.findIndex((row) => row.includes(NOTICE));
    expect(noticeRow).toBeGreaterThan(0);
    // it is the last row of the paths: the next content row is the blank before the decision line
    expect(rows[noticeRow + 1] ?? '').not.toContain('/work/clip-');
    app.stdin.write('y');
    app.stdin.write('a');
    await afterEffects();
    expect(app.controller.decisions).toEqual([]);
    expect(app.controller.request?.id).toBe(request.id);
    app.stdin.write('n');
    await until(() => app.controller.decisions.length > 0, 'the deny');
    expect(app.controller.decisions).toEqual([{ kind: 'deny' }]);
    app.unmount();
  });

  it('control: on a 40-row terminal the box is shown whole and y allows', async () => {
    const app = mountFit({ request: tallRequest(), rows: 40 });
    const frame = await framed(app);
    expect(heightOf(frame)).toBe(30);
    expect(frame).not.toContain('rows not shown');
    app.stdin.write('y');
    await until(() => app.controller.decisions.length > 0, 'the allow');
    expect(app.controller.decisions).toEqual([{ kind: 'allow' }]);
    app.unmount();
  });

  it('enlarging the terminal shows the box whole and lets y allow', async () => {
    const app = mountFit({ request: tallRequest(), rows: 24 });
    expect(await framed(app)).toContain('rows not shown');
    const before = app.out.frames.length;
    app.out.resize(80, 40);
    await until(() => app.out.frames.length > before, 'a frame after the resize');
    await afterEffects();
    expect(app.last()).not.toContain('rows not shown');
    expect(heightOf(app.last())).toBe(30);
    app.stdin.write('y');
    await until(() => app.controller.decisions.length > 0, 'the allow');
    expect(app.controller.decisions).toEqual([{ kind: 'allow' }]);
    app.unmount();
  });

  it('a key written in the commit that first shows the oversize box does nothing', async () => {
    const request = tallRequest();
    const app = mountFit({ rows: 24 });
    await until(() => app.out.frames.length > 0, 'the empty app');
    await afterEffects();
    // write y from the stream's write of the first frame that holds the box
    let sent = false;
    const write = app.out.write;
    app.out.write = (chunk: string): boolean => {
      const ok = write(chunk);
      if (!sent && chunk.includes('Allow?')) {
        sent = true;
        app.stdin.write('y');
      }
      return ok;
    };
    app.controller.open(request);
    await until(() => sent, 'the first frame of the box');
    await afterEffects();
    expect(app.controller.decisions).toEqual([]);
    app.unmount();
  });

  it('a key written right after the terminal shrank, before the next frame, does nothing', async () => {
    const app = mountFit({ request: tallRequest(), rows: 40 });
    expect(heightOf(await framed(app))).toBe(30);
    app.out.resize(80, 24);
    app.stdin.write('y');
    await afterEffects();
    expect(app.controller.decisions).toEqual([]);
    app.unmount();
  });

  it('control: a stream that reports no rows shows the box whole and y allows', async () => {
    const app = mountFit({ request: tallRequest(), rows: undefined });
    const frame = await framed(app);
    expect(heightOf(frame)).toBe(30);
    app.stdin.write('y');
    await until(() => app.controller.decisions.length > 0, 'the allow');
    expect(app.controller.decisions).toEqual([{ kind: 'allow' }]);
    app.unmount();
  });

  it('on a 3-row terminal the headline and the decision line are still drawn and allow is ignored', async () => {
    const request = tallRequest();
    const app = mountFit({ request, rows: 3 });
    const frame = await framed(app);
    expect(frame).toContain('Merge many clips');
    expect(frame).toContain('Allow? [a]lways / [y]es / [n]o (Esc denies)');
    app.stdin.write('y');
    await afterEffects();
    expect(app.controller.decisions).toEqual([]);
    app.unmount();
  });
});
