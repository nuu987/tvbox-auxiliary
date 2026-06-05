#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assertNo(pattern, files, label) {
  for (const file of files) {
    assert.doesNotMatch(read(file), pattern, `${label}: residue in ${file}`);
  }
}

function assertHas(pattern, file, label) {
  assert.match(read(file), pattern, `${label}: missing in ${file}`);
}

const uiFiles = [
  'src/core/admin.ts',
  'src/core/dashboard.ts',
  'src/core/config-editor.ts',
  'src/core/shared-ui.ts',
  'src/core/shared-styles.ts',
];

const sqliteResidueFiles = [
  'src/node-entry.ts',
  'src/storage/json-file.ts',
  'scripts/build.js',
  'scripts/verify-phase18-security.cjs',
  'Dockerfile',
  'README.md',
  '.planning/PROJECT.md',
  'package.json',
  'package-lock.json',
];

assertNo(
  /translations|_translations|data-i18n|getLang|applyLang|langToggle|\.lang-toggle|localStorage\.(?:getItem|setItem)\('lang'/,
  uiFiles,
  'i18n cleanup',
);

assertNo(
  /better-sqlite3|@types\/better-sqlite3|SQLiteStorage|storage\/sqlite|storage\\sqlite|tvbox\.db|SQLite unavailable|falling back to JSON|SQLite|降级/,
  sqliteResidueFiles,
  'JSON-only storage cleanup',
);

assertNo(/verify-phase19-maintenance/, ['package.json'], 'package script absence');

assertHas(/export function isVerbose/, 'src/core/logger.ts', 'logger isVerbose export');
assertHas(/export const logger/, 'src/core/logger.ts', 'logger export');
assertHas(/new Set\(\['1', 'true', 'yes', 'on'\]\)/, 'src/core/logger.ts', 'VERBOSE true values');
assertHas(/debug\(scope: string, message: string\): void \{\s*if \(isVerbose\(\)\) console\.log/s, 'src/core/logger.ts', 'debug gate');
assertHas(/security\(message: string\): void \{\s*console\.warn\(`\[security\]/s, 'src/core/logger.ts', 'security logger');
assertHas(/export function formatFields/, 'src/core/logger.ts', 'field formatter export');
assertHas(/securityFields\(event: string, fields: LogFields\)/, 'src/core/logger.ts', 'security field logger');
assertNo(/LOG_LEVEL/, ['src/core/logger.ts', 'src/routes.ts', 'src/node-entry.ts', 'README.md', 'package.json'], 'LOG_LEVEL absence');

assertHas(/logger\.securityFields\('host-intercept'[\s\S]*path: '\/'[\s\S]*reason: 'non_lan_host'[\s\S]*smartJarUrl: smartEnabled/s, 'src/routes.ts', 'GET / security log fields');
assertHas(/logger\.securityFields\('host-intercept'[\s\S]*path: '\/live-config'[\s\S]*reason: 'non_lan_host'[\s\S]*smartJarUrl: smartEnabled/s, 'src/routes.ts', 'GET /live-config security log fields');
assertHas(/logger\.securityFields\('dmz-startup'[\s\S]*reason: 'dmz_allows_public_hosts'[\s\S]*localBaseUrl: config\.localBaseUrl/s, 'src/node-entry.ts', 'DMZ security log fields');
assertNo(/logger\.debug\('security'|VERBOSE.*DMZ|isVerbose.*DMZ/s, ['src/routes.ts', 'src/node-entry.ts'], 'security log gate absence');

assertHas(/logger\.infoFields\('aggregation', 'config-source'/, 'src/aggregator.ts', 'default source inventory logs');
assertHas(/logger\.infoFields\('aggregation', 'maccms-source'/, 'src/aggregator.ts', 'MacCMS source inventory logs');
assertHas(/logger\.infoFields\('aggregation', 'merge-inputs'/, 'src/aggregator.ts', 'merge trace logs');
assertHas(/logger\.infoFields\('aggregation', 'blacklist-removed-item'/, 'src/aggregator.ts', 'blacklist detail logs');
assertHas(/logger\.infoFields\('aggregation', 'storage-write-complete'/, 'src/aggregator.ts', 'storage trace logs');
assertHas(/removedItems: BlacklistRemovedItem\[\]/, 'src/core/blacklist.ts', 'blacklist removal detail contract');

assertNo(/console\.(?:log|warn|error)/, ['src/core/decoder.ts', 'src/core/speedtest.ts', 'src/core/maccms.ts'], 'core trace modules avoid direct console');
assertHas(/DecodeContext/, 'src/core/decoder.ts', 'decoder source context');
assertHas(/logger\.debugFields\('decoder', 'decode-start'/, 'src/core/decoder.ts', 'decoder verbose start log');
assertHas(/method: 'aes-cbc'/, 'src/core/decoder.ts', 'decoder AES CBC verbose log');
assertHas(/method: 'aes-ecb'/, 'src/core/decoder.ts', 'decoder AES ECB verbose log');
assertHas(/logger\.debugFields\('fetcher', 'direct-attempt-start'/, 'src/core/fetcher.ts', 'fetcher direct attempt log');
assertHas(/logger\.debugFields\('fetcher', 'proxy-response'/, 'src/core/fetcher.ts', 'fetcher proxy response log');
assertHas(/logger\.debugFields\('fetcher', 'multi-repo-child'/, 'src/core/fetcher.ts', 'fetcher multi-repo child log');
assertHas(/logger\.infoFields\('speedtest', 'site-test-result'/, 'src/core/speedtest.ts', 'speedtest per-site result log');
assertHas(/logger\.infoFields\('maccms', 'source-queued'/, 'src/core/maccms.ts', 'maccms source detail log');

assertHas(/new JsonFileStorage\(jsonPath\)/, 'src/node-entry.ts', 'JSON storage construction');
assertHas(/tvbox-data\.json/, 'src/node-entry.ts', 'JSON storage path');
assertHas(/DATA_DIR.*tvbox-data\.json|tvbox-data\.json.*DATA_DIR/s, 'README.md', 'README DATA_DIR JSON path');
assertHas(/VERBOSE.*1.*true.*yes.*on/s, 'README.md', 'README VERBOSE values');
assertHas(/source inventory|接口源清单|源清单/s, 'README.md', 'README logging contract');

console.log('Phase 19 maintenance verification passed');
