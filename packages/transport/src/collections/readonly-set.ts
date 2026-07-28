export function createReadonlySet<T>(values: readonly T[]): ReadonlySet<T> {
  const backing = new Set(values);
  const facade: ReadonlySet<T> = {
    get size() {
      return backing.size;
    },
    has(value) {
      return backing.has(value);
    },
    entries() {
      return backing.entries();
    },
    keys() {
      return backing.keys();
    },
    values() {
      return backing.values();
    },
    forEach(callback, thisArg) {
      for (const value of backing) callback.call(thisArg, value, value, facade);
    },
    [Symbol.iterator]() {
      return backing[Symbol.iterator]();
    },
  };
  return Object.freeze(facade);
}
