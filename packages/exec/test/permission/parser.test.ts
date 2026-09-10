import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseToTree,
  ensureParserReady,
  setParseBudgetMsForTest,
} from '../../src/permission/shell/parser.js';

// parseToTree is synchronous; the one-time wasm init is awaited here before any parse.
beforeAll(async () => {
  await ensureParserReady();
});

describe('parseToTree', () => {
  it('parses a simple command to a non-error tree', () => {
    const res = parseToTree('ls -la');
    expect('parseError' in res).toBe(false);
    if (!('parseError' in res)) {
      expect(res.root.type).toBe('program');
    }
  });
  it('parses a compound command', () => {
    const res = parseToTree('ls && rm -rf /');
    expect('parseError' in res).toBe(false);
  });
  it('returns parseError (never throws) on unbalanced syntax', () => {
    const res = parseToTree('ls "unterminated');
    expect(res).toEqual({ parseError: true });
  });
  it('parses repeatedly off the one ready parser (no re-init)', () => {
    parseToTree('echo a');
    const res = parseToTree('echo b');
    expect('parseError' in res).toBe(false);
  });
  it('fails closed (parseError, never hangs) when the parse budget is exhausted', () => {
    // a 0ms budget guarantees the progressCallback deadline trips on the first check, so the
    // parse is cancelled (parse() returns null) — proving the wall-clock timeout branch of the
    // fail-closed contract is wired (not just init/syntax).
    setParseBudgetMsForTest(0);
    // a many-node input (50k words) makes tree-sitter invoke the progress callback repeatedly, so
    // the 0ms deadline trips and the parse is cancelled — a single huge word parses in one gulp
    // without enough callbacks to demonstrate the timeout branch.
    const res = parseToTree('a '.repeat(50_000));
    expect(res).toEqual({ parseError: true });
    setParseBudgetMsForTest(); // restore default for later tests
    // a budget-cancel calls reset(); the NEXT parse must start clean, not resume the cancelled
    // state on this memoized instance — a resumed parse could miss a dangerous root.
    expect('root' in parseToTree('ffmpeg -i a.mp4 out.mp4')).toBe(true);
  });
});
