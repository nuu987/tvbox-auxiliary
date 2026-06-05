#!/usr/bin/env node

/**
 * TVBox Auxiliary — 一键启动脚本
 *
 * 检查链路：
 * 1. Node.js >= 18
 * 2. 依赖是否安装
 * 3. 数据目录是否存在
 * 4. .env 是否配置
 * 5. 端口是否可用
 * 6. 编译
 * 7. 启动
 */

const { execSync, spawn } = require('child_process');
const { existsSync, copyFileSync, readFileSync, mkdirSync, writeFileSync, statSync, readdirSync } = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DIST_FILE = path.join(ROOT, 'dist', 'server.js');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

// ─── Helpers ─────────────────────────────────────────────

function log(msg) {
  console.log(`\x1b[36m[tvbox]\x1b[0m ${msg}`);
}

function logOk(msg) {
  console.log(`\x1b[32m  ✓\x1b[0m ${msg}`);
}

function logWarn(msg) {
  console.log(`\x1b[33m  !\x1b[0m ${msg}`);
}

function logErr(msg) {
  console.error(`\x1b[31m  ✗\x1b[0m ${msg}`);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\x1b[36m  ?\x1b[0m ${question}`, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '0.0.0.0');
  });
}

/**
 * 递归检查目录中是否有比 threshold 更新的 .ts 文件
 */
function hasNewerFiles(dir, thresholdMs) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasNewerFiles(full, thresholdMs)) return true;
    } else if (entry.name.endsWith('.ts') && statSync(full).mtimeMs > thresholdMs) {
      return true;
    }
  }
  return false;
}

// ─── Checks ──────────────────────────────────────────────

async function main() {
  console.log('');
  log('TVBox Auxiliary — 启动检查');
  console.log('');

  // 1. Node.js 版本
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0]);
  if (major < 18) {
    logErr(`Node.js 18+ 必需，当前版本 v${nodeVersion}`);
    logErr('请升级 Node.js: https://nodejs.org/');
    process.exit(1);
  }
  logOk(`Node.js v${nodeVersion}`);

  // 2. 依赖安装
  const nodeModules = path.join(ROOT, 'node_modules');
  if (!existsSync(nodeModules)) {
    log('安装依赖...');
    try {
      execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
      logOk('依赖安装完成');
    } catch {
      logErr('依赖安装失败，请手动执行 npm install');
      process.exit(1);
    }
  } else {
    logOk('依赖已安装');
  }

  // 3. 数据目录
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    logOk(`数据目录已创建: ${DATA_DIR}`);
  } else {
    logOk('数据目录已存在');
  }

  // 4. .env 配置
  if (!existsSync(ENV_FILE)) {
    logWarn('未找到 .env 文件，开始初始化配置...');
    console.log('');

    const token = await ask('设置管理后台密码 (ADMIN_TOKEN): ');
    if (!token) {
      logErr('管理密码不能为空');
      process.exit(1);
    }

    const portInput = await ask('服务端口 (默认 5678): ');
    const port = portInput || '5678';

    // 读取 example 并替换
    if (!existsSync(ENV_EXAMPLE)) {
      logWarn('未找到 .env.example，使用默认配置生成 .env');
      writeFileSync(ENV_FILE, `ADMIN_TOKEN=${token}\nPORT=${port}\n`);
    } else {
      let envContent = readFileSync(ENV_EXAMPLE, 'utf-8');
      envContent = envContent.replace('ADMIN_TOKEN=changeme', `ADMIN_TOKEN=${token}`);
      envContent = envContent.replace('PORT=5678', `PORT=${port}`);
      writeFileSync(ENV_FILE, envContent);
    }

    console.log('');
    logOk(`.env 配置已保存`);
  } else {
    // 验证必填项
    const envContent = readFileSync(ENV_FILE, 'utf-8');
    if (envContent.includes('ADMIN_TOKEN=changeme') || !envContent.includes('ADMIN_TOKEN=')) {
      logWarn('请修改 .env 中的 ADMIN_TOKEN（当前为默认值）');
    }
    logOk('.env 已配置');
  }

  // 读取端口
  let port = 5678;
  if (existsSync(ENV_FILE)) {
    const envContent = readFileSync(ENV_FILE, 'utf-8');
    const portMatch = envContent.match(/^PORT=(\d+)/m);
    if (portMatch) port = parseInt(portMatch[1]);
  }

  // 5. 端口检测
  const portAvailable = await checkPort(port);
  if (!portAvailable) {
    logErr(`端口 ${port} 已被占用`);
    logErr(`请修改 .env 中的 PORT 或关闭占用该端口的程序`);
    process.exit(1);
  }
  logOk(`端口 ${port} 可用`);

  // 6. 编译（检测源码是否比构建产物更新）
  let needBuild = !existsSync(DIST_FILE);
  if (!needBuild) {
    const distMtime = statSync(DIST_FILE).mtimeMs;
    const srcDir = path.join(ROOT, 'src');
    needBuild = hasNewerFiles(srcDir, distMtime);
  }

  if (needBuild) {
    log(existsSync(DIST_FILE) ? '检测到源码变更，重新编译...' : '编译项目...');
    try {
      execSync('npm run build:node', { cwd: ROOT, stdio: 'inherit' });
      logOk('编译完成');
    } catch {
      logErr('编译失败');
      process.exit(1);
    }
  } else {
    logOk('已编译（源码无变更）');
  }

  // 7. 启动
  console.log('');
  log('启动服务...');
  console.log('');

  const child = spawn(process.execPath, [DIST_FILE], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      logErr(`进程退出，退出码: ${code}`);
    }
    process.exit(code || 0);
  });

  // 传递终止信号
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

main().catch((err) => {
  logErr(err.message);
  process.exit(1);
});
