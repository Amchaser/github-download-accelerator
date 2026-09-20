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

/**
 * 越界写入的哨兵字节。正常内容只取 0..250（`位置 mod 251`），绝不会是 0xFF，
 * 于是「越界字节是否落盘」可以被**确定性**观测，不依赖各块的完成顺序。
 */
const POISON = 0xff;

/** 在 MemSink 之上标记「是否写入过哨兵字节」。 */
class PoisonCheckedSink extends MemSink {
  poisonSeen = false;
  override async write(position: number, data: Uint8Array): Promise<void> {
    if (data.includes(POISON)) this.poisonSeen = true;
    await super.write(position, data);
  }
}

/** 造一个按 Range 返回确定性字节的服务端（字节值 = 位置 mod 251）。 */
function rangeServer(total: number, opts: {
  failOn?: (start: number, end: number, mirrorPrefix: string) => number | null;
  /**
   * 让该区间**多吐**字节数：Content-Range 与请求区间照旧，body 却更长——镜像撒谎。
   * 多吐的字节填 POISON，用于确定性地区分「越界写入」与正常内容。
   */
  overlongBy?: (start: number, end: number, mirrorPrefix: string) => number | null;
} = {}) {
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

    const len = end - start + 1;
    const extra = opts.overlongBy?.(start, end, prefix) ?? 0;
    const body = new Uint8Array(len + extra);
    for (let i = 0; i < len; i++) body[i] = (start + i) % 251;
    if (extra > 0) body.fill(POISON, len);
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
    const seen: number[] = [];
    await expect(
      download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f, backoffBaseMs: 5,
        onProgress: (done) => seen.push(done) }),
    ).rejects.toThrow(/字节数不足/);
    // 上报必须在「字节数校验通过」之后：被截断的块不得计入进度。
    // 若把 onBytes(written) 挪到校验之前，这里会看到 100 而不是空数组。
    expect(seen).toEqual([]);
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
    //
    // 这个 fake 流有三条硬性要求，缺一则本用例就不再是在测死线：
    //
    // 1. **投递量必须止于本块长度（1024 字节），一个字节都不许多。**
    //    滴水速率依平台而变（本机实测：Windows 定时器粒度 15.6ms，CI 的 Linux 约 1ms，
    //    快 30 倍以上），而 1024 这个越界门槛对此只有约 34 倍余量——太薄，会在 Linux 上被击穿：
    //    字节先灌满 1024，撞上「越界写入」守卫，断言 /墙钟死线/ 便对不上（CI run #1 即如此）。
    //    封顶之后，越界守卫在**结构上**不可能触发，于是无论平台快慢、无论滴水多快，
    //    唯一出口都只剩死线——本断言不再依赖任何计时粒度。
    // 2. **取满后 pull 须返回一个永不 settle 的 promise**，而不是直接 return：
    //    直接返回会让流认为队列仍空并立刻重入 pull，形成忙转。
    // 3. **流必须在 abort 时报错**：否则它停驻处的那个挂起 read() 永不结算，
    //    死线虽已触发、错误却传不出来，用例会以超时而非断言失败收场。
    let abortedFlag = false;
    const CHUNK_LEN = 1024;
    let sent = 0;
    const f = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream({
        start(c) {
          const kill = () => { try { c.error(new Error('aborted')); } catch (e) { /* 流已关闭 */ } };
          if (signal?.aborted) kill();
          else signal?.addEventListener('abort', kill);
        },
        pull(c) {
          // 取满本块后既不吐字节也不结束流：让块停在「差最后一个 read」的状态，
          // 从而把决定权完全交给墙钟死线。
          if (sent >= CHUNK_LEN) return new Promise<void>(() => { /* 永不 settle */ });
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              sent++;
              try { c.enqueue(new Uint8Array(1)); } catch (e) { /* 流已关闭 */ }
              resolve();
            }, 1);
          });
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

  it('单个镜像返回 404 不会拖垮整轮——健康镜像接手后下载成功', async () => {
    // 与上面的 200 用例同源：任何非 206（404 / 416 / 429 / 5xx）都只说明「该镜像这条路
    // 此刻不通」，换镜像或重试即可。先前 4xx（除 403）被当作**整轮致命**：全局 failure
    // 置位 → 所有 worker 停止 → sink.abort() 丢掉其它 worker 已完成的工作，而 FSA 下
    // 没有半成品可救。约 60 次分块请求里只要有一次撞上，整个下载就毁了。
    // 保留真实退避：镜像交接就发生在失败方的退避窗口内（本用例机制的一部分）。
    const total = 2048;
    const bad = MIRRORS[0].prefix;
    const { f, calls } = rangeServer(total, {
      failOn: (_s, _e, prefix) => (prefix === bad ? 404 : null),
    });
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(calls.some((c) => c.prefix === bad)).toBe(true); // 坏镜像确实被试过
    expect(sink.buf).toEqual(expected(total));              // 健康镜像补齐了全部字节
    expect(sink.closed).toBe(true);
  });

  it('单个镜像返回 429 时同一块按预算重试，而不是整轮立即失败', async () => {
    // 单镜像 + 单块，直接盯住「4xx 是否可重试」本身：第一次 429、第二次成功。
    // 修复前 429 被归为不可重试 → 全局 failure → 整轮失败（且 abort sink）。
    const total = 1024;
    let attempts = 0;
    const { f } = rangeServer(total, { failOn: () => (++attempts === 1 ? 429 : null) });
    const sink = new MemSink(total);
    await download({
      url: URL_, total, mirrors: [MIRRORS[0]], sink, chunkSize: 1024, fetchFn: f,
      backoffBaseMs: 5,
    });
    expect(attempts).toBe(2);
    expect(sink.buf).toEqual(expected(total));
    expect(sink.aborted).toBe(false);
  });

  it('镜像多吐字节时判为失败，越界字节一个都不写入（不污染相邻区块）', async () => {
    // 镜像声称 `bytes 0-1023/2048`，实际吐 1536 字节。若不校验上界，多出的 512 字节会被
    // 写到**邻居块**的区间上；邻居若已由别的镜像完成，就再也不会被重写——而字节数校验
    // 会抛错、本块会重下并成功，于是产出「长度完全正确、内容错误」的文件并报成功。
    // 哨兵值使「是否越界写入」与块完成顺序无关：修复前 poisonSeen 必为 true。
    const total = 2048;
    const { f } = rangeServer(total, { overlongBy: (s) => (s === 0 ? 512 : 0) });
    const sink = new PoisonCheckedSink(total);
    await expect(
      download({
        url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f,
        backoffBaseMs: 5, maxAttemptsPerChunk: 1,
      }),
    ).rejects.toThrow(/超出请求区间/);
    expect(sink.poisonSeen).toBe(false);
    expect(sink.aborted).toBe(true);
  });

  it('多吐字节的块被拒绝并重下，最终长度与内容都正确（相邻区块未被污染）', async () => {
    // 同一缺陷的成功侧：超量只发生在该块第一次，重下时守规矩——于是最终文件必须
    // 逐字节正确，且越界字节从未写进文件（哪怕它们随后会被邻居覆盖掉也算污染源）。
    const total = 2048;
    let firstChunkCalls = 0;
    const { f } = rangeServer(total, {
      overlongBy: (s) => {
        if (s !== 0) return 0;
        firstChunkCalls++;
        return firstChunkCalls === 1 ? 512 : 0;
      },
    });
    const sink = new PoisonCheckedSink(total);
    await download({
      url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f,
      backoffBaseMs: 5,
    });
    expect(firstChunkCalls).toBeGreaterThanOrEqual(2); // 该块确实被判失败并重下
    expect(sink.poisonSeen).toBe(false);               // 越界字节从未落盘
    expect(sink.buf).toEqual(expected(total));         // 含邻居区间 1024..2047 逐字节正确
    expect(sink.closed).toBe(true);
  });

  it('写入失败时取消响应体——连接仍活着，必须真正取消而不是留一条僵尸响应', async () => {
    // 写入失败（磁盘满 / 配额）是**连接仍然活着**的路径之一。此前清理只调 res.body.cancel()：
    // body 已被 getReader() 锁定，该调用会以 TypeError「ReadableStream is locked」被拒，
    // 什么都没取消——被放弃的 8 MiB 响应继续在后台排空，与重试抢带宽。
    // 本用例用一个「有数据后既不关闭也不报错」的流来代表这种连接：只有真正取消才会
    // 触发 underlying source 的 cancel()。修复前 cancelled 恒为 false。
    const total = 1024;
    let cancelled = false;
    const f = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array(64)); },   // 之后既不 enqueue 也不 close
        cancel() { cancelled = true; },
      });
      return new Response(body, {
        status: 206,
        headers: { 'content-range': `bytes 0-${total - 1}/${total}` },
      });
    }) as unknown as typeof fetch;
    const sink: Sink = {
      async write() { throw new Error('磁盘已满'); },
      async close() {},
      async abort() {},
    };
    await expect(
      download({
        url: URL_, total, mirrors: [MIRRORS[0]], sink, chunkSize: total, fetchFn: f,
        backoffBaseMs: 5, maxAttemptsPerChunk: 1, reqIdleTimeoutMs: 50,
      }),
    ).rejects.toThrow(/写入失败/);
    await new Promise((r) => setTimeout(r, 0));   // 取消在 finally 里是「刻意不 await」的，给它一个微任务
    expect(cancelled).toBe(true);
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

  it('分块请求必须带 cache: no-store —— 缓存会同时伪造速度与镜像健康度', async () => {
    // 与探针同理（见 probe.test.ts 中同名断言）：命中缓存会让显示速度与镜像排名一起失真，
    // 并且**掩盖「该镜像其实已经不通」**——缓存里有数据，网络未必有。
    const seen: (RequestCache | undefined)[] = [];
    const f = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.cache);
      const range = (init?.headers as Record<string, string>).Range;
      const m = /bytes=(\d+)-(\d+)/.exec(range)!;
      const start = Number(m[1]);
      const end = Number(m[2]);
      const body = new Uint8Array(end - start + 1);
      for (let i = 0; i < body.length; i++) body[i] = (start + i) % 251;
      return new Response(body, {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/1024` },
      });
    }) as unknown as typeof fetch;
    const sink = new MemSink(1024);
    await download({ url: URL_, total: 1024, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c === 'no-store')).toBe(true);
  });

});   // 关闭 describe('download')

describe('ChunkError', () => {
  it('携带 retryable 标记', () => {
    expect(new ChunkError('x', true).retryable).toBe(true);
    expect(new ChunkError('x', false).retryable).toBe(false);
  });
  it('是 Error 的子类', () => {
    expect(new ChunkError('x', true)).toBeInstanceOf(Error);
  });
});
