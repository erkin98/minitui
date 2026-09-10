import { createContext, useContext, useEffect, useId } from 'react';

// json-render does NOT expose the focus ring's focused id (its FocusContext is
// module-private) and a rendered component never receives its spec map-key (the renderer
// passes only element/emit/bindings/loading), so the app-shell — which sits ABOVE
// json-render's FocusProvider — cannot ask json-render "which element is focused?" to look
// up its catalog `capturesText`. minitui bridges it with its OWN focused-type channel, FED
// by json-render's REAL useFocus() hook: every interactive CUSTOM widget reports its
// element TYPE while it holds the ring (isActive) and clears on blur. The app-shell reads
// the focused type and resolves `capturesText` off the binding — the "is a focused
// free-text field eating this `q`?" predicate. Only minitui's own widgets report; the
// allowlisted std widgets are non-free-text (Select/Tabs/etc. act on their own keys, not
// typed characters), so a non-reporting focus reads as "not capturing" and `q` quits —
// the correct default (a display-only or std-select spec keeps a working clean-quit key).
export interface FocusTypeChannel {
  focus(reporterId: string, componentType: string): void;
  blur(reporterId: string): void;
  focusedType(): string | undefined;
}

const FocusTypeContext = createContext<FocusTypeChannel | null>(null);
export const FocusTypeProvider = FocusTypeContext.Provider;

// A plain closure channel (NOT React state): the app-shell reads focusedType() at KEYPRESS
// time inside useInput, so no re-render is needed. Keyed by the widget's useId so a Tab
// transition between two same-type widgets can never race the set/clear (each reporter
// owns its own map entry).
export function createFocusTypeChannel(): FocusTypeChannel {
  const focused = new Map<string, string>(); // reporterId -> componentType; at most one active at a time
  return {
    focus: (id, type) => {
      focused.set(id, type);
    },
    blur: (id) => {
      focused.delete(id);
    },
    focusedType: () => {
      for (const type of focused.values()) return type;
      return undefined;
    },
  };
}

// Called by every interactive CUSTOM widget after its useFocus(). Reports THIS widget's
// element type while json-render says it holds the ring, and clears on blur/unmount — so
// the channel always names the focused element's type (or undefined when a non-reporting
// widget holds focus).
export function useReportFocus(componentType: string, isActive: boolean): void {
  const channel = useContext(FocusTypeContext);
  const reporterId = useId();
  useEffect(() => {
    if (!channel || !isActive) return;
    channel.focus(reporterId, componentType);
    return () => channel.blur(reporterId);
  }, [channel, reporterId, componentType, isActive]);
}
