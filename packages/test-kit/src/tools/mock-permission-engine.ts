import type {
  ApprovalMode,
  Decision,
  PermissionGatePort,
  PermissionReply,
  PermissionRequest,
} from '@minitui/types';

// The engine's own interface belongs to exec, which this package may not import, so this class implements
// it structurally; the gate port it declares is the part @minitui/types owns.

export type Policy = 'allow' | 'ask' | 'deny';

/** Every reply names the request it answers; a reply whose id no pending check holds is ignored. */
export type MockPermissionReply = PermissionReply;

export type MockApprovalMode = ApprovalMode;

export interface PermissionRecord {
  readonly at: number;
  readonly kind: 'check' | 'reply';
  readonly key?: string;
  readonly decision?: Decision['kind'];
  readonly pending?: boolean;
  readonly reply?: MockPermissionReply;
}

/** The deny reason for a reply whose kind is none of the three. */
export const UNRECOGNISED_REPLY = 'reply not recognised: treated as a rejection';

/** The deny reason for a second check whose id is already waiting. */
const DUPLICATE_ID = 'a request with this id is already waiting for approval';

// The surfaced requests, as an async iterable that never ends: the real engine's channel never ends
// either, so a consumer waiting on it is never told the engine has gone.
class RequestChannel implements AsyncIterable<PermissionRequest> {
  private buffer: readonly PermissionRequest[] = [];
  private waiter: ((v: IteratorResult<PermissionRequest, undefined>) => void) | undefined;

  push(req: PermissionRequest): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter({ value: req, done: false });
      return;
    }
    this.buffer = [...this.buffer, req];
  }

  /** Drops the requests that were surfaced and never read, as the real channel does when it disposes. */
  clear(): void {
    this.buffer = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<PermissionRequest, undefined> {
    return {
      next: (): Promise<IteratorResult<PermissionRequest, undefined>> => {
        const head = this.buffer[0];
        if (head !== undefined) {
          this.buffer = this.buffer.slice(1);
          return Promise.resolve({ value: head, done: false });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

function decisionFor(reply: MockPermissionReply): Decision {
  switch (reply.kind) {
    case 'once':
    case 'always':
      return { kind: 'allow' };
    case 'reject':
      return { kind: 'deny', reason: reply.feedback };
    default:
      return { kind: 'deny', reason: UNRECOGNISED_REPLY };
  }
}

/**
 * An in-memory permission engine. A policy map keyed by the request's resolved command decides: `allow`
 * and `deny` settle at once; `ask` surfaces the request on `requests` and keeps the check pending until
 * the reply that names its id. Every check and reply is recorded in order.
 */
export class MockPermissionEngine implements PermissionGatePort {
  readonly requests = new RequestChannel();
  private records: readonly PermissionRecord[] = [];
  private mode: MockApprovalMode = 'default';
  private readonly waiting = new Map<string, (decision: Decision) => void>();

  constructor(
    private readonly policy: Readonly<Record<string, Policy>> = {},
    private readonly defaultDecision: Policy = 'allow',
  ) {}

  get recorder(): readonly PermissionRecord[] {
    return this.records;
  }

  get approvalMode(): MockApprovalMode {
    return this.mode;
  }

  keyOf(req: PermissionRequest): string {
    return req.resolvedCommand;
  }

  private record(rec: PermissionRecord): void {
    this.records = [...this.records, rec];
  }

  // Own keys only: a command named like an Object.prototype member gets the default decision.
  private policyFor(key: string): Policy {
    return Object.hasOwn(this.policy, key)
      ? (this.policy[key] ?? this.defaultDecision)
      : this.defaultDecision;
  }

  check(req: PermissionRequest): Promise<Decision> {
    const key = this.keyOf(req);
    const policy = this.policyFor(key);
    if (policy === 'allow') {
      this.record({ at: Date.now(), kind: 'check', key, decision: 'allow' });
      return Promise.resolve({ kind: 'allow' });
    }
    if (policy === 'deny') {
      this.record({ at: Date.now(), kind: 'check', key, decision: 'deny' });
      return Promise.resolve({ kind: 'deny', reason: `denied by mock policy: ${key}` });
    }
    if (this.waiting.has(req.id)) {
      this.record({ at: Date.now(), kind: 'check', key, decision: 'deny' });
      return Promise.resolve({ kind: 'deny', reason: DUPLICATE_ID });
    }
    this.record({ at: Date.now(), kind: 'check', key, pending: true });
    return new Promise<Decision>((resolve) => {
      this.waiting.set(req.id, resolve);
      this.requests.push(req);
    });
  }

  reply(reply: MockPermissionReply): void {
    this.record({ at: Date.now(), kind: 'reply', reply });
    const settle = this.waiting.get(reply.requestId);
    if (settle === undefined) return;
    this.waiting.delete(reply.requestId);
    settle(decisionFor(reply));
  }

  setMode(mode: MockApprovalMode): void {
    this.mode = mode;
  }

  /** Every pending check settles as a deny with the reason; unread requests are dropped; the channel stays open. */
  disposeAll(reason: string): void {
    const pending = [...this.waiting.values()];
    this.waiting.clear();
    this.requests.clear();
    for (const settle of pending) settle({ kind: 'deny', reason });
  }
}

export function createMockPermissionEngine(
  policy?: Readonly<Record<string, Policy>>,
  opts: { readonly defaultDecision?: Policy | undefined } = {},
): MockPermissionEngine {
  return new MockPermissionEngine(policy ?? {}, opts.defaultDecision ?? 'allow');
}
