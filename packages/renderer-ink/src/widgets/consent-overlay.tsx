import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { useFocusDisable } from '@json-render/ink';
import { CONSENT_FORBIDDEN } from '@minitui/sanitizer';
import type { PermissionRequest } from '@minitui/types';
import { layoutConsent, type ConsentLayout } from './consent-layout.js';

// Every control, format, separator, private-use and unassigned code point (the class the permission
// engine refuses) is shown as U+FFFD, so the command the user reads is the string being decided. The
// global form that String.prototype.replace needs is derived from the sanitiser's constant, once.
const REPLACEMENT = String.fromCodePoint(0xfffd);
const FORBIDDEN_EVERYWHERE = new RegExp(CONSENT_FORBIDDEN.source, 'gu');
const shown = (text: string): string => text.replace(FORBIDDEN_EVERYWHERE, REPLACEMENT);

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

// The terminal the overlay draws to is the stream ink was given. A stream that reports no rows is an
// unbounded terminal: the box is shown whole.
function useTerminal(): {
  columns: number;
  rows: number | undefined;
  read: () => { columns: number; rows: number | undefined };
} {
  const { stdout } = useStdout();
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  // ink recomputes its layout on resize but does not run the components again
  React.useEffect(() => {
    stdout.on('resize', force);
    return () => {
      stdout.off('resize', force);
    };
  }, [stdout]);
  const read = (): { columns: number; rows: number | undefined } => ({
    columns: stdout.columns > 0 ? stdout.columns : 80,
    rows: typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : undefined,
  });
  return { ...read(), read };
}

const layoutOf = (
  request: PermissionRequest,
  size: { columns: number; rows: number | undefined },
): ConsentLayout =>
  layoutConsent(
    {
      headline: shown(request.descriptor.summaryTemplate),
      command: shown(request.resolvedCommand),
      paths: request.resolvedPaths.map(shown),
    },
    size.columns,
    size.rows,
  );

// `live` reads the controller's current request at key time. The app shell hands the overlay a view
// whose request is the value the shell read for this render, so the live read comes separately;
// without it the overlay reads `controller.request`, which is live for a real controller.
export const ConsentOverlay: React.FC<{
  controller: ConsentController;
  live?: (() => PermissionRequest | undefined) | undefined;
}> = ({ controller, live }) => {
  const request = usePending(controller);
  const terminal = useTerminal();
  // Suppress Tab focus traversal while the modal is up (the standard modal-dialog mechanics).
  useFocusDisable(Boolean(request));
  useInput(
    (input, key) => {
      if (!request) return;
      // A key acts only on the request that is on screen: two keys in one tick would otherwise
      // resolve the request that was queued behind it.
      const current = live === undefined ? controller.request : live();
      if (current?.id !== request.id) return;
      const k = input.toLowerCase();
      // [a]lways / [y]es / [n]o / Esc. `always` is a NARROW (cascade:false) session grant in v1.
      // The engine's non-overridable hard floor is checked BEFORE consent, so a hard-floor action
      // never reaches this overlay and an always-grant can never open one.
      // A request that is not wholly on screen cannot be allowed: the size is read at key time, so a
      // terminal that shrank a moment ago counts. Deny and Esc always work.
      const allowed = !layoutOf(request, terminal.read()).tooTall;
      if (k === 'y') {
        if (allowed) controller.resolve({ kind: 'allow' });
      } else if (k === 'a') {
        if (allowed) controller.resolve({ kind: 'always', cascade: false });
      } else if (k === 'n' || key.escape) controller.resolve({ kind: 'deny' });
    },
    { isActive: Boolean(request) },
  );

  if (!request) return null;

  // DERIVE danger from the canonical request descriptor — the request type has no parallel danger
  // field. The text is host-authored or host-resolved, never agent text.
  const danger = request.descriptor.danger;
  const layout = layoutOf(request, terminal);
  const tone = danger ? 'red' : 'yellow';

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={tone} paddingX={1}>
      <Box flexDirection="column">
        {layout.headline.map((row, index) => (
          <Text key={`${request.id}:h${index}`} bold color={tone}>
            {row.text}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {layout.command.map((row, index) => (
          <Text key={`${request.id}:c${index}`} bold={row.notice === true}>
            {row.text}
          </Text>
        ))}
      </Box>
      {layout.paths.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {layout.paths.map((row, index) => (
            <Text
              key={`${request.id}:${index}`}
              dimColor={row.notice !== true}
              bold={row.notice === true}
            >
              {row.text}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {layout.decision.map((row, index) => (
          <Text key={`${request.id}:d${index}`}>{row.text}</Text>
        ))}
      </Box>
    </Box>
  );
};
