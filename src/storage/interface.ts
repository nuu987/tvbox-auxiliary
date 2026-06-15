// Storage interface for key-value persistence

export interface Storage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  /**
   * Removes a key and its value from storage.
   * No-op if the key does not exist.
   * Per CR-01: this is the correct way to delete entries — using put(key, '')
   * leaves an empty-string value that silently breaks JSON.parse consumers
   * (e.g. cleanupZombieFiles whitelist) and accumulates dead keys.
   */
  delete(key: string): Promise<void>;
  /** Lists all keys matching the given prefix */
  list(prefix: string): Promise<string[]>;
}
