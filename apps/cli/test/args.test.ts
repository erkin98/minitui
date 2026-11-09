import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../src/args.js';

describe('parseCliArgs', () => {
  it('takes the free-text intent from the positionals', () => {
    const args = parseCliArgs(['merge', 'these', 'two', 'clips']);
    expect(args.intent).toBe('merge these two clips');
    expect(args.parseError).toBeUndefined();
    expect(args.mode).toBe('default');
    expect(args.accessible).toBe(false);
  });

  it('--yolo selects the yolo approval mode', () => {
    expect(parseCliArgs(['--yolo', 'merge']).mode).toBe('yolo');
  });

  it('--accessible and --model are read', () => {
    const args = parseCliArgs(['--accessible', '--model', 'some-model', 'merge']);
    expect(args.accessible).toBe(true);
    expect(args.model).toBe('some-model');
  });

  it('an unknown flag is a usage error that names the flag', () => {
    const args = parseCliArgs(['--accesible', 'merge']);
    expect(args.parseError).toContain('--accesible');
  });

  it('a flag that needs a value and has none is a usage error', () => {
    expect(parseCliArgs(['merge', '--model']).parseError).toBeDefined();
  });

  it('an empty intent is a usage error, so nothing paid starts with nothing to build', () => {
    const args = parseCliArgs([]);
    expect(args.parseError).toMatch(/missing intent/);
    expect(parseCliArgs(['--yolo']).parseError).toMatch(/missing intent/);
  });

  it('--version and --help need no intent', () => {
    const version = parseCliArgs(['--version']);
    expect(version.showVersion).toBe(true);
    expect(version.parseError).toBeUndefined();
    const help = parseCliArgs(['--help']);
    expect(help.showHelp).toBe(true);
    expect(help.parseError).toBeUndefined();
  });

  it('an intent that starts with a dash goes after --', () => {
    const args = parseCliArgs(['--', '--not-a-flag', 'merge']);
    expect(args.intent).toBe('--not-a-flag merge');
    expect(args.parseError).toBeUndefined();
  });
});
