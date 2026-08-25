import { describe, it, expect } from 'vitest';
import { videoMergeCatalog } from '../src/catalogs/video-merge.js';
import { videoMergeCatalog as fromBarrel } from '../src/catalogs/index.js';

describe('videoMergeCatalog', () => {
  it('registers the Slice-1 components incl. the custom FilePicker/OrderList/Button', () => {
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
