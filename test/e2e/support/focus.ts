import { waitFor } from '@minitui/test-kit';

/** A mounted app as a row drives it: the last frame drawn and a key press that waits for the render. */
export interface Drivable {
  frame(): string;
  press(key: string): Promise<void>;
}

/** Moves the focus to the Merge button one Tab at a time, waiting for each move to render. */
export async function focusMerge(ui: Drivable): Promise<void> {
  const focusedLine = (): number =>
    ui
      .frame()
      .split('\n')
      .findIndex((line) => line.includes('> '));
  const onMerge = (): boolean => ui.frame().split('\n')[focusedLine()]?.includes('Merge') === true;
  await waitFor(() => focusedLine() >= 0, 'a focused widget');
  for (let i = 0; i < 6 && !onMerge(); i++) {
    const before = focusedLine();
    await ui.press('tab');
    await waitFor(() => focusedLine() !== before, 'the focus to move');
  }
  await waitFor(onMerge, 'focus on the Merge button');
}
