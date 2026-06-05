// TVBox 配置解码器
// 移植自安卓端 ApiConfig.FindResult() + AES.java
// 支持三种编码格式：图片伪装 + Base64、AES CBC 自解密、AES ECB 外部密钥

import { logger, maskSecret } from './logger';

export interface DecodeContext {
  sourceName?: string;
  sourceUrl?: string;
}

/**
 * 解码配置响应，自动检测格式
 * @param buffer 原始响应数据
 * @param configKey 可选的 AES ECB 外部密钥（来自 URL 的 ;pk; 后缀）
 * @returns 解码后的文本，或 null
 */
export async function decodeConfigResponse(
  buffer: ArrayBuffer,
  configKey?: string,
  context: DecodeContext = {},
): Promise<string | null> {
  const sourceFields = {
    source: context.sourceName || '(unnamed)',
    url: context.sourceUrl || '(unknown)',
    bytes: buffer.byteLength,
    key: configKey ? maskSecret(configKey) : '(none)',
  };
  logger.debugFields('decoder', 'decode-start', sourceFields);

  // 先用 UTF-8 解码（保留中文等多字节字符）
  const utf8Text = new TextDecoder('utf-8').decode(buffer);

  // 已经是 JSON → 直接返回 UTF-8 文本（保留中文）
  if (isJson(utf8Text)) {
    logger.debugFields('decoder', 'decode-success', { ...sourceFields, method: 'json' });
    return utf8Text;
  }

  // 非 JSON → 用 Latin-1 解码保留所有字节（用于二进制标记检测）
  const text = new TextDecoder('latin1').decode(buffer);

  // 格式 1：图片伪装 + Base64（[A-Za-z0]{8}** 标记）
  const imageDecoded = decodeImageWrapped(text);
  if (imageDecoded !== null) {
    logger.debugFields('decoder', 'decode-success', { ...sourceFields, method: 'image-base64' });
    return imageDecoded;
  }

  // 格式 2：AES CBC 自解密（2423 前缀）
  if (text.startsWith('2423')) {
    logger.debugFields('decoder', 'decode-attempt', { ...sourceFields, method: 'aes-cbc' });
    try {
      const cbcResult = await decryptAesCbc(text);
      if (cbcResult !== null) {
        logger.debugFields('decoder', 'decode-success', { ...sourceFields, method: 'aes-cbc' });
        return cbcResult;
      }
    } catch (e) {
      logger.debugFields('decoder', 'decode-failed', { ...sourceFields, method: 'aes-cbc', error: e });
    }
  }

  // 格式 3：AES ECB 外部密钥
  if (configKey && !isJson(text)) {
    logger.debugFields('decoder', 'decode-attempt', { ...sourceFields, method: 'aes-ecb' });
    try {
      const ecbResult = await decryptAesEcb(text, configKey);
      if (ecbResult !== null) {
        logger.debugFields('decoder', 'decode-success', { ...sourceFields, method: 'aes-ecb' });
        return ecbResult;
      }
    } catch (e) {
      logger.debugFields('decoder', 'decode-failed', { ...sourceFields, method: 'aes-ecb', error: e });
    }
  }

  // 都不匹配 → 返回 UTF-8 原文（可能是非标 JSON，让 parseConfigJson 处理）
  logger.debugFields('decoder', 'decode-fallback', { ...sourceFields, method: 'raw-utf8' });
  return utf8Text;
}

/**
 * 检测并解码图片伪装格式
 * 图片数据后有 [A-Za-z0]{8}** 标记，标记后 10 字符为 base64 数据
 */
function decodeImageWrapped(text: string): string | null {
  // 移植自 ApiConfig.FindResult(): Pattern.compile("[A-Za-z0]{8}\\*\\*")
  const marker = /[A-Za-z0]{8}\*\*/;
  const match = marker.exec(text);
  if (!match) return null;

  // 标记本身 10 字符（8 字符 + "**"），跳过标记取后面的 base64
  const base64Start = match.index + 10;
  const base64Data = text.substring(base64Start).trim();
  if (!base64Data) return null;

  try {
    return base64Decode(base64Data);
  } catch {
    return null;
  }
}

/**
 * AES CBC 自解密（2423 格式）
 * 移植自 ApiConfig.FindResult() + AES.CBC()
 *
 * 数据结构：
 * - 整体是 hex 字符串，以 "2423"（"$#" 的 hex）开头
 * - hex → 字符串后：
 *   - "$#" 和 "#$" 之间是 key
 *   - 最后 13 个字符是 iv
 *   - "#$" 之后到倒数第 26 字符是密文（hex 编码）
 * - key 和 iv 都右补 "0" 到 16 位
 */
async function decryptAesCbc(hexContent: string): Promise<string | null> {
  // 提取密文数据：从 "2324"（"#$" 的 hex）之后到倒数 26 字符
  const separatorIndex = hexContent.indexOf('2324');
  if (separatorIndex === -1) return null;
  const data = hexContent.substring(separatorIndex + 4, hexContent.length - 26);

  // hex → 字符串，提取 key 和 iv
  const fullStr = hexToString(hexContent).toLowerCase();
  const keyStart = fullStr.indexOf('$#');
  const keyEnd = fullStr.indexOf('#$');
  if (keyStart === -1 || keyEnd === -1) return null;

  const key = rightPadding(fullStr.substring(keyStart + 2, keyEnd), '0', 16);
  const iv = rightPadding(fullStr.substring(fullStr.length - 13), '0', 16);

  // 密文 hex → bytes
  const cipherBytes = hexToBytes(data);
  const keyBytes = new TextEncoder().encode(key);
  const ivBytes = new TextEncoder().encode(iv);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt'],
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: ivBytes }, cryptoKey, cipherBytes,
  );

  return new TextDecoder('utf-8').decode(decrypted);
}

/**
 * AES ECB 解密（外部密钥）
 * 移植自 AES.ECB()
 *
 * Web Crypto API 不支持 ECB，用逐块 CBC（zero IV）模拟
 */
async function decryptAesEcb(hexContent: string, key: string): Promise<string | null> {
  const paddedKey = rightPadding(key, '0', 16);
  const cipherBytes = hexToBytes(hexContent);
  const keyBytes = new TextEncoder().encode(paddedKey);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt'],
  );

  const zeroIv = new Uint8Array(16);
  const blocks: Uint8Array[] = [];

  // 逐块解密：ECB 每块独立，等价于 CBC + zero IV 不链接
  for (let i = 0; i < cipherBytes.length; i += 16) {
    const block = cipherBytes.slice(i, i + 16);
    // 单块 CBC 解密需要 block + 填充块以满足 PKCS7
    // 但最后一块可能包含 PKCS7 padding，所以需要特殊处理
    if (i + 16 < cipherBytes.length) {
      // 非最后一块：追加一个全 16 的 padding 块让 Web Crypto 能去除 padding
      const paddedBlock = new Uint8Array(32);
      paddedBlock.set(block, 0);
      // PKCS7 padding block: 16 bytes of 0x10
      for (let j = 16; j < 32; j++) paddedBlock[j] = 16;
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: zeroIv }, cryptoKey, paddedBlock,
      );
      blocks.push(new Uint8Array(decrypted));
    } else {
      // 最后一块：包含原始 PKCS7 padding，Web Crypto 自动去除
      // 需要确保至少有一个完整块供 decrypt 处理
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: zeroIv }, cryptoKey, block,
      );
      blocks.push(new Uint8Array(decrypted));
    }
  }

  const totalLength = blocks.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of blocks) {
    result.set(b, offset);
    offset += b.length;
  }

  return new TextDecoder('utf-8').decode(result);
}

// ---- 工具函数 ----

/**
 * 右填充字符串
 * 移植自 AES.rightPadding()
 */
function rightPadding(str: string, pad: string, length: number): string {
  let result = str;
  while (result.length < length) {
    result += pad;
  }
  return result.substring(0, length);
}

/**
 * Hex 字符串 → Uint8Array
 * 移植自 AES.toBytes()
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Hex 字符串 → 普通字符串（每 2 个 hex 字符 → 1 个 char）
 */
function hexToString(hex: string): string {
  let str = '';
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
  }
  return str;
}

/**
 * 检查文本是否为 JSON
 */
function isJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Base64 解码
 * Node.js 环境使用 Buffer
 */
function base64Decode(data: string): string {
  return Buffer.from(data, 'base64').toString('utf-8');
}
