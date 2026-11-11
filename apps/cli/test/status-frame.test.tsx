import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import {
  GenerationStatus,
  mountGenerationStatus,
  type RenderInk,
  type RenderInkOptions,
} from '../src/status-frame.js';

// Ink holds a bare escape briefly to tell it from the start of a longer sequence, and flushes it on a
// later tick: wait those ticks out.
const afterInput = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('GenerationStatus', () => {
  it('shows the attempt, the elapsed time and how to cancel', () => {
    const { lastFrame } = render(
      <GenerationStatus attempt={2} maxAttempts={6} onCancel={() => {}} />,
    );
    expect(lastFrame()).toContain('attempt 2/6');
    expect(lastFrame()).toContain('0s');
    expect(lastFrame()).toContain('esc to cancel');
  });

  it('adds the token count once there is one', () => {
    const { lastFrame } = render(
      <GenerationStatus attempt={1} maxAttempts={6} tokens={1234} onCancel={() => {}} />,
    );
    expect(lastFrame()).toContain('1234 tokens');
    const without = render(<GenerationStatus attempt={1} maxAttempts={6} onCancel={() => {}} />);
    expect(without.lastFrame()).not.toContain('tokens');
  });

  it('Esc and Ctrl-C cancel; another key does not', async () => {
    let cancels = 0;
    const { stdin } = render(
      <GenerationStatus
        attempt={1}
        maxAttempts={6}
        onCancel={() => {
          cancels += 1;
        }}
      />,
    );
    stdin.write('a');
    await afterInput();
    expect(cancels).toBe(0);
    stdin.write('\x1B');
    await afterInput();
    expect(cancels).toBe(1);
    stdin.write('\x03');
    await afterInput();
    expect(cancels).toBe(2);
  });
});

// A real render function for the seam: it records the options it was given and hands the render to
// ink-testing-library, counting the unmounts.
function recordingRender(): {
  renderInk: RenderInk;
  options: RenderInkOptions[];
  frame: () => string | undefined;
  unmounts: () => number;
  rerenders: () => number;
} {
  const options: RenderInkOptions[] = [];
  let current: ReturnType<typeof render> | undefined;
  let unmounts = 0;
  let rerenders = 0;
  const renderInk: RenderInk = (node, given) => {
    options.push(given);
    const instance = render(node);
    current = instance;
    return {
      rerender: (next) => {
        rerenders += 1;
        instance.rerender(next);
      },
      unmount: () => {
        unmounts += 1;
        instance.unmount();
      },
    };
  };
  return {
    renderInk,
    options,
    frame: () => current?.lastFrame(),
    unmounts: () => unmounts,
    rerenders: () => rerenders,
  };
}

describe('mountGenerationStatus', () => {
  it('renders with Ctrl-C handed to the app and the console left alone', () => {
    const fake = recordingRender();
    mountGenerationStatus({ maxAttempts: 6, onCancel: () => {}, renderInk: fake.renderInk });
    expect(fake.options).toEqual([{ exitOnCtrlC: false, patchConsole: false }]);
    expect(fake.frame()).toContain('attempt 1/6');
  });

  it('update changes the attempt and the tokens', () => {
    const fake = recordingRender();
    const handle = mountGenerationStatus({
      maxAttempts: 6,
      onCancel: () => {},
      renderInk: fake.renderInk,
    });
    handle.update({ attempt: 3, tokens: 99 });
    expect(fake.frame()).toContain('attempt 3/6');
    expect(fake.frame()).toContain('99 tokens');
  });

  it('unmount is idempotent and later updates do nothing', () => {
    const fake = recordingRender();
    const handle = mountGenerationStatus({
      maxAttempts: 6,
      onCancel: () => {},
      renderInk: fake.renderInk,
    });
    handle.unmount();
    handle.unmount();
    expect(fake.unmounts()).toBe(1);
    handle.update({ attempt: 2 });
    expect(fake.rerenders()).toBe(0);
  });
});
