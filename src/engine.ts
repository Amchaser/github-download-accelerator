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

  // res / reader 都声明在 try 之外，才能在 finally 里取消（见下方 finally 的注释：
  // **取过 reader 之后只能经 reader 取消**，res.body 已被锁定）。
  let res: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    armIdle();
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
      // retryable 为 **true**：200 只说明「该镜像不遵守 Range」，是镜像自身的问题，
      // 换一个镜像重试即可；若所有镜像都回 200，尝试预算会驱动同样的硬失败。
      // 设为 false 会让一个坏镜像杀死其余健康镜像本可完成的下载，违背
      // 「单个镜像失效绝不能导致整个下载失败」这条关键约束。
      // 安全性不受影响：本分支在写入任何字节之前就抛错。
      throw new ChunkError(
        `${label} HTTP 200：上游忽略了 Range 请求，无法分块下载`,
        true,
      );
    }
    if (res.status !== 206) {
      // **一律可重试**，不再按状态码分级。任何非 206（404 / 416 / 429 / 5xx …）都只说明
      // 「该镜像这条路此刻走不通」，换镜像或稍后重试即可，而整轮致命的代价是灾难性的：
      // 全局 failure 置位 → 所有 worker 停止 → sink.abort() 丢掉**其它 worker 已完成**的
      // 工作，而 FSA 下没有半成品可救。一个镜像在某一次分块请求上抖一下（约 60 次请求里
      // 的一次）就毁掉整个下载，正是上面 200 分支所反对、也是本模块存在意义所反对的形态。
      // 真正永久的情形由尝试预算（maxAttemptsPerChunk）兜住，而**死掉的资产在元数据阶段
      // 就会失败**（resolveMetadata 连 0 字节都拿不到），根本走不到这里。
      throw new ChunkError(`${label} HTTP ${res.status}`, true);
    }

    const cr = res.headers.get('content-range');
    const expectPrefix = `bytes ${chunk.start}-${chunk.end}/`;
    if (!cr || !cr.startsWith(expectPrefix)) {
      throw new ChunkError(`${label} Content-Range 不符：期望前缀 "${expectPrefix}"，收到 "${cr}"`, true);
    }

    if (!res.body) throw new ChunkError(`${label} 响应没有 body`, true);

    const rd = res.body.getReader();
    reader = rd;   // 供 finally 取消：body 一旦被 getReader() 锁定，res.body.cancel() 会被拒
    let pos = chunk.start;
    // 本块已写入的字节数：**只在整块成功后一次性上报**。逐次上报会让「失败后重下」
    // 的块把字节重复计入进度，出现进度 > 100% 与荒谬的 ETA——而那恰好发生在本模块
    // 存在的意义所在（重试与降级）的场景里。
    let written = 0;
    for (;;) {
      armIdle();
      let r;
      try {
        r = await rd.read();
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
        // **写入前的上界检查**：正确性不能只押在 Content-Range 头上。一个声明
        // `bytes 0-1023/…` 却多吐字节的镜像，多出的字节会越过本块区间写进**邻居块**的
        // 区域；邻居若已由别的镜像完成，就再也不会被重写。而下面的字节数校验会抛错、
        // 本块会重下并成功——于是产出「长度完全正确、内容错误」的文件并报成功，
        // 正是本项目最危险的那类失败（FSA 没有半成品可救，用户拿到的是一个坏文件）。
        // 放在写入**之前**，故越界字节一个都不会落盘。
        // 合规服务端不会被误伤：最后一次读取时 pos + byteLength 恰为 chunk.end + 1。
        if (pos + r.value.byteLength > chunk.end + 1) {
          throw new ChunkError(
            `${label} 响应超出请求区间（位置 ${pos} 起 ${r.value.byteLength} 字节，区间止于 ${chunk.end}）`,
            true,
          );
        }
        // 本 worker 内串行 await（同一块内至多一个写入在途），且读完即写即弃——
        // 不累积，故内存与文件大小无关。跨 worker 的并发写是安全的：FSA 内部对写入
        // 排队串行化，且显式 position 使写入顺序无关（见 Global Constraints）。
        try {
          await sink.write(pos, r.value);
        } catch (e) {
          // 与 fetchChunk 里其它每条错误一样带镜像前缀与字节区间：先前这里直接逃逸，
          // 被上层包成裸 String(e)、既无归因也看不出是写入问题。
          throw new ChunkError(`${label} 写入失败（位置 ${pos}）: ${(e as Error).message}`, true);
        }
        pos += r.value.byteLength;
        written += r.value.byteLength;
      }
    }

    if (pos !== chunk.end + 1) {
      throw new ChunkError(`${label} 字节数不足：期望 ${chunk.end + 1 - chunk.start} 字节，实收 ${pos - chunk.start} 字节`, true);
    }
    onBytes(written);   // 走到这里说明整块已校验通过，此时才计入进度
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(deadlineTimer);
    // 取消响应体：**刻意不 await**。await 一个由注入代码返回的 promise，是本模块
    // （整个存在意义就是死线纪律）里唯一边界不明的等待——若它永不 settle，worker 的
    // promise 永不 settle、Promise.all 永不 settle，而两道计时恰在上面刚被清掉，
    // 于是整轮**静默挂死**。取消是尽力而为的清理，不需要知道结果。
    //
    // 覆盖面（实测确认，Node 下）：**尚未 getReader() 的路径**（403 / 200 / 非 206 /
    // Content-Range 不符 / 无 body）用 `res.body.cancel()` 释放——那正是「整个文件会在
    // 后台继续传输、白占连接与镜像并发配额」的路径，与 resolver.ts 属同一缺陷类别
    // （Task 4 评审确立）。**取过 reader 之后**则必须走 `reader.cancel()`：body 已被锁定，
    // `res.body.cancel()` 会以 `TypeError: Invalid state: ReadableStream is locked`
    // **被拒**（不是 ERR_INVALID_STATE 的无害空转，是真的什么都没取消），而
    // `reader.cancel()` 在锁定状态下正常结算。这一条覆盖的恰恰是**连接仍然活着**的两条
    // 路径——写入失败（磁盘满 / 配额）与流中途读错：不取消的话，被放弃的 8 MiB 响应会
    // 继续在后台排空，最多 4 worker × 5 次重试 = 20 条僵尸连接与重试抢带宽。
    // 已正常读完（r.done）时 reader.cancel() 是无害的空操作。
    if (reader) {
      void reader.cancel().catch(() => { /* 尽力而为；失败无关紧要，也不掩盖真正的错误 */ });
    } else if (res?.body) {
      void res.body.cancel().catch(() => { /* 尽力而为；失败无关紧要，也不掩盖真正的错误 */ });
    }
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

        // 不可重试的错误 → 全局放弃，重试不会改变结果。
        // 现状：**没有任何错误被归为不可重试**——200 与所有非 206 状态（4xx/5xx）都已改为
        // 可重试，因为它们只说明「该镜像不遵守 Range / 这条路此刻不通」，换镜像即可。
        // 永久失败由下面的尝试预算兜住；真正死掉的资产在元数据阶段就已经失败了。
        // 分支保留：将来若出现「重试必然得到同样结果」的错误类别，这里是唯一的全局熔断点。
        if (!err.retryable) {
          if (!failure) failure = err;   // 保留首个错误：后来的可能信息更少
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
          if (!failure) failure = err;   // 保留首个错误：后来的可能信息更少
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
