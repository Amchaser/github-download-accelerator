import { describe, it, expect } from 'vitest';
import { download, ChunkError } from '../src/engine';
import type { Mirror, Sink } from '../src/types';

const URL_ = 'https://github.com/o/r/releases/download/v1/a.exe';
const MIRRORS: Mirror[] = [
  { id: 'a', prefix: 'https://a.test/' },
  { id: 'b', prefix: 'https://b.test/' },
];

/** 内存 sink，记录每次写入，用于校验最终文件内容。 */
class MemSink implements Sink {
  readonly buf: Uint8Array;
  readonly writes: { position: number; len: number }[] = [];
  closed = false;
  aborted = false;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
  }
  async write(position: number, data: Uint8Array): Promise<void> {
    this.buf.set(data, position);
    this.writes.push({ position, len: data.byteLength });
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
}

/** 造一个按 Range 返回确定性字节的服务端（字节值 = 位置 mod 251）。 */
function rangeServer(total: number, opts: { failOn?: (start: number, end: number, mirrorPrefix: string) => number | null } = {}) {
  const calls: { prefix: string; start: number; end: number }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const prefix = MIRRORS.find((m) => url.startsWith(m.prefix))?.prefix;
    if (!prefix) return new Response(null, { status: 404 });
    const range = (init?.headers as Record<string, string>).Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    const start = Number(m![1]);
    const end = Number(m![2]);
    calls.push({ prefix, start, end });

    const forced = opts.failOn?.(start, end, prefix);
    if (forced) return new Response(null, { status: forced });
    if (end >= total) return new Response(null, { status: 416 });

    const body = new Uint8Array(end - start + 1);
    for (let i = 0; i < body.length; i++) body[i] = (start + i) % 251;
    return new Response(body, {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${total}` },
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

/** 逐字节生成期望内容。 */
function expected(total: number): Uint8Array {
  const b = new Uint8Array(total);
  for (let i = 0; i < total; i++) b[i] = i % 251;
  return b;
}

describe('download', () => {
  it('完整下载一个整除块大小之外的文件', async () => {
    const total = 4099;
    const { f } = rangeServer(total);
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(sink.buf).toEqual(expected(total));
    expect(sink.closed).toBe(true);
  });

  it('写入是按偏移定位的，不依赖完成顺序', async () => {
    const total = 2048;
    const { f } = rangeServer(total);
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 512, fetchFn: f });
    expect(sink.writes.length).toBeGreaterThan(0);
    for (const w of sink.writes) expect(w.position % 512).toBe(0);
  });

  it('并发覆盖全部区间，无重复抓取', async () => {
    const total = 4096;
    const { f, calls } = rangeServer(total);
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.start).sort((x, y) => x - y)).toEqual([0, 1024, 2048, 3072]);
  });

  it('分块跨镜像分散（至少用到两个镜像）', async () => {
    const total = 8192;
    const { f, calls } = rangeServer(total);
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(new Set(calls.map((c) => c.prefix)).size).toBeGreaterThan(1);
  });

  it('收到 200（上游忽略 Range）时判为失败，且一个字节都不写入', async () => {
    const total = 1024;
    const f = (async () => new Response(new Uint8Array(1024), { status: 200 })) as unknown as typeof fetch;
    const sink = new MemSink(total);
    await expect(
      // 200 是**可重试**的（换镜像即可），故会重试到尝试预算耗尽才失败。
      // 用极小退避：本用例验证的是「一个字节都不写」，不是退避策略。
      download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f, backoffBaseMs: 5 }),
    ).rejects.toThrow(/200/);
    expect(sink.aborted).toBe(true);
    expect(sink.buf).toEqual(new Uint8Array(total));
  });

  it('Content-Range 与请求区间不符时判为失败', async () => {
    const total = 1024;
    const f = (async () =>
      new Response(new Uint8Array(1024), {
        status: 206,
        headers: { 'content-range': `bytes 999-2022/${total}` },
      })) as unknown as typeof fetch;
    const sink = new MemSink(total);
    await expect(
      download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f, backoffBaseMs: 5 }),
    ).rejects.toThrow(/Content-Range/);
  });

  it('返回字节数不足时判为失败', async () => {
    const total = 1024;
    const f = (async () =>
      new Response(new Uint8Array(100), {
        status: 206,
        headers: { 'content-range': `bytes 0-1023/${total}` },
      })) as unknown as typeof fetch;
    const sink = new MemSink(total);
    await expect(
      download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f, backoffBaseMs: 5 }),
    ).rejects.toThrow(/字节数不足/);
  });

  it('单镜像失败后由另一镜像补上', async () => {
    const total = 2048;
    const { f } = rangeServer(total, {
      failOn: (_s, _e, prefix) => (prefix === 'https://a.test/' ? 500 : null),
    });
    // 本条**保留**真实退避：它的机制就是「健康镜像在那 200ms 退避窗口内接手」，
    // 换成极小退避会让被测行为本身消失。其余用例只是路过退避代码，故传 5 以省去等待。
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(sink.buf).toEqual(expected(total));
  });

  it('403 时对半拆分块并重试，最终成功', async () => {
    const total = 2048;
    const { f, calls } = rangeServer(total, {
      // 超过 512 字节的 Range 一律 403，拆到 512 及以下才放行
      failOn: (s, e) => (e - s + 1 > 512 ? 403 : null),
    });
    const sink = new MemSink(total);
    await download({
      url: URL_, total, mirrors: MIRRORS, sink, chunkSize: total, fetchFn: f,
      minChunkSize: 256,
    });
    expect(sink.buf).toEqual(expected(total));
    expect(calls.some((c) => c.end - c.start + 1 < total)).toBe(true);
  });

  it('拆分到下限仍持续 403 时抛出而非死循环', async () => {
    const total = 1024;
    const { f } = rangeServer(total, { failOn: () => 403 });
    const sink = new MemSink(total);
    await expect(
      download({
        url: URL_, total, mirrors: MIRRORS, sink, chunkSize: total, fetchFn: f,
        minChunkSize: 256,
        // 用极小退避：本用例验证的是「拆到下限仍失败会抛错而非死循环」，不是退避策略。
        // 真实退避（200/400/800/1600ms）下 4 个叶子块 × 3000ms ÷ 2 worker = 6000ms 下限，
        // 会超过 vitest 默认 5s 单测上限——那是超时失败，不是断言失败。
        backoffBaseMs: 5,
      }),
    ).rejects.toThrow(/403/);
    expect(sink.aborted).toBe(true);
  });

  it('全部镜像持续失败时抛错并 abort sink', async () => {
    const total = 1024;
    const f = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const sink = new MemSink(total);
    await expect(
      download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f, backoffBaseMs: 5 }),
    ).rejects.toThrow();
    expect(sink.aborted).toBe(true);
  });

  it('报进度：累计字节数单调递增至 total', async () => {
    const total = 4096;
    const { f } = rangeServer(total);
    const sink = new MemSink(total);
    const seen: number[] = [];
    await download({
      url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f,
      onProgress: (done) => seen.push(done),
    });
    expect(seen[seen.length - 1]).toBe(total);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('total 为 0 时直接收尾', async () => {
    const { f } = rangeServer(0);
    const sink = new MemSink(0);
    await download({ url: URL_, total: 0, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(sink.closed).toBe(true);
  });

  it('全部镜像都失败时不再无谓重试（快速失败）', async () => {
    const total = 1024;
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    const sink = new MemSink(total);
    await expect(
      download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f, backoffBaseMs: 5 }),
    ).rejects.toThrow();
    // 重试上限由 maxAttemptsPerChunk（默认 5）按「块」计，不是按镜像计——
    // 这里只要求「不失控」即可，不断言具体次数。
    expect(calls).toBeLessThanOrEqual(24);
  });

  it('分块长时间收不到数据时按空闲超时中断，不会永久挂起', async () => {
    // 一个永不吐数据的流：只有空闲计时能抓到（墙钟设得很长，以排除另一道防线）。
    // fake fetch 必须遵守 signal —— 真实 fetch 在 abort 时会让 body 报错，这里照实模拟，
    // 否则 abort 无法打断一个本地构造的 ReadableStream，测试会永久挂起。
    const f = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream({
        start(c) { signal?.addEventListener('abort', () => c.error(new Error('aborted'))); },
      });
      return new Response(body, {
        status: 206,
        headers: { 'content-range': 'bytes 0-1023/1024' },
      });
    }) as unknown as typeof fetch;
    const sink = new MemSink(1024);
    await expect(
      download({
        url: URL_, total: 1024, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f,
        reqIdleTimeoutMs: 20, chunkDeadlineMs: 60_000, maxAttemptsPerChunk: 1,
      }),
    ).rejects.toThrow(/空闲超时/);
    expect(sink.aborted).toBe(true);
  });

  it('滴水式慢流由墙钟死线中断——空闲超时抓不到（数据一直在来）', async () => {
    // 每 1ms 吐 1 字节且永远吐不完：空闲计时被不断重置，故空闲超时（设 60s）永不触发，
    // 只有墙钟死线（设 30ms）能中断。**这正是实测中把下载无限期拖住的形态**——
    // 两次 500MB 实测都停在 98.x%，日志无错、字节数仍在极慢增长。
    // 用 setTimeout 而非同步 enqueue，是为了让出宏任务，使计时器有机会触发。
    let abortedFlag = false;
    const f = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream({
        pull(c) {
          setTimeout(() => {
            if (signal?.aborted) { c.error(new Error('aborted')); return; }
            try { c.enqueue(new Uint8Array(1)); } catch (e) { /* 流已关闭 */ }
          }, 1);
        },
      });
      return new Response(body, {
        status: 206,
        headers: { 'content-range': 'bytes 0-1023/1024' },
      });
    }) as unknown as typeof fetch;
    // 用丢弃式 sink：本用例只关心超时行为，不关心落盘内容，也避免越界写入干扰。
    const sink: Sink = {
      async write() { /* 丢弃 */ },
      async close() {},
      async abort() { abortedFlag = true; },
    };
    await expect(
      download({
        url: URL_, total: 1024, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f,
        reqIdleTimeoutMs: 60_000, chunkDeadlineMs: 30, maxAttemptsPerChunk: 1,
      }),
    ).rejects.toThrow(/墙钟死线/);
    expect(abortedFlag).toBe(true);
  });
});

  it('单个镜像返回 200 不会拖垮整轮——健康镜像接手后下载成功', async () => {
    // 「单个镜像失效绝不能导致整个下载失败」的直接体现：200 只说明**该镜像**不遵守
    // Range，故必须可重试。先前它被当作整轮致命，一个坏镜像足以杀死其余健康镜像
    // 本可完成的下载。
    // 注意**保留真实退避**：镜像交接就发生在退避窗口内（失败方退避 200ms，空闲对等方
    // 每 10ms 轮询队列，故对等方抢得到）；注入极小退避会让失败方自己抢回去。
    const total = 2048;
    const bad = MIRRORS[0].prefix;
    const calls: string[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith(bad)) return new Response(new Uint8Array(total), { status: 200 });
      const m = /bytes=(\d+)-(\d+)/.exec((init?.headers as Record<string, string>).Range)!;
      const start = Number(m[1]), end = Number(m[2]);
      const body = new Uint8Array(end - start + 1);
      for (let i = 0; i < body.length; i++) body[i] = (start + i) % 251;
      return new Response(body, {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${total}` },
      });
    }) as unknown as typeof fetch;
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(calls.some((u) => u.startsWith(bad))).toBe(true); // 坏镜像确实被试过
    expect(sink.buf).toEqual(expected(total));               // 健康镜像补齐了全部字节
  });

  it('块写了一部分后失败并重下时，进度不重复计数、不超过 total', async () => {
    // 关键在于让失败的那次**已经写入了一些字节**：若逐次上报，重下会把这段字节
    // 重复计入进度，出现进度 > 100% 与荒谬的 ETA——而那正是本模块存在的意义所在
    // （重试与降级）的场景。只统计成功的块才不会重复。
    const total = 2048;
    let first = true;
    const f = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const m = /bytes=(\d+)-(\d+)/.exec((init?.headers as Record<string, string>).Range)!;
      const start = Number(m[1]), end = Number(m[2]);
      if (first) {
        first = false;
        let sent = false;
        const body = new ReadableStream({
          pull(c) {
            if (!sent) { sent = true; c.enqueue(new Uint8Array(64)); }
            else { c.error(new Error('boom')); }   // 写进去 64 字节后再中断
          },
        });
        return new Response(body, {
          status: 206,
          headers: { 'content-range': `bytes ${start}-${end}/${total}` },
        });
      }
      const body = new Uint8Array(end - start + 1);
      for (let i = 0; i < body.length; i++) body[i] = (start + i) % 251;
      return new Response(body, {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${total}` },
      });
    }) as unknown as typeof fetch;
    const sink = new MemSink(total);
    const seen: number[] = [];
    await download({
      url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f,
      onProgress: (done) => seen.push(done),
    });
    expect(sink.buf).toEqual(expected(total));
    expect(Math.max(...seen)).toBe(total);  // 恰好到 total；逐次上报会让它超出
  });

describe('ChunkError', () => {
  it('携带 retryable 标记', () => {
    expect(new ChunkError('x', true).retryable).toBe(true);
    expect(new ChunkError('x', false).retryable).toBe(false);
  });
  it('是 Error 的子类', () => {
    expect(new ChunkError('x', true)).toBeInstanceOf(Error);
  });
});
