import { describe, it, expect } from 'vitest';
import type { ParamDescriptor } from '@minitui/types';
import { bindRelaunchParams, BindError } from '../src/bind.js';

const p = (over: Partial<ParamDescriptor> & { name: string }): ParamDescriptor => ({
  label: over.name,
  classification: 'persisted',
  secret: false,
  ...over,
});

describe('bindRelaunchParams', () => {
  it('a persisted parameter takes the stored value unless an answer overrides it', () => {
    const params = [p({ name: 'codec' })];
    expect(
      bindRelaunchParams({ params, persisted: { codec: 'h264' }, answers: {} }).data.codec,
    ).toBe('h264');
    expect(
      bindRelaunchParams({ params, persisted: { codec: 'h264' }, answers: { codec: 'h265' } }).data
        .codec,
    ).toBe('h265');
  });

  it('a persisted parameter falls back to its default, and without one it is an error', () => {
    expect(
      bindRelaunchParams({
        params: [p({ name: 'codec', default: 'copy' })],
        persisted: {},
        answers: {},
      }).data.codec,
    ).toBe('copy');
    expect(() =>
      bindRelaunchParams({ params: [p({ name: 'codec' })], persisted: {}, answers: {} }),
    ).toThrow(BindError);
  });

  it('a prompt parameter needs an answer; a stored value does not stand in for it', () => {
    const params = [p({ name: 'apiKey', classification: 'prompt', secret: true })];
    expect(() => bindRelaunchParams({ params, persisted: { apiKey: 'old' }, answers: {} })).toThrow(
      BindError,
    );
    expect(
      bindRelaunchParams({ params, persisted: {}, answers: { apiKey: 'sk-live-xyz' } }).data.apiKey,
    ).toBe('sk-live-xyz');
  });

  it('reports the secret values by pointer', () => {
    const r = bindRelaunchParams({
      params: [
        p({ name: 'apiKey', classification: 'prompt', secret: true }),
        p({ name: 'codec', secret: false }),
      ],
      persisted: { codec: 'h264' },
      answers: { apiKey: 'sk-live-xyz' },
    });
    expect(r.secretPointers).toEqual(['/apiKey']);
  });

  it('escapes the slash and the tilde in a secret parameter name', () => {
    const r = bindRelaunchParams({
      params: [
        p({ name: 'a/b', classification: 'prompt', secret: true }),
        p({ name: 'a~b', classification: 'prompt', secret: true }),
      ],
      persisted: {},
      answers: { 'a/b': '1', 'a~b': '2' },
    });
    expect(r.secretPointers).toEqual(['/a~1b', '/a~0b']);
  });

  it('derived parameters resolve ${param} and ${param:default} against the bound values', () => {
    const params = [
      p({ name: 'name' }),
      p({ name: 'outfile', classification: 'derived', default: '${name:clip}.mp4' }),
    ];
    expect(
      bindRelaunchParams({ params, persisted: { name: 'wedding' }, answers: {} }).data.outfile,
    ).toBe('wedding.mp4');
    expect(
      bindRelaunchParams({
        params: [params[1] ?? p({ name: 'unreachable' })],
        persisted: {},
        answers: {},
      }).data.outfile,
    ).toBe('clip.mp4');
  });

  it('never changes the stored values it was given', () => {
    const persisted = { codec: 'h264' };
    bindRelaunchParams({ params: [p({ name: 'codec' })], persisted, answers: { codec: 'h265' } });
    expect(persisted).toEqual({ codec: 'h264' });
  });

  it('the model is a plain object made of own properties', () => {
    const r = bindRelaunchParams({
      params: [p({ name: 'codec' })],
      persisted: { codec: 'h264' },
      answers: {},
    });
    expect(Object.getPrototypeOf(r.data)).toBe(Object.prototype);
    expect(Object.keys(r.data)).toEqual(['codec']);
  });
});

describe('bindRelaunchParams against names that are members of Object.prototype', () => {
  it('a prompt parameter called toString is not answered by Object.prototype.toString', () => {
    expect(() =>
      bindRelaunchParams({
        params: [p({ name: 'toString', classification: 'prompt' })],
        persisted: {},
        answers: {},
      }),
    ).toThrow(BindError);
  });

  it('a persisted parameter called valueOf takes no value from the prototype chain', () => {
    expect(() =>
      bindRelaunchParams({ params: [p({ name: 'valueOf' })], persisted: {}, answers: {} }),
    ).toThrow(BindError);
  });

  it('a derived default refers to a bound value, never to a member of Object.prototype', () => {
    const r = bindRelaunchParams({
      params: [
        p({
          name: 'outfile',
          classification: 'derived',
          default: '${hasOwnProperty:fallback}.mp4',
        }),
      ],
      persisted: {},
      answers: {},
    });
    expect(r.data.outfile).toBe('fallback.mp4');
  });

  it.each(['__proto__', 'constructor', 'prototype'])('refuses a parameter named %s', (name) => {
    const persisted: Record<string, string> = JSON.parse(`{"${name}":"v"}`);
    expect(() => bindRelaunchParams({ params: [p({ name })], persisted, answers: {} })).toThrow(
      BindError,
    );
  });

  it('names the parameter on the error and keeps the message fixed', () => {
    try {
      bindRelaunchParams({
        params: [p({ name: 'k\u001b[31m', classification: 'prompt' })],
        persisted: {},
        answers: {},
      });
      expect.unreachable('expected a BindError');
    } catch (err) {
      expect(err).toBeInstanceOf(BindError);
      if (!(err instanceof BindError)) return;
      expect(err.message).toBe('a relaunch parameter needs an answer');
      expect(err.param).toBe('k\u001b[31m');
    }
  });
});

describe('bindRelaunchParams secret tracking through derived values', () => {
  const secretKey = p({ name: 'apiKey', classification: 'prompt', secret: true });
  const run = (params: readonly ParamDescriptor[], answers: Record<string, string>) =>
    bindRelaunchParams({ params, persisted: {}, answers });

  it('a derived parameter flagged secret is reported', () => {
    const r = run(
      [p({ name: 'token', classification: 'derived', secret: true, default: 'fixed' })],
      {},
    );
    expect(r.secretPointers).toEqual(['/token']);
  });

  it('a derived value built from a secret is reported although it is not flagged', () => {
    const r = run(
      [secretKey, p({ name: 'header', classification: 'derived', default: 'Bearer ${apiKey}' })],
      { apiKey: 'sk-live-xyz' },
    );
    expect(r.data.header).toBe('Bearer sk-live-xyz');
    expect(r.secretPointers).toEqual(['/apiKey', '/header']);
  });

  it('the secret follows a chain of derived values', () => {
    const r = run(
      [
        secretKey,
        p({ name: 'header', classification: 'derived', default: 'Bearer ${apiKey}' }),
        p({ name: 'line', classification: 'derived', default: 'Authorization: ${header}' }),
      ],
      { apiKey: 'sk-live-xyz' },
    );
    expect(r.secretPointers).toEqual(['/apiKey', '/header', '/line']);
  });

  it('a derived value that refers only to plain parameters is not reported', () => {
    const r = run(
      [
        secretKey,
        p({ name: 'name' }),
        p({ name: 'outfile', classification: 'derived', default: '${name:clip}.mp4' }),
      ],
      { apiKey: 'sk-live-xyz', name: 'wedding' },
    );
    expect(r.secretPointers).toEqual(['/apiKey']);
  });

  it('escapes the pointer of a derived secret too', () => {
    const r = run(
      [secretKey, p({ name: 'a/b', classification: 'derived', default: '${apiKey}' })],
      { apiKey: 'sk-live-xyz' },
    );
    expect(r.secretPointers).toEqual(['/apiKey', '/a~1b']);
  });
});
