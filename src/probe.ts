import type { Mirror, ProbeResult } from './types';

/** 探针请求的字节数。512 KiB 足够让吞吐估计脱离 TTFB 主导，又不浪费带宽。 */
export const PROBE_BYTES = 512 * 1024;

export const PROBE_TIMEOUT_MS = 3000;

/**
 * 极快的响应可能使测量耗时恰为 0（计时器分辨率有限，mock 环境下尤其常见）。
 * **这不是失败**：探针只用于粗略排序，给一个有限的大值即可——绝不能因此把最快的
 * 镜像判为 `ok: false`，Task 9 会据此排序并挑 best，那等于把最好的镜像排除掉。
 * 用 `performance.now()`（微秒级）替代 `Date.now()`（毫秒级）以降低触发概率，
 * 但仍必须夹住下界，不能依赖计时器恰好非零。
 */
const MIN_ELAPSED_SEC = 1e-6;

async function probeOne(
  url: string,
  mirror: Mirror,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetchFn(mirror.prefix + url, {
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
      signal: controller.signal,
    });
    const ttfbMs = performance.now() - t0;
    if (res.status !== 206) {
      return { mirror, ok: false, bytesPerSec: 0, ttfbMs };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) {
      return { mirror, ok: false, bytesPerSec: 0, ttfbMs };
    }
    const elapsedSec = (performance.now() - t0) / 1000;
    return {
      mirror,
      ok: true,
      bytesPerSec: buf.byteLength / Math.max(elapsedSec, MIN_ELAPSED_SEC),
      ttfbMs,
    };
  } catch {
    return { mirror, ok: false, bytesPerSec: 0, ttfbMs: performance.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发探测全部镜像，返回结果（顺序与入参一致）。
 * 单个镜像失败不影响其他镜像。
 */
export async function probeMirrors(
  url: string,
  mirrors: Mirror[],
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult[]> {
  return Promise.all(mirrors.map((m) => probeOne(url, m, fetchFn, timeoutMs)));
}
