import type { Mirror, ProbeResult } from './types';

/** 探针请求的字节数。512 KiB 足够让吞吐估计脱离 TTFB 主导，又不浪费带宽。 */
export const PROBE_BYTES = 512 * 1024;

export const PROBE_TIMEOUT_MS = 3000;

async function probeOne(
  url: string,
  mirror: Mirror,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetchFn(mirror.prefix + url, {
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
      signal: controller.signal,
    });
    if (res.status !== 206) {
      return { mirror, ok: false, bytesPerSec: 0, ttfbMs: Date.now() - t0 };
    }
    const buf = await res.arrayBuffer();
    const elapsed = (Date.now() - t0) / 1000;
    if (buf.byteLength === 0 || elapsed <= 0) {
      return { mirror, ok: false, bytesPerSec: 0, ttfbMs: Date.now() - t0 };
    }
    return {
      mirror,
      ok: true,
      bytesPerSec: buf.byteLength / elapsed,
      ttfbMs: Date.now() - t0,
    };
  } catch {
    return { mirror, ok: false, bytesPerSec: 0, ttfbMs: Date.now() - t0 };
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
