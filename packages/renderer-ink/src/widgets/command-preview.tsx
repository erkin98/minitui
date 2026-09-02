import React from 'react';
import { Box, Text } from 'ink';

// json-render's REAL calling convention (its ComponentRenderProps), structurally narrowed
// to what the custom widgets read. emit takes ONE arg — the event name; write-back goes
// through `bindings` (useBoundProp), never an emit payload.
export interface WidgetProps {
  readonly element: { readonly type: string; readonly props?: Record<string, unknown> };
  readonly emit: (event: string) => void;
  readonly bindings?: Record<string, string>;
  readonly children?: React.ReactNode;
  readonly loading?: boolean;
}

// Model-visible RESOLVED command preview — host chrome, not agent-placeable (no catalog
// declares it; it is exported barrel-direct, outside the agent binding). The command is
// RESOLVED upstream (by the host's permission engine) and lands in state already sanitized
// at the transport seam — this widget only DISPLAYS it. It never templates or resolves
// anything itself.
export const CommandPreview: React.FC<WidgetProps> = ({ element }) => {
  const p = element.props ?? {};
  const command = typeof p.command === 'string' ? p.command : '';
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text color="cyan">{command}</Text>
    </Box>
  );
};
