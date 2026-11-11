import { parseArgs } from 'node:util';
import type { ApprovalMode } from '@minitui/types';

export interface CliArgs {
  readonly intent: string;
  readonly mode: ApprovalMode;
  readonly accessible: boolean;
  readonly showVersion: boolean;
  readonly showHelp: boolean;
  readonly model?: string | undefined;
  readonly parseError?: string | undefined;
}

/**
 * Parses the command line. Strict: an unknown flag is a usage error and not a silently dropped value, and
 * an empty intent is a usage error too, so nothing paid starts with nothing to build. The intent is free
 * text from the person; it is cleaned only where it becomes visible to the model, not here.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const base = {
    intent: '',
    mode: 'default' as ApprovalMode,
    accessible: false,
    showVersion: false,
    showHelp: false,
  };
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        yolo: { type: 'boolean', default: false },
        accessible: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        model: { type: 'string' },
      },
    });
    const intent = positionals.join(' ');
    if (intent === '' && values.version !== true && values.help !== true) {
      return { ...base, parseError: 'missing intent — usage: minitui [options] <intent>' };
    }
    return {
      ...base,
      intent,
      mode: values.yolo === true ? 'yolo' : 'default',
      accessible: values.accessible === true,
      showVersion: values.version === true,
      showHelp: values.help === true,
      model: values.model,
    };
  } catch (e) {
    return { ...base, parseError: e instanceof Error ? e.message : 'invalid arguments' };
  }
}
