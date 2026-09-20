import type { AssetMeta, ReleaseRef } from './types';

const RELEASE_RE =
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/releases\/download\/([^/\s]+)\/([^\s]+)$/;

export function parseReleaseUrl(raw: string): ReleaseRef {
  const m = RELEASE_RE.exec(raw.trim());
  if (!m) {
    throw new Error(
      '不是有效的 GitHub Release 下载链接（应形如 https://github.com/owner/repo/releases/download/tag/file）',
    );
  }
  return { owner: m[1], repo: m[2], tag: m[3], file: decodeURIComponent(m[4]) };
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(value);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 取资源元数据。用 `Range: bytes=0-0` 的单次 GET 同时得到总大小与 Range 支持情况：
 * 206 → 支持；200 → 上游忽略 Range，必须降级为单连接下载。
 */
export async function resolveMetadata(
  url: string,
  mirrorPrefix: string,
  fetchFn: typeof fetch = fetch,
): Promise<AssetMeta> {
  const res = await fetchFn(mirrorPrefix + url, { headers: { Range: 'bytes=0-0' } });

  // 立刻取消响应体，且必须放在**任何 throw 之前**：本函数只需要响应头，而下面有两处
  // throw（非 2xx、以及 2xx 但大小不可用）。后者尤其要紧——「2xx 且无可用大小」正是
  // 「镜像忽略 Range 并以 chunked 回传」的形态，若不取消，整个文件会在后台继续传输，
  // 白占连接与镜像并发配额；而探针按镜像并行运行，可能抽干下载引擎随后要用的连接池。
  // 放在返回前只覆盖成功路径，漏掉抛错路径，等于在镜像最不正常时放弃防护。
  // 实测 cancel() 之后响应头仍可读，故不影响下面的解析；cancel() 是丢弃而非缓冲。
  if (res.body) {
    try { await res.body.cancel(); } catch (e) { /* 取消失败无关紧要，不掩盖已取得的头 */ }
  }

  if (res.status !== 206 && !res.ok) {
    throw new Error(`镜像返回 HTTP ${res.status}`);
  }

  const acceptRanges = res.status === 206;
  let total: number | null = null;

  if (acceptRanges) {
    const cr = res.headers.get('content-range');
    const m = cr ? /\/(\d+)\s*$/.exec(cr) : null;
    if (m) total = Number(m[1]);
  }
  // Content-Length 兜底只对「非 206」成立。206 响应的 Content-Length 是**分片**长度
  // （Range: bytes=0-0 时就是 1 字节），拿它当资产总大小会把 500MB 的资产变成
  // 「1 字节下载成功」，而且能通过下面的 > 0 校验 —— 正是 spec 明令必须判为失败的
  // 静默损坏形态。所以 206 但 Content-Range 缺失或不可解析时，直接掉到下面 throw。
  if (total === null && !acceptRanges) {
    const len = res.headers.get('content-length');
    if (len) total = Number(len);
  }
  if (total === null || !Number.isFinite(total) || total <= 0) {
    throw new Error('无法确定资源大小（206 但 Content-Range 缺失或不可解析，或非 206 且无有效 Content-Length）');
  }

  const filename =
    filenameFromDisposition(res.headers.get('content-disposition')) ??
    decodeURIComponent(url.split('/').pop() ?? 'download.bin');

  return { total, filename, acceptRanges };
}
