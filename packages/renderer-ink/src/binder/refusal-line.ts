import { sanitize } from '@minitui/sanitizer';
import type { RuntimeFault } from '@minitui/types';
import { displayText } from '../widgets/display-text.js';

// The longest reason the refusal row shows, in code points.
const REASON_LIMIT = 160;

/** The refusal row's two parts: a fixed lead naming the action, and the reason, empty when there is none. */
export type RefusalLine = { readonly lead: string; readonly reason: string };

// The one host-authored line under the app for the last refused or failed gated action: a fixed
// sentence, the catalog's action name and the reason the lifecycle event carries, on one line. The
// reason keeps its END, where the cause and exec's own phrases are, cut from the front with `…`.
export function refusalLine(actionName: string, fault: RuntimeFault): RefusalLine {
  const points = [
    ...displayText(sanitize(fault.stderrExcerpt))
      .replace(/[\n\t]+/g, ' ')
      .trim(),
  ];
  const reason =
    points.length > REASON_LIMIT ? `…${points.slice(-REASON_LIMIT).join('')}` : points.join('');
  const name = displayText(actionName);
  return reason === ''
    ? { lead: `Action "${name}" did not complete.`, reason: '' }
    : { lead: `Action "${name}" did not complete:`, reason };
}
