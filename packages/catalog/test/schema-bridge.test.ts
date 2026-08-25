import { describe, it, expect } from 'vitest';
import {
  inkSchema,
  standardComponentDefinitions,
  standardActionDefinitions,
  STD_ACTION_NAMES,
} from '../src/schema-bridge.js';

describe('schema-bridge', () => {
  it('re-exports the Ink schema factory', () => {
    expect(inkSchema).toBeDefined();
  });
  it('re-exports the 5 std actions including the STATE trio and exit/log', () => {
    for (const a of ['setState', 'pushState', 'removeState', 'exit', 'log']) {
      expect(standardActionDefinitions).toHaveProperty(a);
    }
  });
  it('STD_ACTION_NAMES lists every std action name', () => {
    expect([...STD_ACTION_NAMES].sort()).toEqual(Object.keys(standardActionDefinitions).sort());
  });
  it('re-exports std components (Box/Text/ProgressBar/Select among them) — note json-render has NO std Button', () => {
    for (const c of ['Box', 'Text', 'ProgressBar', 'Select']) {
      expect(standardComponentDefinitions).toHaveProperty(c);
    }
    // json-render's 27 Ink std defs ship no Button — minitui declares it custom.
    expect(standardComponentDefinitions).not.toHaveProperty('Button');
  });
});
