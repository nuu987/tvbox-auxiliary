#!/usr/bin/env node

const { build } = require('esbuild');
const path = require('path');
const fs = require('fs');

build({
  entryPoints: [path.join(__dirname, '..', 'src', 'node-entry.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(__dirname, '..', 'dist', 'server.js'),
  format: 'cjs',
}).then(() => {
  // Copy static fonts to dist/
  const srcDir = path.join(__dirname, '..', 'src', 'static', 'fonts');
  const dstDir = path.join(__dirname, '..', 'dist', 'static', 'fonts');
  if (fs.existsSync(srcDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of fs.readdirSync(srcDir)) {
      fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    }
  }
  console.log('Build complete: dist/server.js');
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
