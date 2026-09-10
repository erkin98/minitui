import React from 'react';
import { Text, useInput } from 'ink';
import { useFocus } from '@json-render/ink';
import type { WidgetProps } from './command-preview.js';
import { useReportFocus } from '../focus-capture.js';

// Primary CTA. Joins json-render's focus ring: useFocus() auto-registers this button on
// mount and returns isActive; useInput is GATED on it so ONLY the focused button consumes
// keys (Tab/Shift+Tab traversal is handled by the FocusProvider that JSONUIProvider
// mounts; the first registered widget auto-focuses). Enter or Space fires emit('press') —
// the spec binds on.press to a gated action. A leading '>' + inverse video marks the
// focused control. NEVER call useInput ungated here: an ungated handler steals keystrokes
// from whatever is focused and breaks the ring.
export const Button: React.FC<WidgetProps> = ({ element, emit }) => {
  const p = element.props ?? {};
  const label = typeof p.label === 'string' ? p.label : 'OK';
  const { isActive } = useFocus();
  // Report the focused element type up to the app shell, whose quit gate reads
  // capturesText off the binding (Button captures no free text, so `q` still quits).
  useReportFocus(element.type, isActive);
  useInput(
    (input, key) => {
      if (key.return || input === ' ') emit('press');
    },
    { isActive },
  );
  return (
    <Text inverse={isActive} {...(isActive ? { color: 'cyan' } : {})}>
      {isActive ? '> ' : '  '}
      {label}
    </Text>
  );
};
