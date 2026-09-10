import { describe, it, expect, expectTypeOf } from 'vitest';
import type { WidgetCatalogBinding } from '../src/widget-binding.js';

describe('WidgetCatalogBinding', () => {
  it('the module resolves as a valid ESM module', async () => {
    // The interface is type-only, so a static `import type` erases at runtime and
    // cannot witness the file's existence. A dynamic import is not erased: it
    // rejects until src/widget-binding.ts exists, then resolves to the module namespace.
    const mod = await import('../src/widget-binding.js');
    expect(mod).toBeDefined();
  });

  it('resolves a known component to factory + trust tier, undefined otherwise', () => {
    const binding: WidgetCatalogBinding<string> = {
      catalogId: 'video-merge',
      resolve(componentId) {
        // capturesText: a FREE-TEXT-capturing widget (a path field that consumes typed
        // characters) is `true`; a display/select widget is `false`. The app-shell reads this
        // bit to keep `q` as literal input while a free-text widget is focused, and quit otherwise.
        if (componentId === 'FilePicker')
          return { factory: 'file-picker-widget', trustTier: 'interactive', capturesText: true };
        if (componentId === 'ProgressBar')
          return { factory: 'progress-widget', trustTier: 'display', capturesText: false };
        return undefined;
      },
    };

    expect(binding.catalogId).toBe('video-merge');
    expect(binding.resolve('FilePicker')).toEqual({
      factory: 'file-picker-widget',
      trustTier: 'interactive',
      capturesText: true,
    });
    expect(binding.resolve('ProgressBar')?.trustTier).toBe('display');
    expect(binding.resolve('ProgressBar')?.capturesText).toBe(false);
    expect(binding.resolve('Unknown')).toBeUndefined();
  });

  it('trustTier is the closed display|interactive union; capturesText is a definite boolean', () => {
    expectTypeOf<
      NonNullable<ReturnType<WidgetCatalogBinding['resolve']>>['trustTier']
    >().toEqualTypeOf<'display' | 'interactive'>();
    expectTypeOf<
      NonNullable<ReturnType<WidgetCatalogBinding['resolve']>>['capturesText']
    >().toEqualTypeOf<boolean>();
  });
});
