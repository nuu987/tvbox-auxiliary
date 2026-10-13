// Bundle focused TypeScript regressions with the existing build dependency.
const { buildSync } = require('esbuild');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const directory = mkdtempSync(path.join(tmpdir(), 'tvbox-source-fallback-'));
try {
  const typeCheck = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'),
    '--project', path.resolve(__dirname, '../tsconfig.test.json')], { stdio: 'inherit' });
  if (typeCheck.status !== 0) throw new Error('Source fallback test type-check failed');
  const output = path.join(directory, 'source-fallback.test.cjs');
  buildSync({ entryPoints: [path.resolve(__dirname, '../tests/source-fallback.test.ts')],
    outfile: output, bundle: true, platform: 'node', target: 'node20', format: 'cjs' });
  const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit',
    env: { ...process.env, DATA_DIR: path.join(directory, 'data') } });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
