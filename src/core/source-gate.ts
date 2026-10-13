import type { Storage } from '../storage/interface';

const gates = new WeakMap<Storage, Promise<void>>();

/** Serialize short source/output operations. Never hold this gate during network work. */
export async function withSourceGate<T>(storage: Storage, work: () => Promise<T>): Promise<T> {
  const previous = gates.get(storage) || Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => pending);
  gates.set(storage, tail);
  await previous;
  try { return await work(); }
  finally { release(); if (gates.get(storage) === tail) gates.delete(storage); }
}
