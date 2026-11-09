// The status line painted while the app is being generated: the person sees that something is running
// and can cancel, before any mini app is mounted. It is also the only key listener in that phase.
import React, { useEffect, useState } from 'react';
import { render, Box, Text, useInput } from 'ink';

export interface GenerationStatusHandle {
  /** `tokens` is the running total once a finished run has reported usage; it is left out until then. */
  update(state: { attempt: number; tokens?: number | undefined }): void;
  unmount(): void;
}

export interface RenderInkOptions {
  readonly exitOnCtrlC: boolean;
  readonly patchConsole: boolean;
}

/** The render function of Ink, as a seam so a test can see the options it was given. */
export type RenderInk = (
  node: React.ReactElement,
  options: RenderInkOptions,
) => { rerender(node: React.ReactElement): void; unmount(): void };

export function GenerationStatus(props: {
  attempt: number;
  maxAttempts: number;
  tokens?: number | undefined;
  onCancel: () => void;
}): React.ReactElement {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) props.onCancel();
  });
  const tokenSuffix = props.tokens !== undefined ? `  ·  ${props.tokens} tokens` : '';
  return (
    <Box>
      <Text>{`generating mini app… attempt ${props.attempt}/${props.maxAttempts}  ${elapsed}s  ·  esc to cancel${tokenSuffix}`}</Text>
    </Box>
  );
}

export function mountGenerationStatus(opts: {
  maxAttempts: number;
  onCancel: () => void;
  renderInk?: RenderInk | undefined;
}): GenerationStatusHandle {
  const view = (attempt: number, tokens?: number): React.ReactElement => (
    <GenerationStatus
      attempt={attempt}
      maxAttempts={opts.maxAttempts}
      tokens={tokens}
      onCancel={opts.onCancel}
    />
  );
  // Ctrl-C is a cancel like Esc, so Ink must not exit the process on it; the console is left alone,
  // as the renderer of the mounted app leaves it, because two renders share the process.
  const instance = (opts.renderInk ?? render)(view(1), { exitOnCtrlC: false, patchConsole: false });
  let unmounted = false;
  return {
    update({ attempt, tokens }) {
      if (!unmounted) instance.rerender(view(attempt, tokens));
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      instance.unmount();
    },
  };
}
