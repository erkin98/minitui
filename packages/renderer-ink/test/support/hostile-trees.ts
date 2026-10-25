import type { AppSpec, JsonValue } from '@minitui/types';

// Seeded generator of hostile app trees. Every tree uses only the catalog components Box and Text
// and layout props of the adopted Box, so each one is a spec the generation gate accepts. The seed
// is a constant: every run is the same set.

// Text every tree draws, so that a frame holding it shows part of the app.
export const APP_MARKER = 'APP-TEXT';

export interface HostileTree {
  readonly name: string;
  readonly spec: AppSpec;
  readonly columns: number;
  // when set, the terminal is resized to this many columns between the request opening and its decision
  readonly resizeTo?: number;
}

type Element = AppSpec['elements'][string];
type Props = Record<string, JsonValue>;

// mulberry32: a tiny seeded generator
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARGINS = [-30, -12, -3, -1, 1, 3, 12, 40];
const WIDTHS: Array<number | string> = ['150%', '200%', '300%', 120, 200, 400];
const COLUMNS = [20, 30, 40, 80, 100];
const SIDES = ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginX', 'marginY'];

// What a hazard can change about the tree under construction.
interface Build {
  readonly i: number;
  readonly elements: Record<string, Element>;
  readonly children: string[];
  readonly rootProps: Props;
  readonly next: () => number;
  readonly pick: <T>(list: readonly T[]) => T;
  readonly text: (id: string) => string;
}

const hazards: Array<(b: Build) => void> = [
  (b) => {
    b.rootProps.marginBottom = b.pick(MARGINS);
  },
  (b) => {
    b.rootProps.marginTop = b.pick(MARGINS);
  },
  (b) => {
    const nested: Props = { flexDirection: 'column' };
    for (let n = 0; n < 3; n++) nested[b.pick(SIDES)] = b.pick(MARGINS);
    b.elements[`b${b.i}`] = { type: 'Box', props: nested, children: [b.text(`t${b.i}n`)] };
    b.children.push(`b${b.i}`);
  },
  (b) => {
    b.elements[`o${b.i}`] = {
      type: 'Box',
      props: { overflow: 'hidden', width: b.pick([5, 10, 20]), height: b.pick([1, 2, 3]) },
      children: [b.text(`t${b.i}o`)],
    };
    b.children.push(`o${b.i}`);
  },
  (b) => {
    b.elements[`w${b.i}`] = {
      type: 'Box',
      props: { width: b.pick(WIDTHS), flexDirection: 'column' },
      children: [b.text(`t${b.i}w`)],
    };
    b.children.push(`w${b.i}`);
  },
  (b) => {
    const lines = 60 + Math.floor(b.next() * 140);
    for (let n = 0; n < lines; n++) b.children.push(b.text(`t${b.i}l${n}`));
  },
  (b) => {
    b.rootProps.marginLeft = b.pick([-40, -20, -5]);
    b.rootProps.marginRight = b.pick([-40, -20, -5]);
  },
  (b) => {
    b.rootProps.marginBottom = b.pick(MARGINS);
    b.rootProps.marginTop = b.pick(MARGINS);
    b.elements[`c${b.i}`] = {
      type: 'Box',
      props: { width: b.pick(WIDTHS), marginBottom: b.pick(MARGINS), flexDirection: 'column' },
      children: [b.text(`t${b.i}c`), b.text(`t${b.i}d`)],
    };
    b.children.push(`c${b.i}`);
  },
];

function buildTree(i: number, next: () => number): HostileTree {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const elements: Record<string, Element> = {};
  const text = (id: string): string => {
    elements[id] = {
      type: 'Text',
      props: { text: `${APP_MARKER} ${id} ${'x'.repeat(Math.floor(next() * 60))}` },
    };
    return id;
  };
  const children: string[] = [text(`t${i}a`)];
  const rootProps: Props = { flexDirection: 'column' };
  const build: Build = { i, elements, children, rootProps, next, pick, text };

  // the first trees pin the two bottom margins the set must contain; the rest are drawn at random
  const hazard = i < hazards.length ? i : Math.floor(next() * hazards.length);
  hazards[hazard]?.(build);
  if (i === 0) rootProps.marginBottom = -12;
  if (i === 1) rootProps.marginBottom = -30;

  elements.root = { type: 'Box', props: rootProps, children };
  const columns = pick(COLUMNS);
  const resizeTo = next() < 0.25 ? pick(COLUMNS) : undefined;
  return {
    name: `tree-${i}-hazard-${hazard}`,
    spec: { root: 'root', elements },
    columns,
    ...(resizeTo !== undefined ? { resizeTo } : {}),
  };
}

export function hostileTrees(count = 220): HostileTree[] {
  const next = seeded(20260719);
  return Array.from({ length: count }, (_, i) => buildTree(i, next));
}
