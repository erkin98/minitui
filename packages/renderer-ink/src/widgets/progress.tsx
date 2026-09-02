import React from 'react';
import { Box, Text } from 'ink';
import type { WidgetProps } from './command-preview.js';

// ffmpeg progress bar bound to a 0..1 state value. Pure display of the bound prop.
// The prop is named `progress` — the adopted json-render std ProgressBar definition,
// which the catalog spreads verbatim. Read `progress`, never `value`.
export const ProgressWidget: React.FC<WidgetProps> = ({ element }) => {
  const p = element.props ?? {};
  const raw = typeof p.progress === 'number' ? p.progress : 0;
  const pct = Math.max(0, Math.min(1, raw));
  const width = 20;
  const filled = Math.round(pct * width);
  return (
    <Box>
      <Text>
        [{'█'.repeat(filled)}
        {'░'.repeat(width - filled)}] {Math.round(pct * 100)}%
      </Text>
    </Box>
  );
};
