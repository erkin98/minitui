import { sanitize } from '@minitui/sanitizer';
import type { RuntimeFault } from '@minitui/types';
import { displayText } from '../widgets/display-text.js';

// The longest reason the refusal row shows, in code points.
const REASON_LIMIT = 160;

// The one host-authored line under the app for the last refused or failed gated action: a fixed
// sentence, the catalog's action name and the reason the lifecycle event carries, on one line.
export function refusalLine(actionName: string, fault: RuntimeFault): string {
  const points = [
    ...displayText(sanitize(fault.stderrExcerpt))
      .replace(/[\n\t]+/g, ' ')
      .trim(),
  ];
  const reason =
    points.length > REASON_LIMIT ? `${points.slice(0, REASON_LIMIT).join('')}…` : points.join('');
  const name = displayText(actionName);
  return reason === ''
    ? `Action "${name}" did not complete.`
    : `Action "${name}" did not complete: ${reason}`;
}
