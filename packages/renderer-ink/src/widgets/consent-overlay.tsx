import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useFocusDisable } from '@json-render/ink';
import type { PermissionRequest } from '@minitui/types';

// Three user decisions. `always` carries `cascade` (session-scoped grant). The renderer keeps
// its OWN vocabulary (renderer-ink never imports the exec package); the host-side
// ConsentController impl (the cli composition root) maps 1:1 to the permission engine's
// reply: {kind:'allow'}->{kind:'once'}, {kind:'deny'}->{kind:'reject',feedback},
// {kind:'always'}->{kind:'always',cascade}.
export type ConsentDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny' }
  | { readonly kind: 'always'; readonly cascade: boolean };

// The host-driven consent seam. The host (permission engine) sets the pending request;
// the overlay subscribes and renders HOST-RESOLVED values; resolve() reports the decision.
export interface ConsentController {
  readonly request: PermissionRequest | undefined;
  subscribe(listener: () => void): () => void;
  resolve(decision: ConsentDecision): void;
}

function usePending(controller: ConsentController): PermissionRequest | undefined {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => controller.subscribe(force), [controller]);
  return controller.request;
}

export const ConsentOverlay: React.FC<{ controller: ConsentController }> = ({ controller }) => {
  const request = usePending(controller);
  // Suppress Tab focus traversal while the modal is up (the standard modal-dialog mechanics).
  useFocusDisable(Boolean(request));
  useInput(
    (input, key) => {
      if (!request) return;
      const k = input.toLowerCase();
      // [a]lways / [y]es / [n]o / Esc. `always` is a NARROW (cascade:false) session grant in v1.
      // The engine's non-overridable hard floor is checked BEFORE consent, so a hard-floor action
      // never reaches this overlay and an always-grant can never open one.
      if (k === 'y') controller.resolve({ kind: 'allow' });
      else if (k === 'a') controller.resolve({ kind: 'always', cascade: false });
      else if (k === 'n' || key.escape) controller.resolve({ kind: 'deny' });
    },
    { isActive: Boolean(request) },
  );

  if (!request) return null;

  // DERIVE summary + danger from the canonical request descriptor — the request type has no
  // parallel summary/danger field. summaryTemplate is host-authored, never agent text.
  const danger = request.descriptor.danger;
  const summary = request.descriptor.summaryTemplate;

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={danger ? 'red' : 'yellow'}
      paddingX={1}
    >
      <Text bold color={danger ? 'red' : 'yellow'}>
        {summary}
      </Text>
      <Box marginTop={1}>
        <Text>{request.resolvedCommand}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {request.resolvedPaths.map((p) => (
          <Text key={p} dimColor>
            · {p}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text>Allow? [a]lways / [y]es / [n]o (Esc denies)</Text>
      </Box>
    </Box>
  );
};
