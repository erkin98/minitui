import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useBoundProp, useFocus } from '@json-render/ink';
import type { WidgetProps } from './command-preview.js';
import { useReportFocus } from '../focus-capture.js';

// File/dir select bound to a pointer. CONTROLLED: the chosen path comes from the bound
// prop; Enter WRITES the draft back through the two-way binding, then emits 'change'.
// (Real fs listing is a CLI concern; this keeps the widget a thin controlled input —
// the spec binds value via $bindState to a state path.)
export const FilePicker: React.FC<WidgetProps> = ({ element, emit, bindings }) => {
  const p = element.props ?? {};
  const value = typeof p.value === 'string' ? p.value : '';
  const label = typeof p.label === 'string' ? p.label : 'path';
  const [, setValue] = useBoundProp<string>(value, bindings?.value);
  const [draft, setDraft] = React.useState(value);
  // Focus ring: gate useInput on isActive so an UNfocused picker never steals keys.
  const { isActive } = useFocus();
  // Report the focused element type up to the app shell. FilePicker CAPTURES free text
  // (the else-branch appends typed characters), so its catalog entry sets capturesText
  // and the shell keeps `q` literal while it is focused.
  useReportFocus(element.type, isActive);
  useInput(
    (input, key) => {
      if (key.return) {
        setValue(draft); // write-back through the binding path
        emit('change'); // event only — the value is already in state
      } else if (key.backspace || key.delete) setDraft((d) => d.slice(0, -1));
      else if (input) setDraft((d) => d + input);
    },
    { isActive },
  );
  return (
    <Box>
      <Text color="green">{label}: </Text>
      <Text inverse={isActive}>
        {isActive ? '> ' : '  '}
        {draft || value}
      </Text>
    </Box>
  );
};
