#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase18-security-'));
const bundledRoutes = path.join(tempDir, 'routes.cjs');

function withEnv(values, fn) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(values)) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

class MemoryStorage {
  constructor(entries) {
    this.map = new Map(Object.entries(entries));
  }

  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async put(key, value) {
    this.map.set(key, value);
  }
}

function createTestApp({ smartJarUrl = true } = {}) {
  const { createApp } = require(bundledRoutes);
  const mergedConfig = JSON.stringify({
    sites: [
      {
        key: 'demo',
        name: 'Demo',
        type: 3,
        api: '__TVBOX_BASE_URL__/jar/demo',
      },
    ],
    lives: [
      {
        name: 'Live',
        url: '__TVBOX_BASE_URL__/live/demo.m3u',
      },
    ],
  });
  const storage = new MemoryStorage({
    merged_config: mergedConfig,
    smart_jar_url_enabled: String(smartJarUrl),
  });

  return createApp({
    storage,
    config: {
      speedTimeoutMs: 5000,
      siteTimeoutMs: 3000,
      fetchTimeoutMs: 5000,
    },
    triggerRefresh: async () => undefined,
  });
}

async function request(app, target, headers) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const response = await app.request(target, { headers });
    const body = await response.text();
    return { status: response.status, body, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

async function expectStatus(name, options, expectedStatus, expectedBody) {
  const result = await withEnv(
    {
      DMZ: options.dmz ? '0' : undefined,
    },
    async () => {
      const app = createTestApp({ smartJarUrl: options.smartJarUrl !== false });
      return request(app, options.path || '/', options.headers || {});
    },
  );

  assert.equal(result.status, expectedStatus, `${name}: expected HTTP ${expectedStatus}, got ${result.status} with body ${result.body}`);
  if (expectedBody !== undefined) {
    assert.equal(result.body, expectedBody, `${name}: unexpected response body`);
  }
  return result;
}

async function main() {
  require('esbuild').buildSync({
    entryPoints: [path.join(root, 'src', 'routes.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    outfile: bundledRoutes,
    format: 'cjs',
    logLevel: 'silent',
  });

  await expectStatus(
    'public Host rejected',
    { headers: { Host: '203.0.113.5' } },
    403,
    'Forbidden',
  );

  await expectStatus(
    'spoofed X-Forwarded-Host rejected by default on GET /',
    { headers: { Host: 'example.com', 'X-Forwarded-Host': '192.168.1.5' } },
    403,
    'Forbidden',
  );

  await expectStatus(
    'spoofed X-Forwarded-Host rejected by default on GET /live-config',
    { path: '/live-config', headers: { Host: 'example.com', 'X-Forwarded-Host': '192.168.1.5' } },
    403,
    'Forbidden',
  );

  const dmzForwarded = await expectStatus(
    'DMZ=0 allows forwarded LAN host',
    { dmz: true, headers: { Host: 'example.com', 'X-Forwarded-Host': '198.51.100.2, 192.168.1.5', 'X-Forwarded-Proto': 'https' } },
    200,
  );
  assert.match(dmzForwarded.body, /https:\/\/192\.168\.1\.5\/jar\/demo/, 'DMZ=0 should allow substituting the closest forwarded LAN host');

  for (const host of ['[::1]:5678', '[fc00::1]:5678', '[fd12::1]:5678', '[fe80::1]:5678']) {
    await expectStatus(`IPv6 LAN host allowed: ${host}`, { headers: { Host: host } }, 200);
  }

  await expectStatus(
    'IPv4-mapped IPv6 rejected',
    { headers: { Host: '[::ffff:127.0.0.1]:5678' } },
    403,
    'Forbidden',
  );

  await expectStatus(
    'DMZ=0 allows public host',
    { dmz: true, headers: { Host: 'example.com' } },
    200,
  );

  const smartOff = await expectStatus(
    'smartJarUrl disabled skips intercept',
    { smartJarUrl: false, headers: { Host: 'example.com' } },
    200,
  );
  assert.doesNotMatch(smartOff.body, /example\.com/, 'smartJarUrl disabled should not use request host for substitution');

  console.log('Phase 18 security verification passed: 11 checks');
}

main()
  .catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
