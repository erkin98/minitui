import { standardComponents } from '@json-render/ink';
import React from 'react';
import type { WidgetProps } from './command-preview.js';

// What the app frame draws of agent text: carriage returns and format characters (bidirectional
// controls, zero-width space, the word joiner, the byte order mark, tag characters) are removed,
// except U+200C to U+200F (joiners and direction marks that real text needs), so a label cannot
// move the cursor back over itself or reorder what is read. Line feeds and tabs stay. Terminal
// controls are already gone: the sanitiser strips them from the spec and from state. A display rule
// only: a value a widget writes back through its binding is never passed through it.
const HIDDEN_IN_FRAME = /\r|(?![\u200C-\u200F])\p{Cf}/gu;

export const displayText = (text: string): string => text.replace(HIDDEN_IN_FRAME, '');

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function displayValue(value: unknown, keepValue: boolean): unknown {
  if (typeof value === 'string') return displayText(value);
  if (isList(value)) return value.map((item) => displayValue(item, keepValue));
  if (isRecord(value)) return displayProps(value, keepValue);
  return value;
}

// The props an adopted component draws from: every string goes through displayText. With `keepValue`
// the strings under a key named `value` stay as they are, at any depth: the components that write them
// back (the text input, the selects, the tabs) compare with them and store them.
export function displayProps(
  props: Readonly<Record<string, unknown>>,
  keepValue: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(props)) {
    out[key] = keepValue && key === 'value' ? item : displayValue(item, keepValue);
  }
  return out;
}

// The adopted components that write `value` back through a binding. Recognised by identity with the
// library's own factories, never by the id a host binding returns: any other factory is stripped.
const WRITES_BACK: ReadonlySet<unknown> = new Set(
  ['TextInput', 'Select', 'MultiSelect', 'Tabs'].map(
    (id) => (standardComponents as Record<string, unknown>)[id],
  ),
);

const wrapped = new WeakMap<React.ComponentType<WidgetProps>, React.ComponentType<WidgetProps>>();

// The factory, rendered with display props. One wrapper per factory, so its identity is stable.
export function withDisplayText(
  factory: React.ComponentType<WidgetProps>,
): React.ComponentType<WidgetProps> {
  const known = wrapped.get(factory);
  if (known !== undefined) return known;
  const keepValue = WRITES_BACK.has(factory);
  const DisplayText: React.FC<WidgetProps> = (props) =>
    React.createElement(factory, {
      ...props,
      element: { ...props.element, props: displayProps(props.element.props ?? {}, keepValue) },
    });
  wrapped.set(factory, DisplayText);
  return DisplayText;
}
