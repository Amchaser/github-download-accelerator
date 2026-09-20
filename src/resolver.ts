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
  if (total === null) {
    const len = res.headers.get('content-length');
    if (len) total = Number(len);
  }
  if (total === null || !Number.isFinite(total) || total <= 0) {
    throw new Error('无法确定资源大小（响应既无 Content-Range 也无有效 Content-Length）');
  }

  const filename =
    filenameFromDisposition(res.headers.get('content-disposition')) ??
    decodeURIComponent(url.split('/').pop() ?? 'download.bin');

  return { total, filename, acceptRanges };
}
