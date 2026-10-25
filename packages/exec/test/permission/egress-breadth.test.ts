import { describe, it, expect } from 'vitest';
import { createEngine } from '../../src/permission/engine.js';
import type { PermissionRequest } from '@minitui/types';

let n = 0;
const exec = (resolvedCommand: string): PermissionRequest => ({
  id: `e${n++}`,
  descriptor: {
    danger: false,
    resourceTemplate: resolvedCommand,
    summaryTemplate: resolvedCommand,
  },
  resolvedCommand,
  resolvedPaths: [],
});

// The full network-egress denylist, hardcoded here on purpose: importing the source set would track
// it automatically and could never catch a name silently dropped from it. Removing any one binary
// from the source denylist reds exactly that binary's assertion below (the real bite).
const EGRESS_BINARIES = [
  'curl',
  'wget',
  'nc',
  'ncat',
  'scp',
  'ssh',
  'sftp',
  'telnet',
  'aria2c',
  'axel',
  'curlie',
  'httpie',
  'http',
  'xh',
  'w3m',
  'lynx',
  'links',
  'netcat',
  'nc.openbsd',
  'nc.traditional',
  'socat',
  'openssl',
  'ftp',
  'rsh',
] as const;

describe('hard-floor egress denylist breadth', () => {
  for (const bin of EGRESS_BINARIES) {
    it(`denies ${bin} reaching the network`, async () => {
      const e = createEngine({ initialRules: { rules: [] } });
      expect((await e.check(exec(`${bin} http://evil`))).kind).toBe('deny');
    });
  }
});
