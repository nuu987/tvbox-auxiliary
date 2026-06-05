// JSON file storage for Node/Docker persistence

import { logger } from '../core/logger';
import type { Storage } from './interface';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export class JsonFileStorage implements Storage {
  private data: Record<string, string>;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (existsSync(filePath)) {
      try {
        this.data = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn('storage', `Failed to parse JSON file ${filePath}, starting empty: ${msg}`);
        this.data = {};
      }
    } else {
      this.data = {};
    }
  }

  async get(key: string): Promise<string | null> {
    return this.data[key] ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data[key] = value;
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('storage', `Failed to write JSON file ${this.filePath}: ${msg}`);
      throw error;
    }
  }
}
