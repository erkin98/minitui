import { describe, it, expect } from 'vitest';
import {
  createSpendMeter,
  meteredFetch,
  trialMeter,
  type FetchLike,
  type Prices,
  type SpendMeter,
} from '../../eval/harness/spend.js';
import { RunAbort, type Usage } from '../../eval/harness/trial.js';

// One dollar per input token, so every amount in the meter rows is a whole number of dollars and the sums
// are exact. The highest input rate is the write rate: $2.
const PRICES: Prices = { input: 1e6, cacheWrite: 2e6, cacheRead: 5e5, output: 3e6 };
// The same prices with the write rate below the base input rate: the highest input rate is then the base one, $3.
const PRICES_LOW_WRITE: Prices = { input: 3e6, cacheWrite: 1e6, cacheRead: 5e5, output: 3e6 };
const MAX_OUT = 100;
const ENDPOINT = 'https://provider.test/v1/messages';
const BIG = 1e12; // a cap no row comes near

const meterWith = (capUsd: number): SpendMeter =>
  createSpendMeter({ capUsd, prices: PRICES, maxOutputTokens: MAX_OUT });

// The worst case of one request: its bytes at $2 and the whole output room at $3.
const worst = (bytes: number): number => 2 * bytes + 3 * MAX_OUT;
const bodyOf = (bytes: number): string => 'x'.repeat(bytes);
const post = (body: string): RequestInit => ({ method: 'POST', body });

// A real fetch that notes what it was given and answers with a canned response.
function recordingFetch(): {
  readonly base: FetchLike;
  readonly calls: Array<{ readonly input: Parameters<FetchLike>[0]; readonly body: unknown }>;
} {
  const calls: Array<{ readonly input: Parameters<FetchLike>[0]; readonly body: unknown }> = [];
  const base: FetchLike = (input, init) => {
    calls.push({ input, body: init?.body });
    return Promise.resolve(new Response('canned', { status: 200 }));
  };
  return { base, calls };
}

// The error settle throws, or null when it throws none.
function settleError(meter: SpendMeter, bucket: string, usage: Usage | null): unknown {
  try {
    meter.settle(bucket, usage);
  } catch (error) {
    return error;
  }
  return null;
}

describe('the fixture prices', () => {
  it('a 10-byte request can cost $320: 10 bytes at $2 and 100 output tokens at $3', () => {
    expect(worst(10)).toBe(320);
    expect(worst(30)).toBe(360);
  });
});

describe('reserve: the cap', () => {
  it.each([
    [319, false], // a dollar short of the worst case
    [320, true], // exactly the worst case: it fits
  ])('a cap of %i dollars and a request that can cost 320: held is %s', (cap, held) => {
    const meter = meterWith(cap);
    expect(meter.reserve('a', 10)).toBe(held);
    expect(meter.heldUsd).toBe(held ? 320 : 0);
    expect(meter.requestsOf('a')).toBe(held ? 1 : 0);
    expect(meter.refusedIn('a')).toBe(!held);
    expect(meter.refused).toBe(!held);
  });

  it.each([
    [639, false],
    [640, true], // two worst cases in two buckets fit to the dollar
  ])('a cap of %i dollars: a second bucket beside a held request is held: %s', (cap, held) => {
    const meter = meterWith(cap);
    expect(meter.reserve('a', 10)).toBe(true);
    expect(meter.reserve('b', 10)).toBe(held);
    expect(meter.refusedIn('a')).toBe(false);
    expect(meter.refusedIn('b')).toBe(!held);
    expect(meter.heldUsd).toBe(held ? 640 : 320);
  });

  it.each([
    [639, false],
    [640, true],
  ])('a cap of %i dollars: a request beside 320 already settled is held: %s', (cap, held) => {
    const meter = meterWith(cap);
    expect(meter.reserve('a', 10)).toBe(true);
    meter.settle('a', { inputTokens: 10, outputTokens: 100 }); // 10 at $2 and 100 at $3
    expect(meter.committedUsd).toBe(320);
    expect(meter.reserve('b', 10)).toBe(held);
  });

  it('settling an attempt frees what it held, so the room is there again', () => {
    const meter = meterWith(330);
    expect(meter.reserve('a', 10)).toBe(true);
    expect(meter.reserve('b', 10)).toBe(false); // 320 held and 320 more passes 330
    meter.settle('a', { inputTokens: 1, outputTokens: 1 }); // costs 5
    expect(meter.committedUsd).toBe(5);
    expect(meter.heldUsd).toBe(0);
    expect(meter.reserve('c', 10)).toBe(true); // 5 committed and 320 fit
  });

  it.each([
    ['negative', -1],
    ['not whole', 1.5],
    ['not a number', Number.NaN],
    ['not finite', Number.POSITIVE_INFINITY],
  ])('a body size that is %s is refused under any cap; a whole size is held', (_what, size) => {
    const meter = meterWith(BIG);
    expect(meter.reserve('a', size)).toBe(false);
    expect(meter.refusedIn('a')).toBe(true);
    expect(meterWith(BIG).reserve('a', 10)).toBe(true);
  });

  it('refused is sticky: neither a later request that fits nor a settle clears it', () => {
    const meter = meterWith(640);
    expect(meter.refused).toBe(false);
    expect(meter.reserve('a', 10)).toBe(true);
    expect(meter.reserve('b', 10)).toBe(true);
    expect(meter.reserve('c', 10)).toBe(false);
    meter.settle('a', { inputTokens: 1, outputTokens: 1 });
    meter.settle('b', { inputTokens: 1, outputTokens: 1 });
    expect(meter.reserve('d', 10)).toBe(true);
    expect(meter.refused).toBe(true);
    expect(meter.refusedIn('c')).toBe(true);
    expect(meter.refusedIn('d')).toBe(false);
  });
});

describe('settle: what an attempt costs', () => {
  it('one request with usage: the usage, its input at the highest input rate', () => {
    const meter = meterWith(BIG);
    meter.reserve('a', 10);
    meter.settle('a', { inputTokens: 10, outputTokens: 40 });
    expect(meter.committedUsd).toBe(140); // 10 at $2 and 40 at $3
    expect(meter.heldUsd).toBe(0);
    // measured: the input at the base rate, 10 at $1 and 40 at $3
    expect(meter.costOf('a')).toEqual({ measuredUsd: 130, upperUsd: 140 });
  });

  it('several requests with usage: the usage and the worst case of all but the smallest', () => {
    const meter = meterWith(BIG);
    // sent in this order so the smallest is neither the first nor the last
    for (const bytes of [20, 10, 30]) meter.reserve('a', bytes);
    meter.settle('a', { inputTokens: 10, outputTokens: 40 });
    // the usage, 140, and the worst cases of the 20 and 30 byte requests, 340 and 360
    expect(meter.committedUsd).toBe(840);
    expect(meter.heldUsd).toBe(0);
    // the other requests' worst cases never enter the measured cost
    expect(meter.costOf('a')).toEqual({ measuredUsd: 130, upperUsd: 840 });
  });

  it('several requests and no usage: the worst case of every one', () => {
    const meter = meterWith(BIG);
    for (const bytes of [20, 10, 30]) meter.reserve('a', bytes);
    meter.settle('a', null);
    expect(meter.committedUsd).toBe(1020); // 340 + 320 + 360
    expect(meter.costOf('a')).toEqual({ measuredUsd: 0, upperUsd: 1020 });
  });

  it('no request: nothing; the same bucket with one request and no usage costs its worst case', () => {
    const none = meterWith(BIG);
    none.settle('a', null);
    expect(none.committedUsd).toBe(0);
    expect(none.heldUsd).toBe(0);
    expect(none.requestsOf('a')).toBe(0);
    expect(none.costOf('a')).toEqual({ measuredUsd: 0, upperUsd: 0 });

    const one = meterWith(BIG);
    one.reserve('a', 10);
    one.settle('a', null);
    expect(one.committedUsd).toBe(320);
  });

  it('a bucket that never settled has no cost', () => {
    const meter = meterWith(BIG);
    meter.reserve('a', 10);
    expect(meter.costOf('a')).toEqual({ measuredUsd: 0, upperUsd: 0 });
    expect(meter.costOf('never-seen')).toEqual({ measuredUsd: 0, upperUsd: 0 });
  });

  it('settling one bucket leaves the holds of the others', () => {
    const meter = meterWith(BIG);
    meter.reserve('a', 10);
    meter.reserve('b', 10);
    meter.settle('a', null);
    expect(meter.committedUsd).toBe(320);
    expect(meter.heldUsd).toBe(320);
    expect(meter.requestsOf('b')).toBe(1);
  });

  it('a hold made after its bucket settled stays held for the rest of the run', () => {
    const meter = meterWith(BIG);
    meter.reserve('a', 10);
    meter.settle('a', null);
    expect(meter.heldUsd).toBe(0);
    expect(meter.reserve('a', 10)).toBe(true); // a late request of the settled attempt
    expect(meter.requestsOf('a')).toBe(2);
    meter.reserve('b', 10);
    meter.settle('b', null);
    expect(meter.heldUsd).toBe(320); // the late hold is still there
    expect(meter.committedUsd).toBe(640);
  });

  it('the charge never passes what the bucket held: usage at the largest body bound is capped at every worst case', () => {
    const meter = meterWith(BIG);
    meter.reserve('a', 10);
    meter.reserve('a', 30);
    expect(meter.heldUsd).toBe(680);
    // the usage is at the 30-byte bound, 360, and the request left out is the 10-byte one, so the sum
    // would be 360 for the usage and 360 for the other: 720, more than both requests can cost
    meter.settle('a', { inputTokens: 30, outputTokens: MAX_OUT });
    expect(meter.committedUsd).toBe(680);
    expect(meter.costOf('a')).toEqual({ measuredUsd: 330, upperUsd: 680 }); // measured: 30 at $1, 100 at $3
    // the control is the several-requests row above: there the sum, 840, is below what was held, 1020
  });

  it.each([
    ['one request', [10], { inputTokens: 10, outputTokens: 40 }],
    ['one request, usage at both bounds', [10], { inputTokens: 10, outputTokens: MAX_OUT }],
    ['several requests', [20, 10, 30], { inputTokens: 10, outputTokens: 40 }],
    [
      'several requests, usage at the largest body bound',
      [10, 30],
      { inputTokens: 30, outputTokens: MAX_OUT },
    ],
    ['several requests, no usage', [20, 10, 30], null],
    ['no request', [], null],
  ] as const)(
    '%s: measured cost, then the charge the cap counts, then what was held, never pass each other',
    (_what, bodies, usage) => {
      const meter = meterWith(BIG);
      for (const bytes of bodies) meter.reserve('a', bytes);
      const held = meter.heldUsd;
      meter.settle('a', usage);
      const { measuredUsd, upperUsd } = meter.costOf('a');
      expect(measuredUsd).toBeLessThanOrEqual(upperUsd);
      expect(upperUsd).toBeLessThanOrEqual(held);
    },
  );
});

describe('settle: the cap stays true', () => {
  // a cap of exactly what two buckets reserve: 680 for the first, 320 for the second
  const reservedMeter = (): SpendMeter => {
    const meter = meterWith(1000);
    meter.reserve('a', 10);
    meter.reserve('a', 30);
    meter.reserve('b', 10);
    return meter;
  };

  it.each([
    ['usage at the largest body bound', { inputTokens: 30, outputTokens: MAX_OUT }],
    ['usage well inside', { inputTokens: 5, outputTokens: 7 }],
    ['no usage', null],
  ] as const)('%s: committed and held still fit the cap after every settle', (_what, usage) => {
    const meter = reservedMeter();
    expect(meter.committedUsd + meter.heldUsd).toBe(1000);
    meter.settle('a', usage);
    expect(meter.committedUsd + meter.heldUsd).toBeLessThanOrEqual(meter.capUsd);
    meter.settle('b', { inputTokens: 10, outputTokens: MAX_OUT });
    expect(meter.committedUsd + meter.heldUsd).toBeLessThanOrEqual(meter.capUsd);
  });

  it('a request that fits what is left is not refused for an over-count', () => {
    const meter = meterWith(1000); // 680 for the first bucket, and room for one more 320
    meter.reserve('a', 10);
    meter.reserve('a', 30);
    meter.settle('a', { inputTokens: 30, outputTokens: MAX_OUT });
    expect(meter.committedUsd).toBe(680);
    expect(meter.reserve('b', 10)).toBe(true); // 680 committed and 320 fit in 1000
    expect(meter.refused).toBe(false);
  });
});

describe('settle: the runtime guards', () => {
  // a 10-byte and a 30-byte request: worst cases 320 and 360
  const twoRequests = (): SpendMeter => {
    const meter = meterWith(BIG);
    meter.reserve('a', 10);
    meter.reserve('a', 30);
    return meter;
  };

  it.each([
    ['input tokens above the largest body', { inputTokens: 31, outputTokens: 1 }, /input tokens/],
    [
      'output tokens above the output room',
      { inputTokens: 1, outputTokens: MAX_OUT + 1 },
      /output tokens/,
    ],
    ['a negative count', { inputTokens: -1, outputTokens: 1 }, /input tokens/],
    ['a count that is not a number', { inputTokens: Number.NaN, outputTokens: 1 }, /input tokens/],
    [
      'a count that is not finite',
      { inputTokens: 1, outputTokens: Number.POSITIVE_INFINITY },
      /output tokens/,
    ],
  ] as const)(
    '%s: settled at the worst case of every request, then the run aborts',
    (_what, usage, reason) => {
      const meter = twoRequests();
      const error = settleError(meter, 'a', usage);
      expect(error).toBeInstanceOf(RunAbort);
      expect(error).toHaveProperty('message', expect.stringMatching(reason));
      expect(meter.committedUsd).toBe(680); // as if no usage had been reported
      expect(meter.heldUsd).toBe(0);
      expect(meter.costOf('a')).toEqual({ measuredUsd: 0, upperUsd: 680 });
      expect(meter.refused).toBe(false);
    },
  );

  it('usage at both bounds passes: the input bound is the largest body, not the smallest', () => {
    const meter = twoRequests();
    expect(settleError(meter, 'a', { inputTokens: 30, outputTokens: MAX_OUT })).toBeNull();
    expect(meter.committedUsd).toBe(680);
  });

  it.each([
    ['input tokens', { inputTokens: 1, outputTokens: 0 }],
    ['output tokens', { inputTokens: 0, outputTokens: 7 }],
    ['both', { inputTokens: 3, outputTokens: 7 }],
    ['a negative count', { inputTokens: -1, outputTokens: 0 }],
    ['a count that is not a number', { inputTokens: Number.NaN, outputTokens: 0 }],
  ] as const)(
    'usage with %s and no request metered in the bucket is spend the meter never saw: the run aborts',
    (_what, usage) => {
      const meter = meterWith(BIG);
      meter.reserve('other', 10); // a request in another bucket does not make this one metered
      const error = settleError(meter, 'a', usage);
      expect(error).toBeInstanceOf(RunAbort);
      expect(error).toHaveProperty('message', expect.stringMatching(/no request was metered/));
      expect(meter.committedUsd).toBe(0);
      expect(meter.heldUsd).toBe(320); // only the other bucket's hold is left
      expect(meter.costOf('a')).toEqual({ measuredUsd: 0, upperUsd: 0 });
    },
  );

  it('the control: usage of nothing with no request metered passes, and costs nothing', () => {
    const meter = meterWith(BIG);
    meter.reserve('other', 10);
    expect(settleError(meter, 'a', { inputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(meter.committedUsd).toBe(0);
    expect(meter.heldUsd).toBe(320);
    expect(meter.costOf('a')).toEqual({ measuredUsd: 0, upperUsd: 0 });
  });
});

describe('meteredFetch', () => {
  it('a refused request rejects with a plain Error and the base fetch is never called', async () => {
    const { base, calls } = recordingFetch();
    const meter = meterWith(319);
    const send = meteredFetch(base, meter, () => 'a');
    const error = await send(ENDPOINT, post(bodyOf(10))).then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(Error);
    // not a TypeError: the provider utilities retry that one as a network error
    expect(error).not.toBeInstanceOf(TypeError);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(error).toHaveProperty('message', 'spend cap: request refused before sending');
    expect(calls).toHaveLength(0);
    expect(meter.refusedIn('a')).toBe(true);
    expect(meter.requestsOf('a')).toBe(0);
  });

  it('the same request under a cap that fits reaches the base fetch, body unchanged', async () => {
    const { base, calls } = recordingFetch();
    const meter = meterWith(320);
    const response = await meteredFetch(base, meter, () => 'a')(ENDPOINT, post(bodyOf(10)));
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ input: ENDPOINT, body: bodyOf(10) }]);
    expect(meter.requestsOf('a')).toBe(1);
    expect(meter.heldUsd).toBe(320);
    expect(meter.refused).toBe(false);
  });

  it.each([
    ['a Uint8Array', { method: 'POST', body: new Uint8Array([1, 2, 3]) }],
    ['a URLSearchParams', { method: 'POST', body: new URLSearchParams('a=b') }],
    ['absent', { method: 'POST' }],
  ] satisfies ReadonlyArray<readonly [string, RequestInit]>)(
    'a body that is %s has no size to read: refused under any cap, base fetch not called',
    async (_what, init) => {
      const { base, calls } = recordingFetch();
      const meter = meterWith(BIG);
      const send = meteredFetch(base, meter, () => 'a');
      await expect(send(ENDPOINT, init)).rejects.toThrow('spend cap: request refused');
      expect(calls).toHaveLength(0);
      expect(meter.refusedIn('a')).toBe(true);
      // the control: the same cap and request with a string body
      await send(ENDPOINT, post(bodyOf(10)));
      expect(calls).toHaveLength(1);
    },
  );

  it('a Request object carries its body out of sight, so it is refused too', async () => {
    const { base, calls } = recordingFetch();
    const meter = meterWith(BIG);
    const send = meteredFetch(base, meter, () => 'a');
    await expect(send(new Request(ENDPOINT, { method: 'POST', body: bodyOf(10) }))).rejects.toThrow(
      'spend cap: request refused',
    );
    expect(calls).toHaveLength(0);
  });

  it("the size is the body's UTF-8 length, whatever a header says", async () => {
    const { base } = recordingFetch();
    const meter = meterWith(BIG);
    const send = meteredFetch(base, meter, () => 'a');
    // five characters of two bytes each, and a header that claims one byte
    await send(ENDPOINT, {
      method: 'POST',
      headers: { 'content-length': '1' },
      body: 'é'.repeat(5),
    });
    expect(meter.heldUsd).toBe(worst(10));
  });

  it('reads the bucket when the request is made', async () => {
    const { base } = recordingFetch();
    const meter = meterWith(BIG);
    let current = 'a';
    const send = meteredFetch(base, meter, () => current);
    await send(ENDPOINT, post(bodyOf(10)));
    current = 'b';
    await send(ENDPOINT, post(bodyOf(10)));
    await send(ENDPOINT, post(bodyOf(10)));
    expect(meter.requestsOf('a')).toBe(1);
    expect(meter.requestsOf('b')).toBe(2);
  });

  it('a request whose base fetch rejected is counted, and its hold stays until the attempt settles', async () => {
    const failing: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    const meter = meterWith(BIG);
    const send = meteredFetch(failing, meter, () => 'a');
    await expect(send(ENDPOINT, post(bodyOf(10)))).rejects.toThrow('fetch failed');
    expect(meter.requestsOf('a')).toBe(1);
    expect(meter.refusedIn('a')).toBe(false);
    expect(meter.heldUsd).toBe(320);
  });
});

describe('trialMeter', () => {
  it('charges each attempt to its own bucket, and reports its requests and its refusal', async () => {
    const { base } = recordingFetch();
    // room for one request beside the first attempt's 140, not for two
    const meter = meterWith(700);
    const view = trialMeter(meter, 't1');
    const send = view.wrap(base);

    view.hooks.start(1);
    await send(ENDPOINT, post(bodyOf(10)));
    expect(view.hooks.end(1, { inputTokens: 10, outputTokens: 40 })).toEqual({
      requests: 1,
      refused: false,
    });

    view.hooks.start(2);
    await send(ENDPOINT, post(bodyOf(10))); // 140 committed and 320 held
    await expect(send(ENDPOINT, post(bodyOf(10)))).rejects.toThrow('spend cap');
    expect(view.hooks.end(2, null)).toEqual({ requests: 1, refused: true });
    expect(meter.refused).toBe(true);
    expect(meter.requestsOf('t1/1')).toBe(1);
    expect(meter.requestsOf('t1/2')).toBe(1);
    expect(meter.committedUsd).toBe(460); // 140 and the worst case of the second attempt's request
  });

  it("one trial's hooks do not report another trial's requests", async () => {
    const { base } = recordingFetch();
    const meter = meterWith(BIG);
    const first = trialMeter(meter, 'first');
    const second = trialMeter(meter, 'second');
    first.hooks.start(1);
    second.hooks.start(1);
    await first.wrap(base)(ENDPOINT, post(bodyOf(10)));
    expect(second.hooks.end(1, null)).toEqual({ requests: 0, refused: false });
    expect(first.hooks.end(1, null)).toEqual({ requests: 1, refused: false });
  });

  it('cost sums the settled attempts: the measured cost and the charge the cap counts', async () => {
    const { base } = recordingFetch();
    const view = trialMeter(meterWith(BIG), 't');
    const send = view.wrap(base);
    expect(view.cost()).toEqual({ measuredUsd: 0, upperUsd: 0 });

    view.hooks.start(1);
    await send(ENDPOINT, post(bodyOf(10)));
    // asked before the attempt ends: nothing is settled yet
    expect(view.cost()).toEqual({ measuredUsd: 0, upperUsd: 0 });
    view.hooks.end(1, { inputTokens: 10, outputTokens: 40 });
    expect(view.cost()).toEqual({ measuredUsd: 130, upperUsd: 140 });

    view.hooks.start(2);
    await send(ENDPOINT, post(bodyOf(10)));
    view.hooks.end(2, null); // no usage: the worst case, and nothing measured
    expect(view.cost()).toEqual({ measuredUsd: 130, upperUsd: 460 });
  });

  it('cost keeps an attempt that ended in a runtime guard, at its worst case', async () => {
    const { base } = recordingFetch();
    const view = trialMeter(meterWith(BIG), 't');
    view.hooks.start(1);
    await view.wrap(base)(ENDPOINT, post(bodyOf(10)));
    expect(() => view.hooks.end(1, { inputTokens: 11, outputTokens: 1 })).toThrow(RunAbort);
    expect(view.cost()).toEqual({ measuredUsd: 0, upperUsd: 320 });
  });

  it('a request before the first attempt starts is held in a bucket that never settles', async () => {
    const { base } = recordingFetch();
    const meter = meterWith(BIG);
    const view = trialMeter(meter, 't');
    await view.wrap(base)(ENDPOINT, post(bodyOf(10)));
    expect(meter.requestsOf('t/0')).toBe(1);
    view.hooks.start(1);
    view.hooks.end(1, null);
    expect(meter.heldUsd).toBe(320); // still held
    expect(view.cost()).toEqual({ measuredUsd: 0, upperUsd: 0 });
  });

  it('a request after an attempt ended, before the next starts, stays held in the ended attempt', async () => {
    const { base } = recordingFetch();
    const meter = meterWith(BIG);
    const view = trialMeter(meter, 't');
    const send = view.wrap(base);
    view.hooks.start(1);
    view.hooks.end(1, null);
    await send(ENDPOINT, post(bodyOf(10)));
    expect(meter.requestsOf('t/1')).toBe(1);
    expect(meter.heldUsd).toBe(320);
  });

  it('end settles the attempt it names, even after a later attempt has started', async () => {
    const { base } = recordingFetch();
    const meter = meterWith(BIG);
    const view = trialMeter(meter, 't');
    const send = view.wrap(base);
    view.hooks.start(1);
    await send(ENDPOINT, post(bodyOf(10)));
    view.hooks.start(2);
    await send(ENDPOINT, post(bodyOf(30)));
    await send(ENDPOINT, post(bodyOf(30)));
    expect(view.hooks.end(1, null)).toEqual({ requests: 1, refused: false });
    expect(meter.committedUsd).toBe(320); // the first attempt's request, not the second attempt's two
    expect(meter.heldUsd).toBe(720);
  });
});

describe('reserve and settle: the highest input rate', () => {
  it.each([
    ['the write rate is the higher', 320, PRICES, { measuredUsd: 130, upperUsd: 140 }],
    ['the base rate is the higher', 330, PRICES_LOW_WRITE, { measuredUsd: 150, upperUsd: 150 }],
  ] as const)(
    '%s: a 10-byte request can cost %i to the dollar, and usage settles at that rate',
    (_what, expected, prices, cost) => {
      const meterFor = (capUsd: number): SpendMeter =>
        createSpendMeter({ capUsd, prices, maxOutputTokens: MAX_OUT });
      // 10 bytes at the higher input rate and the whole output room at $3
      expect(meterFor(expected - 1).reserve('a', 10)).toBe(false);
      const meter = meterFor(expected);
      expect(meter.reserve('a', 10)).toBe(true);
      expect(meter.heldUsd).toBe(expected);
      // 10 input and 40 output tokens: the charge prices the input at the higher rate, the measured cost at the base rate
      meter.settle('a', { inputTokens: 10, outputTokens: 40 });
      expect(meter.costOf('a')).toEqual(cost);
    },
  );
});

describe('createSpendMeter: its own inputs', () => {
  const valid = { capUsd: 1, prices: PRICES, maxOutputTokens: MAX_OUT };
  const refusal = (over: Partial<typeof valid>): unknown => {
    try {
      createSpendMeter({ ...valid, ...over });
    } catch (thrown) {
      return thrown;
    }
    return null;
  };
  const RATES = ['input', 'cacheWrite', 'cacheRead', 'output'] as const;
  const BAD_RATES = [
    ['zero', 0],
    ['negative', -1],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ] as const;
  const BAD_AMOUNTS = [
    ['negative', -1],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ] as const;

  it.each(RATES.flatMap((rate) => BAD_RATES.map(([what, value]) => [rate, what, value] as const)))(
    'the %s price that is %s is a plain Error that names it',
    (rate, _what, value) => {
      const error = refusal({ prices: { ...PRICES, [rate]: value } });
      expect(error).toBeInstanceOf(Error);
      expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
      expect(error).toHaveProperty(
        'message',
        `createSpendMeter: prices.${rate} is not a finite number above zero`,
      );
    },
  );

  it.each([
    ...BAD_AMOUNTS.map(([what, value]) => ['capUsd', what, { capUsd: value }] as const),
    ...BAD_AMOUNTS.map(
      ([what, value]) => ['maxOutputTokens', what, { maxOutputTokens: value }] as const,
    ),
  ])('%s that is %s is a plain Error that names it', (field, _what, over) => {
    const error = refusal(over);
    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(error).toHaveProperty(
      'message',
      `createSpendMeter: ${field} is not a finite number of at least zero`,
    );
  });

  it('the controls: the valid fixture builds a meter, and zero is allowed for the cap and the output room', () => {
    expect(refusal({})).toBeNull();
    expect(createSpendMeter(valid).capUsd).toBe(1);
    // a cap of zero holds nothing; an output room of zero leaves a worst case of the body alone
    expect(refusal({ capUsd: 0 })).toBeNull();
    expect(refusal({ maxOutputTokens: 0 })).toBeNull();
    expect(createSpendMeter({ ...valid, capUsd: 0 }).reserve('a', 0)).toBe(false);
    expect(createSpendMeter({ ...valid, capUsd: BIG, maxOutputTokens: 0 }).reserve('a', 10)).toBe(
      true,
    );
  });
});
