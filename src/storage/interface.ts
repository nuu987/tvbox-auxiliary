// Storage interface for key-value persistence

export interface Storage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  /** Lists all keys matching the given prefix */
  list(prefix: string): Promise<string[]>;
}
