import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useBoundProp, useFocus } from '@json-render/ink';
import type { WidgetProps } from './command-preview.js';
import { useReportFocus } from '../focus-capture.js';

// Copy with entries i and j exchanged. The undefined guard narrows the indexed reads
// for the checked-index compiler flag; callers only pass in-range positions.
function swapped(items: readonly string[], i: number, j: number): string[] {
  const next = [...items];
  const a = next[i];
  const b = next[j];
  if (a === undefined || b === undefined) return next;
  next[i] = b;
  next[j] = a;
  return next;
}

// Reorderable list (merge input ordering). CONTROLLED: items come from the bound prop;
// shift+arrow reorder WRITES the new ordering back through the two-way binding
// (useBoundProp -> the bindings.items state path), then emits 'reorder' so the spec's
// action binding fires reading the already-updated state. The widget never owns the data.
export const OrderList: React.FC<WidgetProps> = ({ element, emit, bindings }) => {
  const p = element.props ?? {};
  const items = Array.isArray(p.items) ? (p.items as unknown[]).map(String) : [];
  const [, setItems] = useBoundProp<string[]>(items, bindings?.items);
  const [cursor, setCursor] = React.useState(0);
  // Focus ring: gate useInput on isActive so an UNfocused list never steals keys.
  const { isActive } = useFocus();
  // Report the focused element type up to the app shell (OrderList captures no free
  // text, so `q` still quits while it holds focus).
  useReportFocus(element.type, isActive);
  useInput(
    (_input, key) => {
      if (key.shift && key.upArrow && cursor > 0) {
        setItems(swapped(items, cursor - 1, cursor)); // write-back through the binding path
        setCursor((c) => c - 1);
        emit('reorder'); // event only — the value is already in state
        return;
      }
      if (key.shift && key.downArrow && cursor < items.length - 1) {
        setItems(swapped(items, cursor, cursor + 1));
        setCursor((c) => c + 1);
        emit('reorder');
        return;
      }
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1));
    },
    { isActive },
  );
  return (
    <Box flexDirection="column">
      {items.map((it, i) => (
        <Text key={`${it}-${i}`} inverse={isActive && i === cursor}>
          {isActive && i === cursor ? '> ' : '  '}
          {i + 1}. {it}
        </Text>
      ))}
    </Box>
  );
};
