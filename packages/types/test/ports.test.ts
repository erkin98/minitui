import { describe, it, expect } from 'vitest';
import type {
  PermissionGatePort,
  McpBridgePort,
  McpToolRecord,
  McpCallResult,
  ExecEvent,
} from '../src/ports.js';
import type { Decision, PermissionRequest } from '../src/permission.js';

// Type-level proof each port is implementable; if a signature drifts this file
// fails to typecheck (tsc -b is the real gate), and the runtime assertions below
// prove the stubs actually satisfy the shapes at value level too.
// Real request literals — no `{} as X` casts that could mask a shape mismatch.
const permReq: PermissionRequest = {
  id: 'r1',
  descriptor: { danger: false, resourceTemplate: 'ls', summaryTemplate: 'List files' },
  resolvedCommand: 'ls',
  resolvedPaths: [],
};

describe('executor ports', () => {
  it('PermissionGatePort is implementable', async () => {
    const gate: PermissionGatePort = {
      async check(_req: PermissionRequest): Promise<Decision> {
        return { kind: 'allow' };
      },
      requests: (async function* () {})(),
    };
    expect((await gate.check(permReq)).kind).toBe('allow');
  });

  it('McpBridgePort lists tools, calls one (forwarding progress), and tears down', async () => {
    const mcp: McpBridgePort = {
      async listTools(): Promise<readonly McpToolRecord[]> {
        return [{ name: 'mcp__fs__read', inputSchema: { type: 'object' } }];
      },
      async callTool(name, _params, opts): Promise<McpCallResult> {
        opts.onProgress?.({ progress: 0.5, total: 1 });
        return { isError: false, content: [{ ok: name }], text: 'done' };
      },
      async teardown(): Promise<void> {},
    };
    expect((await mcp.listTools())[0]?.name).toBe('mcp__fs__read');
    const seen: number[] = [];
    const res = await mcp.callTool(
      'mcp__fs__read',
      { path: '/x' },
      { signal: new AbortController().signal, onProgress: (p) => seen.push(p.progress) },
    );
    expect(res.isError).toBe(false);
    expect(seen).toEqual([0.5]);
    await mcp.teardown();
  });

  it('ExecEvent covers the four streamed variants at value level', () => {
    // Constructing each variant proves the exported shape at value level — a drift
    // in ExecEvent's discriminants or fields reds tsc here (surface golden sees names only).
    const evs: ExecEvent[] = [
      { kind: 'stdout', chunk: 'x' },
      { kind: 'stderr', chunk: 'y' },
      { kind: 'progress', value: 0.5, message: 'half' },
      { kind: 'exit', code: 0 },
    ];
    expect(evs.map((e) => e.kind)).toEqual(['stdout', 'stderr', 'progress', 'exit']);
  });
});
