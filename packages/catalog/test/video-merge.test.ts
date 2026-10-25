import { describe, it, expect } from 'vitest';
import { videoMergeCatalog } from '../src/catalogs/video-merge.js';
import { videoMergeCatalog as fromBarrel } from '../src/catalogs/index.js';
import { rejectOffCatalog } from '../src/allowlist.js';
import { runFullValidation } from '../src/validate/index.js';
import type { AppSpec } from '../src/contract/spec.js';

describe('videoMergeCatalog', () => {
  it('registers the components incl. the custom FilePicker/OrderList/Button', () => {
    for (const c of ['Box', 'FilePicker', 'OrderList', 'Select', 'Button', 'ProgressBar', 'Text']) {
      expect(videoMergeCatalog.componentNames).toContain(c);
    }
  });

  it('tags FilePicker/OrderList/Select/Button interactive and ProgressBar/Text/Box display', () => {
    for (const c of ['FilePicker', 'OrderList', 'Select', 'Button']) {
      expect(videoMergeCatalog.tierOf(c)).toBe('interactive');
    }
    for (const c of ['ProgressBar', 'Text', 'Box']) {
      expect(videoMergeCatalog.tierOf(c)).toBe('display');
    }
  });

  it('marks the free-text FilePicker capturesText:true and every non-text widget false', () => {
    // The app-shell q-predicate keeps `q` literal only while a capturesText widget is
    // focused. FilePicker's focused handler appends typed characters (a free-text path
    // field), so it is true; Select/Button/OrderList/ProgressBar/Text/Box are non-text.
    expect(videoMergeCatalog.componentDefs.get('FilePicker')?.capturesText).toBe(true);
    for (const c of ['Select', 'Button', 'OrderList', 'ProgressBar', 'Text', 'Box']) {
      expect(videoMergeCatalog.componentDefs.get(c)?.capturesText).toBe(false);
    }
  });

  it('classifies the STATE trio render-local with no permission (STATE-only allowlist)', () => {
    for (const a of ['setState', 'pushState', 'removeState']) {
      expect(videoMergeCatalog.kindOf(a)).toBe('render-local');
      expect(videoMergeCatalog.permissionOf(a)).toBeUndefined();
    }
    // exit/log stay OFF-catalog — never registered, never exposed as render-local.
    expect(videoMergeCatalog.kindOf('exit')).toBeUndefined();
    expect(videoMergeCatalog.kindOf('log')).toBeUndefined();
    expect(videoMergeCatalog.actionNames).not.toContain('exit');
    expect(videoMergeCatalog.actionNames).not.toContain('log');
  });

  it('the merge action is exec-local + dangerous with a ffmpeg resourceTemplate', () => {
    expect(videoMergeCatalog.kindOf('merge')).toBe('exec-local');
    const perm = videoMergeCatalog.permissionOf('merge');
    expect(perm?.danger).toBe(true);
    expect(perm?.resourceTemplate).toContain('ffmpeg');
  });

  it('declares the dangerous merge action clientOnly + defaults fields clientOnly', () => {
    expect(videoMergeCatalog.callableFromOf('merge')).toBe('clientOnly');
    expect(videoMergeCatalog.visibilityOf('FilePicker')).toBe('clientOnly'); // a2ui default
  });

  it('the merge params contract accepts the resolved typed slots and rejects <2 inputs', () => {
    // The contract is usable: the params zod the exec-local gate consumes accepts the
    // resolved merge params (inputs>=2 paths, codec scalar, output path) and rejects a
    // single-input merge. (The cross-package allowlist + full-validation proof lives in
    // the integration test once the allowlist/validate lanes land — see report.)
    const merge = videoMergeCatalog.actionDefs.get('merge');
    if (merge === undefined) throw new Error('merge action must be registered');
    const ok = merge.params.safeParse({
      inputs: ['/abs/a.mp4', '/abs/b.mp4'],
      codec: 'h264',
      output: '/abs/out.mp4',
    });
    expect(ok.success).toBe(true);
    const tooFew = merge.params.safeParse({
      inputs: ['/abs/a.mp4'],
      codec: 'h264',
      output: '/abs/out.mp4',
    });
    expect(tooFew.success).toBe(false);
  });

  it('re-exports videoMergeCatalog from the catalogs barrel', () => {
    expect(fromBarrel).toBe(videoMergeCatalog);
  });
});

describe('a full merge spec', () => {
  const spec: AppSpec = {
    root: 'app',
    elements: {
      app: {
        type: 'Box',
        props: {},
        children: ['picker', 'order', 'codec', 'merge', 'progress', 'status'],
      },
      // FilePicker/OrderList write through their json-render two-way $bindState
      // bindings (the widget contract renderer-ink resolves) — no action binding needed.
      picker: { type: 'FilePicker', props: { value: { $bindState: '/inputs/0' }, label: 'Input' } },
      order: { type: 'OrderList', props: { items: { $bindState: '/inputs' } } },
      codec: {
        type: 'Select',
        props: { label: 'Codec', options: [{ label: 'H.264', value: 'h264' }] },
        on: { change: { action: 'setState', params: { statePath: '/codec', value: 'h264' } } },
      },
      merge: {
        type: 'Button',
        props: { label: 'Merge' },
        // No permission blob in the spec: PermissionDescriptor is CATALOG-owned
        // (host-trusted) — an ActionBinding carries only action + params.
        on: {
          press: {
            action: 'merge',
            params: {
              inputs: { $state: '/inputs' },
              codec: { $state: '/codec' },
              output: { $state: '/output' },
            },
          },
        },
      },
      // the adopted ProgressBar takes its fill as a number under `progress`
      progress: { type: 'ProgressBar', props: { progress: { $state: '/merge/progress' } } },
      // a Text line bound to /merge/status: the line the exec result is written to, so the
      // gate has to accept it
      status: { type: 'Text', props: { text: { $state: '/merge/status' } } },
    },
  };
  const state = {
    inputs: ['/abs/a.mp4', '/abs/b.mp4'],
    codec: 'h264',
    output: '/abs/out.mp4',
    merge: { progress: 0, status: '' },
  };

  it('passes both the allowlist and full validation', () => {
    expect(rejectOffCatalog(spec, videoMergeCatalog)).toEqual([]);
    expect(runFullValidation(spec, videoMergeCatalog, state)).toEqual({ ok: true });
  });

  it('is refused, naming both input pointers, when the state holds no inputs', () => {
    const result = runFullValidation(spec, videoMergeCatalog, { ...state, inputs: [] });
    expect(result.ok).toBe(false);
    const messages = result.ok ? [] : result.issues.map((issue) => issue.message);
    expect(messages.some((m) => m.includes('/inputs/0') && m.includes('/inputs/1'))).toBe(true);
  });
});
