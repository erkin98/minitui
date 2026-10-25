// The consent box as rows. Every text is wrapped HERE, by a fixed rule, so the height of the box is
// known exactly before anything is drawn: that is what the fit rule compares with the terminal.
// Wrapping is a hard wrap by cell width (never at a word boundary), so each character of the
// command stays where the user reads it.

export const DECISION_LINE = 'Allow? [a]lways / [y]es / [n]o (Esc denies)';

export interface ConsentRow {
  readonly text: string;
  // the fixed line that stands in for rows that were cut
  readonly notice?: true;
}

export interface ConsentLayout {
  readonly headline: readonly ConsentRow[];
  readonly command: readonly ConsentRow[];
  readonly paths: readonly ConsentRow[];
  readonly decision: readonly ConsentRow[];
  // rows of the box if nothing were cut
  readonly uncutHeight: number;
  // true when the uncut box is taller than the terminal; the allow keys are then ignored
  readonly tooTall: boolean;
}

// A code point from U+1100 up counts as two cells, which over-counts symbols and under-counts
// nothing that matters: a row is never wider than the box, so the renderer never wraps it again.
const cells = (char: string): number => ((char.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1);

export function wrapRows(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const rows: string[] = [];
  let row = '';
  let used = 0;
  for (const char of text) {
    const w = cells(char);
    if (used + w > limit && row !== '') {
      rows.push(row);
      row = '';
      used = 0;
    }
    row += char;
    used += w;
  }
  rows.push(row);
  return rows;
}

const plain = (rows: readonly string[]): ConsentRow[] => rows.map((text) => ({ text }));

function pathRows(paths: readonly string[], width: number): ConsentRow[] {
  return paths.flatMap((path) =>
    wrapRows(path, width - 2).map((text, index) => ({ text: (index === 0 ? '· ' : '  ') + text })),
  );
}

// The rows of the box between the borders: 2 (borders) + headline + 1 + command + [1 + paths] + 1 +
// decision. The paths section is absent when it has no rows.
const heightOf = (head: number, command: number, paths: number, decision: number): number =>
  2 + head + 1 + command + (paths > 0 ? 1 + paths : 0) + 1 + decision;

const notice = (hidden: number, uncut: number): ConsentRow => ({
  text: `+${hidden} rows not shown; enlarge the terminal to ${uncut} rows to allow`,
  notice: true,
});

export function layoutConsent(
  parts: { headline: string; command: string; paths: readonly string[] },
  columns: number,
  terminalRows: number | undefined,
): ConsentLayout {
  // inside the double border and one column of padding on each side
  const width = Math.max(1, columns - 4);
  const headline = plain(wrapRows(parts.headline, width));
  const command = plain(wrapRows(parts.command, width));
  const paths = pathRows(parts.paths, width);
  const decision = plain(wrapRows(DECISION_LINE, width));
  const uncutHeight = heightOf(headline.length, command.length, paths.length, decision.length);
  if (terminalRows === undefined || uncutHeight <= terminalRows) {
    return { headline, command, paths, decision, uncutHeight, tooTall: false };
  }

  // Rows are cut from the end of the lowest-priority section that does not fit: the paths first,
  // then the command. The last row that stays visible of the cut section is the fixed line. The
  // headline and the decision line are never cut.
  const hidden = uncutHeight - terminalRows;
  const fixed = notice(hidden, uncutHeight);
  const keepPaths =
    terminalRows - heightOf(headline.length, command.length, 1, decision.length) + 1;
  if (paths.length > 0 && keepPaths >= 1) {
    const cutPaths = [...paths.slice(0, keepPaths - 1), fixed];
    return { headline, command, paths: cutPaths, decision, uncutHeight, tooTall: true };
  }
  const keepCommand = terminalRows - heightOf(headline.length, 1, 0, decision.length) + 1;
  const cutCommand = keepCommand >= 1 ? [...command.slice(0, keepCommand - 1), fixed] : [fixed];
  return { headline, command: cutCommand, paths: [], decision, uncutHeight, tooTall: true };
}
