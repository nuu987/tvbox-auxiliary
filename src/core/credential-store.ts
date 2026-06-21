// 网盘凭证加密存储

import type { Storage } from '../storage/interface';
import type { CloudPlatform, CloudCredential, CredentialPolicyConfig } from './types';
import { CLOUD_CREDENTIALS, CREDENTIAL_POLICY, CREDENTIAL_ENCRYPTION_KEY } from './config';
import { logger } from './logger';
import { webcrypto } from 'crypto';

type CryptoKey = webcrypto.CryptoKey;
const subtle = webcrypto.subtle;

// ─── AES-GCM 加密层 ─────────────────────────────────────

async function getOrCreateEncryptionKey(storage: Storage): Promise<CryptoKey> {
  const raw = await storage.get(CREDENTIAL_ENCRYPTION_KEY);

  if (raw) {
    const keyData = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    return subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  // 首次使用：生成随机 256-bit key
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as CryptoKey;
  const exported = await subtle.exportKey('raw', key) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  await storage.put(CREDENTIAL_ENCRYPTION_KEY, b64);

  // 返回不可导出的版本
  return subtle.importKey('raw', exported, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  // iv (12 bytes) + ciphertext → base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decrypt(key: CryptoKey, encrypted: string): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plainBuffer = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuffer);
}

// ─── 凭证 CRUD ──────────────────────────────────────────

export async function loadCredentials(storage: Storage): Promise<Map<CloudPlatform, CloudCredential>> {
  const map = new Map<CloudPlatform, CloudCredential>();
  const raw = await storage.get(CLOUD_CREDENTIALS);
  if (!raw) return map;

  try {
    const key = await getOrCreateEncryptionKey(storage);
    const json = await decrypt(key, raw);
    const arr: CloudCredential[] = JSON.parse(json);
    for (const cred of arr) {
      map.set(cred.platform, cred);
    }
  } catch (err) {
    logger.error('credential-store', `Failed to decrypt credentials: ${err instanceof Error ? err.message : String(err)}`);
  }

  return map;
}

export async function saveCredential(storage: Storage, credential: CloudCredential): Promise<void> {
  const existing = await loadCredentials(storage);
  existing.set(credential.platform, credential);

  const key = await getOrCreateEncryptionKey(storage);
  const json = JSON.stringify([...existing.values()]);
  const encrypted = await encrypt(key, json);
  await storage.put(CLOUD_CREDENTIALS, encrypted);
}

export async function deleteCredential(storage: Storage, platform: CloudPlatform): Promise<void> {
  const existing = await loadCredentials(storage);
  if (!existing.has(platform)) return;

  existing.delete(platform);
  const key = await getOrCreateEncryptionKey(storage);

  if (existing.size === 0) {
    await storage.put(CLOUD_CREDENTIALS, '');
    return;
  }

  const json = JSON.stringify([...existing.values()]);
  const encrypted = await encrypt(key, json);
  await storage.put(CLOUD_CREDENTIALS, encrypted);
}

// ─── 凭证策略 CRUD ──────────────────────────────────────

const DEFAULT_POLICY: CredentialPolicyConfig = {
  allowedHighRiskKeys: [],
  deniedKeys: [],
};

export async function loadCredentialPolicy(storage: Storage): Promise<CredentialPolicyConfig> {
  const raw = await storage.get(CREDENTIAL_POLICY);
  if (!raw) return { ...DEFAULT_POLICY };
  try {
    return JSON.parse(raw);
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export async function saveCredentialPolicy(storage: Storage, policy: CredentialPolicyConfig): Promise<void> {
  await storage.put(CREDENTIAL_POLICY, JSON.stringify(policy));
}
