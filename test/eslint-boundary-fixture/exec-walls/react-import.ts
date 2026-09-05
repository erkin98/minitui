// DELIBERATE violation: an exec file imports React. Proves the exec re-permit block still bans
// react/ink (only renderer-ink + cli may import them). Exercised by the policy-fixtures gate.
import { createElement } from 'react';

export const planted = createElement;
