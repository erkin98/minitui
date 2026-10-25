import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ensureParserReady, setParseBudgetMsForTest } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';

// This file holds the memory measurements alone, so nothing that ran before it shifts a baseline.
const unit = 'ffmpeg -i /a/b/c.mp4 -i /d/e/f.mp4 out.mp4 && ';
const body = unit.repeat(42);

// Each form ends a different way: a normal return, a syntax error, and a construct the allowlist refuses.
const forms: Array<[string, string, boolean]> = [
  ['a command that parses', body + 'ls', false],
  ['a syntax error', body + 'ls "unterminated', true],
  ['a refused construct', body + '(ls)', true],
];

// Each row runs 2,050 parses: about 4 s on an idle machine and several times that beside heavy load. The
// shared 20 s test limit is sized for one-off rows, so this file carries its own.
const LOOP_TIMEOUT_MS = 120_000;

describe('the parse tree is freed after every parse', () => {
  // This file measures memory, not the parse budget (parser.test.ts covers the budget). The budget is
  // raised so a loaded machine cannot cancel the first, cold parse and turn a command that parses into
  // a parse error; the other two rows then fail for the construct they name, not for the clock.
  beforeAll(() => setParseBudgetMsForTest(10_000));
  afterAll(() => setParseBudgetMsForTest());

  it.each(forms)(
    'keeps the growth of external memory small for %s',
    async (_name, command, fails) => {
      await ensureParserReady();
      expect(parseShellCommand(command).parseError).toBe(fails);
      for (let i = 0; i < 50; i++) parseShellCommand(command);
      const before = process.memoryUsage().external;
      for (let i = 0; i < 2000; i++) parseShellCommand(command);
      const growthMb = (process.memoryUsage().external - before) / 1e6;
      expect(growthMb).toBeLessThan(8);
    },
    LOOP_TIMEOUT_MS,
  );
});
