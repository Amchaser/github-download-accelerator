import { plan, splitChunk } from './planner';
import type { Chunk, Mirror, Sink } from './types';

/** 退避基数（毫秒）。第 n 次重试等待 BASE * 2^n。 */
export const BACKOFF_BASE_MS = 200;

/**
 * 单个请求的「空闲」超时（毫秒）：只要还在出数据就不算超时。
 * 抓的是**完全停住**的流。
 */
export const REQ_IDLE_TIMEOUT_MS = 30_000;

/**
 * 单个分块的「墙钟」死线（毫秒）：从发起到完成的总时长上限，与是否有数据无关。
 * **空闲超时抓不到滴水式限速**——那种流每几秒吐几个字节，会不断重置空闲计时；
 * 只有按墙钟计时的死线能中断它。此条有实测依据：两次 500MB 实测都停在 98.x%，
 * 日志无任何错误、字节数仍在极慢增长，正是这个形态把下载无限期拖住。
 * 两者**都要**：只有空闲超时抓不到滴水，只有墙钟会误杀慢但一直有数据的镜像。
 */
export const CHUNK_DEADLINE_MS = 90_000;

export class ChunkError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ChunkError';
  }
}

export interface DownloadOptions {
  url: string;
  total: number;
  mirrors: Mirror[];
  sink: Sink;
  chunkSize?: number;
  fetchFn?: typeof fetch;
  onProgress?: (bytesDone: number) => void;
  /** 单块持续失败的硬上限，防止病态重试。 */
  maxAttemptsPerChunk?: number;
  /** 403 拆分降级的块大小下限，默认 MIN_CHUNK_SIZE。测试用小值驱动拆分逻辑。 */
  minChunkSize?: number;
  /** 单请求空闲超时，默认 REQ_IDLE_TIMEOUT_MS。测试用极小值驱动超时逻辑。 */
  reqIdleTimeoutMs?: number;
  /** 单分块墙钟死线，默认 CHUNK_DEADLINE_MS。测试用极小值驱动。 */
  chunkDeadlineMs?: number;
  /** 退避基数，默认 BACKOFF_BASE_MS。测试用极小值让它不必真等指数退避。 */
  backoffBaseMs?: number;
}

/** 队列暂空但仍有块未完成时，worker 的轮询间隔。 */
export const SPIN_MS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 抓取单块并写入 sink。
 * 严格校验 206 与 Content-Range：上游忽略 Range 返回 200 时若继续写入，
 * 会把整包内容落到部分文件上，静默产出损坏文件——必须判为失败。
 */
async function fetchChunk(
  mirror: Mirror,
  url: string,
  chunk: Chunk,
  fetchFn: typeof fetch,
  sink: Sink,
  onBytes: (n: number) => void,
  idleTimeoutMs: number,
  chunkDeadlineMs: number,
): Promise<void> {
  const label = `镜像 ${mirror.prefix} 区块 bytes=${chunk.start}-${chunk.end}`;

  // 两道计时同时存在，缺一不可：
  //   - 空闲超时：每次读取前重新计时，抓「完全停住」的流；
  //   - 墙钟死线：整块一次计时、永不重置，抓「滴水式限速」——那种流每几秒吐几个字节，
  //     会把空闲计时不断重置，只有按墙钟计时的死线能中断它（有实测依据，见常量注释）。
  // 两者都经 AbortController 中断请求。**先触发的那道决定标签**（`if (!fired)`）：
  // 否则墙钟触发后循环继续、空闲计时会覆盖标签，把「滴水」误报成「停住」。
  const ac = new AbortController();
  let fired: '空闲超时' | '墙钟死线' | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!fired) fired = '空闲超时'; ac.abort(); }, idleTimeoutMs);
  };
  const deadlineTimer = setTimeout(() => { if (!fired) fired = '墙钟死线'; ac.abort(); }, chunkDeadlineMs);

  try {
    armIdle();
    let res: Response;
    try {
      res = await fetchFn(mirror.prefix + url, {
        headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
        signal: ac.signal,
      });
    } catch (e) {
      if (fired) {
        throw new ChunkError(`${label} ${fired}：请求未完成（空闲 ${idleTimeoutMs / 1000}s / 墙钟 ${chunkDeadlineMs / 1000}s）`, true);
      }
      throw new ChunkError(`${label} 网络错误: ${(e as Error).message}`, true);
    }

    if (res.status === 403) {
      throw new ChunkError(`${label} HTTP 403（疑似大 Range 被拒）`, true);
    }
    if (res.status === 200) {
      throw new ChunkError(
        `${label} HTTP 200：上游忽略了 Range 请求，无法分块下载`,
        false,
      );
    }
    if (res.status !== 206) {
      throw new ChunkError(`${label} HTTP ${res.status}`, res.status >= 500);
    }

    const cr = res.headers.get('content-range');
    const expectPrefix = `bytes ${chunk.start}-${chunk.end}/`;
    if (!cr || !cr.startsWith(expectPrefix)) {
      throw new ChunkError(`${label} Content-Range 不符：期望前缀 "${expectPrefix}"，收到 "${cr}"`, true);
    }

    if (!res.body) throw new ChunkError(`${label} 响应没有 body`, true);

    const reader = res.body.getReader();
    let pos = chunk.start;
    for (;;) {
      armIdle();
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        if (fired) {
          throw new ChunkError(`${label} ${fired}（已读到 ${pos}）：疑似该镜像滴水式限速或卡住，换镜像重试`, true);
        }
        throw new ChunkError(`${label} 流中断: ${(e as Error).message}`, true);
      }
      if (r.done) break;
      // 写入期间停掉空闲计时：一次慢写入不该被误标成「镜像流超时」，它由墙钟死线兜住。
      clearTimeout(idleTimer);
      if (r.value && r.value.byteLength > 0) {
        // 本 worker 内串行 await（同一块内至多一个写入在途），且读完即写即弃——
        // 不累积，故内存与文件大小无关。跨 worker 的并发写是安全的：FSA 内部对写入
        // 排队串行化，且显式 position 使写入顺序无关（见 Global Constraints）。
        await sink.write(pos, r.value);
        pos += r.value.byteLength;
        onBytes(r.value.byteLength);
      }
    }

    if (pos !== chunk.end + 1) {
      throw new ChunkError(`${label} 字节数不足：期望 ${chunk.end + 1 - chunk.start} 字节，实收 ${pos - chunk.start} 字节`, true);
    }
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(deadlineTimer);
  }
}

interface Job {
  chunk: Chunk;
  attempts: number;
}

export async function download(opts: DownloadOptions): Promise<void> {
  const {
    url,
    total,
    mirrors,
    sink,
    chunkSize,
    fetchFn = fetch,
    onProgress,
    maxAttemptsPerChunk = 5,
    minChunkSize,
    reqIdleTimeoutMs = REQ_IDLE_TIMEOUT_MS,
    chunkDeadlineMs = CHUNK_DEADLINE_MS,
    backoffBaseMs = BACKOFF_BASE_MS,
  } = opts;

  let bytesDone = 0;
  const onBytes = (n: number) => {
    bytesDone += n;
    onProgress?.(bytesDone);
  };

  if (mirrors.length === 0) {
    await sink.abort();
    throw new Error('没有可用镜像');
  }

  // 待办队列。JS 单线程，shift() 天然原子，无需锁。
  const queue: Job[] = plan(total, chunkSize).map((chunk) => ({ chunk, attempts: 0 }));
  /** 尚未成功完成的块数。worker 只在它归零时退出——这是坏镜像不拖垮整体的关键。 */
  let outstanding = queue.length;
  /** 首个不可恢复的错误。一旦置位，所有 worker 尽快退出。 */
  let failure: Error | null = null;

  const worker = async (mirror: Mirror): Promise<void> => {
    while (outstanding > 0 && !failure) {
      const job = queue.shift();
      if (!job) {
        // 队列暂空但仍有块未完成（正被别的 worker 持有），短暂轮询等待。
        await sleep(SPIN_MS);
        continue;
      }

      try {
        await fetchChunk(mirror, url, job.chunk, fetchFn, sink, onBytes, reqIdleTimeoutMs, chunkDeadlineMs);
        outstanding--;
      } catch (e) {
        const err = e instanceof ChunkError ? e : new ChunkError(String(e), true);

        // 不可重试（如上游忽略 Range 返回 200）→ 全局放弃。
        // 此时继续写会产出损坏文件，绝不能容忍。
        if (!err.retryable) {
          failure = err;
          return;
        }

        job.attempts++;

        // 403 优先走「对半拆分」降级：把 Range 缩小再试
        if (/403/.test(err.message)) {
          const halves = splitChunk(job.chunk, minChunkSize);
          if (halves) {
            queue.push({ chunk: halves[0], attempts: 0 }, { chunk: halves[1], attempts: 0 });
            outstanding++; // 一块变两块
            continue;
          }
        }

        if (job.attempts >= maxAttemptsPerChunk) {
          failure = err;
          return;
        }

        // 放回队尾让其他健康镜像接手。本 worker 随即退避，而空闲的对等 worker
        // 每 SPIN_MS 轮询一次队列，因此健康镜像总能先抢到该块。
        queue.push(job);
        await sleep(backoffBaseMs * 2 ** (job.attempts - 1));
      }
    }
  };

  try {
    await Promise.all(mirrors.map(worker));
    if (failure) throw failure;
    if (outstanding > 0) throw new Error(`下载未完成，仍有 ${outstanding} 个分块未获取`);
    await sink.close();
  } catch (e) {
    await sink.abort();
    throw e;
  }
}
