import { sanitize } from '@minitui/sanitizer';

// The longest text that travels from a failed action to the model or to a diagnostics sink.
const FAULT_TEXT_LIMIT = 512;

// Text that came from an error, a denial or a parse failure: stripped of terminal controls by the
// shared sanitiser, then cut to 512 characters. The cut counts code points, so a surrogate pair is
// never split. Consumers still treat the result as untrusted by contract.
export function boundText(text: string): string {
  const clean = sanitize(text);
  const points = [...clean];
  return points.length > FAULT_TEXT_LIMIT ? points.slice(0, FAULT_TEXT_LIMIT).join('') : clean;
}

export const errorText = (error: unknown): string =>
  boundText(error instanceof Error ? error.message : String(error));
