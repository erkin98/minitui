import { describe, it, expect } from 'vitest';
import {
  createVisibilityChannel,
  catalogVisibilityToChannel,
  type VisibilityChannel,
  type VisibilityClass,
  type VisibilityMap,
  type CatalogVisibilityClass,
  type CatalogVisibilitySource,
} from '../src/visibility/visibility-channel.js';

const channel: VisibilityChannel = createVisibilityChannel({
  inputPath: 'modelVisible',
  apiKey: 'localOnly',
  runNote: 'modelOnly',
});

describe('VisibilityChannel.classOf', () => {
  it('returns the declared class for a known field', () => {
    expect(channel.classOf('inputPath')).toBe<VisibilityClass>('modelVisible');
    expect(channel.classOf('apiKey')).toBe('localOnly');
    expect(channel.classOf('runNote')).toBe('modelOnly');
  });
  it('defaults an undeclared field to localOnly (fail-safe-private)', () => {
    expect(channel.classOf('mysteryField')).toBe('localOnly');
  });
});

describe('VisibilityChannel.isModelVisible', () => {
  it('treats modelVisible and modelOnly as reachable by the model', () => {
    expect(channel.isModelVisible('inputPath')).toBe(true);
    expect(channel.isModelVisible('runNote')).toBe(true);
  });
  it('treats localOnly and undeclared as NOT model-reachable', () => {
    expect(channel.isModelVisible('apiKey')).toBe(false);
    expect(channel.isModelVisible('mysteryField')).toBe(false);
  });
});

describe('VisibilityChannel.projectForModel', () => {
  it('drops localOnly fields and keeps modelVisible + modelOnly', () => {
    const state = { inputPath: '/v/a.mp4', apiKey: 'sk-secret', runNote: 'merged 2', extra: 9 };
    const projected = channel.projectForModel(state);
    expect(projected).toEqual({ inputPath: '/v/a.mp4', runNote: 'merged 2' });
    expect('apiKey' in projected).toBe(false);
    expect('extra' in projected).toBe(false); // undeclared -> localOnly -> dropped
  });
  it('does not mutate the input state', () => {
    const state = { apiKey: 'sk-secret', inputPath: '/v/a.mp4' };
    channel.projectForModel(state);
    expect(state).toEqual({ apiKey: 'sk-secret', inputPath: '/v/a.mp4' });
  });
});

describe('catalogVisibilityToChannel (catalog metadata is the runtime authority)', () => {
  // A structural stand-in for @minitui/catalog's built catalog (agent-core never imports the catalog
  // package). visibilityOf/callableFromOf return the RESOLVED catalog class (a secret already folded to
  // localOnly, the clientOnly default already applied) exactly as the real index does.
  const compVis: Record<string, CatalogVisibilityClass> = {
    inputPath: 'clientOnly',
    apiKey: 'localOnly', // secret-typed: the catalog forces localOnly
    output: 'remoteOnly',
  };
  const actVis: Record<string, CatalogVisibilityClass> = {
    merge: 'remoteOnly',
    reveal: 'localOnly',
  };
  const fakeCatalog: CatalogVisibilitySource = {
    componentNames: Object.keys(compVis),
    actionNames: Object.keys(actVis),
    visibilityOf: (c) => compVis[c],
    callableFromOf: (a) => actVis[a],
  };
  const map = catalogVisibilityToChannel(fakeCatalog);

  it('maps the catalog axis onto the channel axis without unifying the vocabularies', () => {
    expect(map.apiKey).toBe<VisibilityClass>('localOnly'); // catalog localOnly -> channel localOnly
    expect(map.inputPath).toBe('localOnly'); // catalog clientOnly -> channel localOnly (default: not projected)
    expect(map.output).toBe('modelVisible'); // catalog remoteOnly -> channel modelVisible
    expect(map.reveal).toBe('localOnly'); // action localOnly -> channel localOnly
    expect(map.merge).toBe('modelVisible'); // action remoteOnly -> channel modelVisible
  });

  it('drives STATE PROJECTION from catalog metadata: the secret + clientOnly-default fields never reach the model', () => {
    const channelFromCatalog = createVisibilityChannel(map);
    const projected = channelFromCatalog.projectForModel({
      inputPath: '/v/a.mp4',
      apiKey: 'sk-secret',
      output: '/v/out.mp4',
    });
    expect(projected).toEqual({ output: '/v/out.mp4' }); // only remoteOnly `output` projects
    expect('apiKey' in projected).toBe(false); // catalog forced apiKey localOnly -> dropped from projection
    expect('inputPath' in projected).toBe(false); // clientOnly (the default) -> localOnly -> dropped (fail-private)
  });

  it('drives CALLBACK-PARAM enforcement from catalog metadata (action callableFrom)', () => {
    const channelFromCatalog = createVisibilityChannel(map);
    expect(channelFromCatalog.isModelVisible('merge')).toBe(true); // remoteOnly action -> model-drivable
    expect(channelFromCatalog.isModelVisible('reveal')).toBe(false); // localOnly action -> never a model callback param
  });

  it('fails private for an undeclared name (unknown -> localOnly)', () => {
    expect(createVisibilityChannel(map).classOf('mysteryField')).toBe('localOnly');
  });
});

// Names an ordinary object already answers to, and one that is special as an own key. A map or a state
// that needs an own `__proto__` key is built with JSON.parse; an object literal does not create one.
const INHERITED_NAMES = ['toString', 'valueOf', 'hasOwnProperty', 'constructor', '__proto__'];

function mapWithEntry(name: string, value: unknown): VisibilityMap {
  return JSON.parse(`{"${name}":${JSON.stringify(value)}}`);
}

describe('visibility fails private', () => {
  const empty = createVisibilityChannel({});

  it.each(INHERITED_NAMES)(
    'treats %s on an empty map as localOnly and not model-visible',
    (name) => {
      expect(empty.classOf(name)).toBe('localOnly');
      expect(empty.isModelVisible(name)).toBe(false);
    },
  );

  it('projects a state carrying every inherited name as own keys to an empty prototype-less object', () => {
    const state: Record<string, unknown> = JSON.parse(
      `{${INHERITED_NAMES.map((n) => `"${n}":{"x":1}`).join(',')}}`,
    );
    expect(Object.keys(state)).toHaveLength(INHERITED_NAMES.length);
    const projected = empty.projectForModel(state);
    expect(Object.keys(projected)).toEqual([]);
    expect(Object.getPrototypeOf(projected)).toBeNull();
  });

  it.each(INHERITED_NAMES)('honours an own map entry named %s', (name) => {
    const channel = createVisibilityChannel(mapWithEntry(name, 'modelVisible'));
    expect(channel.classOf(name)).toBe('modelVisible');
    const state: Record<string, unknown> = JSON.parse(`{"${name}":"kept"}`);
    const projected = channel.projectForModel(state);
    expect(Object.hasOwn(projected, name)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(projected, name)?.value).toBe('kept');
  });

  it.each<[string, unknown]>([
    ['public', 'public'],
    ['an empty string', ''],
    ['zero', 0],
    ['LOCALONLY', 'LOCALONLY'],
    ['null', null],
    ['an object', {}],
    ['true', true],
  ])('treats the class value %s as localOnly', (_label, value) => {
    const channel = createVisibilityChannel(mapWithEntry('field', value));
    expect(channel.classOf('field')).toBe('localOnly');
    expect(channel.isModelVisible('field')).toBe(false);
  });

  it('does not leak a map entry that is inherited', () => {
    const inherited: VisibilityMap = Object.create({ field: 'modelVisible' });
    const channel = createVisibilityChannel(inherited);
    expect(channel.classOf('field')).toBe('localOnly');
  });

  describe('the catalog adapter', () => {
    const source = (
      components: Record<string, CatalogVisibilityClass>,
      actions: Record<string, CatalogVisibilityClass>,
    ): CatalogVisibilitySource => ({
      componentNames: Object.keys(components),
      actionNames: Object.keys(actions),
      visibilityOf: (c) => (Object.hasOwn(components, c) ? components[c] : undefined),
      callableFromOf: (a) => (Object.hasOwn(actions, a) ? actions[a] : undefined),
    });

    it.each(INHERITED_NAMES)(
      'maps a remote-only component named %s to modelVisible as an own key',
      (name) => {
        const components: Record<string, CatalogVisibilityClass> = JSON.parse(
          `{"${name}":"remoteOnly"}`,
        );
        const map = catalogVisibilityToChannel(source(components, {}));
        expect(Object.hasOwn(map, name)).toBe(true);
        expect(Object.getOwnPropertyDescriptor(map, name)?.value).toBe('modelVisible');
        expect(Object.getPrototypeOf(map)).toBeNull();
      },
    );

    it('never widens a local-only component that shares a name with a remote-only action', () => {
      for (const name of INHERITED_NAMES) {
        const components: Record<string, CatalogVisibilityClass> = JSON.parse(
          `{"${name}":"localOnly"}`,
        );
        const actions: Record<string, CatalogVisibilityClass> = JSON.parse(
          `{"${name}":"remoteOnly"}`,
        );
        const map = catalogVisibilityToChannel(source(components, actions));
        expect(Object.getOwnPropertyDescriptor(map, name)?.value, name).toBe('localOnly');
      }
    });
  });
});
