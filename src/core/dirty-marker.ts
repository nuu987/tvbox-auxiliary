import type { Storage } from '../storage/interface';
import { logger } from './logger';

export const DIRTY_MARKER_KEY = 'dirty_marker';

export async function setDirtyMarker(storage: Storage): Promise<void> {
  await storage.put(DIRTY_MARKER_KEY, '1');
}

export async function getDirtyMarker(storage: Storage): Promise<boolean> {
  const raw = await storage.get(DIRTY_MARKER_KEY);
  return raw === '1';
}

export async function clearDirtyMarker(storage: Storage): Promise<void> {
  await storage.put(DIRTY_MARKER_KEY, '');
  logger.info('dirty-marker', 'cleared');
}