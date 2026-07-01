// 集中化的日志环形缓冲区模块
// D-02: 独立模块，集中化模式（参考 site-store.ts / status-classifier.ts）
// D-04: 不内联 logger.ts，避免 logger 同时承担输出与存储职责
// D-05: 模块加载时自动 subscribeLogSink(push)，与 logger 单例模式一致
// D-08: 环形缓冲区 1000 条 FIFO，超限丢弃最旧
//
// Pitfall 1 (防递归): 本模块内部绝对不调用 logger.* 也不调用 console.*
// —— 否则会形成 sink→logger→sink 循环。所有错误 try/catch 静默吞掉，
// 用注释说明"防递归：不在 log-buffer 内调用 logger"。
// Pitfall 3 (console-migration 守卫): 本模块不在 exceptionFiles 列表，
// 引入任何 console.log/warn/error 都会导致 tests/core/console-migration.test.ts 失败。

import { subscribeLogSink } from './logger';
import type { LogEntry } from './logger';

// D-08: 容量 1000 条 FIFO（UPPER_SNAKE_CASE，CLAUDE.md 约定）。
const CAPACITY = 1000;

// 环形缓冲区：定长数组 + head/size 模运算（O(1) slot 复用，避免 shift O(n)）。
const buffer: LogEntry[] = new Array(CAPACITY);
let head = 0; // 指向最旧条目
let size = 0; // 当前条目数（0..CAPACITY）

// 实时订阅者（SSE 端点用）—— 与 logger sink 订阅者分离：
// logger sinks 接收所有 logger 调用，subscribers 只接收 push 后的条目。
type Subscriber = (entry: LogEntry) => void;
const subscribers = new Set<Subscriber>();

// 私有 push：环形写入 + 通知实时订阅者。
// T-06-sink: 每个订阅者回调独立 try/catch 包裹（一个异常不阻塞其他或 logger 调用方）。
// catch 静默——防递归与阻塞（Pitfall 1）。
function push(entry: LogEntry): void {
  if (size < CAPACITY) {
    buffer[(head + size) % CAPACITY] = entry;
    size++;
  } else {
    buffer[head] = entry; // 满：覆盖最旧
    head = (head + 1) % CAPACITY;
  }
  for (const fn of subscribers) {
    try { fn(entry); } catch { /* 静默：防递归——不在 log-buffer 内调用 logger */ }
  }
}

// 返回缓冲区快照，按时间顺序最旧→最新。
export function getHistory(): LogEntry[] {
  const out: LogEntry[] = [];
  for (let i = 0; i < size; i++) {
    out.push(buffer[(head + i) % CAPACITY]!);
  }
  return out;
}

// 订阅实时新日志推送，返回取消订阅函数。
// SSE 端点（Plan 02）在 stream.onAbort 时调用 unsubscribe 释放订阅（T-06-sink-leak）。
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

// 返回当前缓冲条目数（0..CAPACITY）。
export function getBufferedCount(): number {
  return size;
}

// 测试专用重置函数（重置 head/size/subscribers）。
// 仅在测试中调用，生产代码不应使用。
export function _resetForTest(): void {
  head = 0;
  size = 0;
  subscribers.clear();
}

// D-05: 模块加载时自动订阅 logger sink——与 logger 单例模式一致，
// 避免显式 init 遗漏。log-buffer 模块被 import 即建立 sink→push 链。
subscribeLogSink(push);
