// A small terminal: it replays what the renderer writes (printable text with autowrap at the column
// count, newline, cursor movement, erase line, erase screen, and the private-mode brackets) into a
// grid and exposes the visible rows. Every code point takes one cell; the tests that use it write
// ASCII and box-drawing characters. It exists because the renderer erases one LOGICAL row per
// previous row, so a row that wrapped past the terminal edge stays on a real screen, which a
// plain "last frame" read cannot show.

const ESC = String.fromCharCode(27);

export interface ScreenModel {
  write(chunk: string): void;
  // the visible rows, right-trimmed
  rows(): string[];
  // the visible screen as one string with trailing empty rows removed
  text(): string;
}

export function createScreenModel(columns: number, rowCount: number): ScreenModel {
  let grid: string[][] = Array.from({ length: rowCount }, () => []);
  let row = 0;
  let col = 0;
  let pendingWrap = false;

  const scroll = (): void => {
    grid.shift();
    grid.push([]);
  };
  const lineFeed = (): void => {
    pendingWrap = false;
    if (row === rowCount - 1) scroll();
    else row++;
  };
  const put = (char: string): void => {
    if (pendingWrap) {
      col = 0;
      lineFeed();
    }
    const line = grid[row];
    if (line === undefined) return;
    while (line.length < col) line.push(' ');
    line[col] = char;
    if (col === columns - 1) pendingWrap = true;
    else col++;
  };
  const eraseLine = (mode: number): void => {
    const line = grid[row];
    if (line === undefined) return;
    if (mode === 2) grid[row] = [];
    else if (mode === 0) line.length = Math.min(line.length, col);
    else for (let i = 0; i <= Math.min(col, line.length - 1); i++) line[i] = ' ';
  };
  const eraseScreen = (mode: number): void => {
    if (mode === 2 || mode === 3) grid = Array.from({ length: rowCount }, () => []);
    else if (mode === 0) {
      eraseLine(0);
      for (let r = row + 1; r < rowCount; r++) grid[r] = [];
    }
  };
  const csi = (params: string, final: string): void => {
    const nums = params
      .replace(/^[?>]/, '')
      .split(';')
      .map((p) => (p === '' ? undefined : Number(p)));
    const n = nums[0] ?? 1;
    pendingWrap = false;
    switch (final) {
      case 'A':
        row = Math.max(0, row - n);
        break;
      case 'B':
        row = Math.min(rowCount - 1, row + n);
        break;
      case 'C':
        col = Math.min(columns - 1, col + n);
        break;
      case 'D':
        col = Math.max(0, col - n);
        break;
      case 'G':
        col = Math.max(0, Math.min(columns - 1, n - 1));
        break;
      case 'H':
        row = Math.max(0, Math.min(rowCount - 1, (nums[0] ?? 1) - 1));
        col = Math.max(0, Math.min(columns - 1, (nums[1] ?? 1) - 1));
        break;
      case 'J':
        eraseScreen(nums[0] ?? 0);
        break;
      case 'K':
        eraseLine(nums[0] ?? 0);
        break;
      default:
        break; // colours, modes, cursor visibility: no effect on the grid
    }
  };

  return {
    write(chunk: string): void {
      let i = 0;
      while (i < chunk.length) {
        const ch = chunk[i] ?? '';
        if (ch === ESC && chunk[i + 1] === '[') {
          let j = i + 2;
          while (j < chunk.length && /[0-9;?>]/.test(chunk[j] ?? '')) j++;
          csi(chunk.slice(i + 2, j), chunk[j] ?? '');
          i = j + 1;
        } else if (ch === ESC) {
          i += 2; // a two-character escape such as ESC 7
        } else if (ch === '\n') {
          col = 0;
          lineFeed();
          i++;
        } else if (ch === '\r') {
          col = 0;
          pendingWrap = false;
          i++;
        } else {
          const point = chunk.codePointAt(i) ?? 0;
          const char = String.fromCodePoint(point);
          put(char);
          i += char.length;
        }
      }
    },
    rows: () => grid.map((line) => line.join('').replace(/\s+$/, '')),
    text(): string {
      const rows = grid.map((line) => line.join('').replace(/\s+$/, ''));
      while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
      return rows.join('\n');
    },
  };
}
