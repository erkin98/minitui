// DELIBERATE boundary violation: a non-renderer file imports React. Proves the swap-boundary wall
// (only @minitui/renderer-ink + cli may import react/ink/@json-render/ink) fires at error level via
// no-restricted-imports. Never built or shipped — the repo-wide lint ignores this directory; the
// policy-fixtures gate targets it.
import { createElement } from 'react';

export const planted = createElement;
