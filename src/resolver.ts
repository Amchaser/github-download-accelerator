import type { AssetMeta, Mirror, ReleaseRef } from './types';

const RELEASE_RE =
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/releases\/download\/([^/\s]+)\/([^\s]+)$/;

/**
 * decodeURIComponent 对畸形的百分号转义会抛 URIError：用户粘贴 `...100%.zip`，
 * 或镜像回 `Content-Disposition: filename="%E0%A4%A"` 都会触发。那是**上游数据**的问题，
 * 不是本工具的失败——不该让用户看到「失败：URI malformed」而无从判断。
 * 解码失败即退回原串：显示一个近似正确的文件名，远好过整轮下载失败。
 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseReleaseUrl(raw: string): ReleaseRef {
  const m = RELEASE_RE.exec(raw.trim());
  if (!m) {
    throw new Error(
      '不是有效的 GitHub Release 下载链接（应形如 https://github.com/owner/repo/releases/download/tag/file）',
    );
  }
  return { owner: m[1], repo: m[2], tag: m[3], file: safeDecode(m[4]) };
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(value);
  return m ? safeDecode(m[1]) : null;
}

/**
 * 单个镜像的元数据请求超时（毫秒）。
 *
 * 取值理由：这次请求只带回响应头（`Range: bytes=0-0`），比探针那 3s 里要传 512 KiB
 * 的请求**更轻**，但镜像可能是冷缓存、要先去上游取一次，故给得比探针宽松；同时必须
 * 远小于回退路径那条 30s 的空闲超时——那条守的是一次完整文件传输，而这里只等一个往返。
 * 10s 也保证了最坏情况有界：全部镜像都静默时最多等 `usable.length × 10s`，且那种情况
 * 本来就要以失败收场，不会再往下走。**关键是有界**：无超时的 fetch 会让 `run()` 永不
 * settle，`finally` 不执行、按钮永久禁用、既无错误也无从取消。
 */
export const META_TIMEOUT_MS = 10_000;

/**
 * 取资源元数据。用 `Range: bytes=0-0` 的单次 GET 同时得到总大小与 Range 支持情况：
 * 206 → 支持；200 → 上游忽略 Range，必须降级为单连接下载。
 *
 * `signal` / `timeoutMs`（默认 META_TIMEOUT_MS）是**有界性**的保证：镜像接受了连接却
 * 永不回应时，没有超时的 fetch 会让调用方永不 settle（UI 的 finally 也就永不执行，
 * 按钮永久禁用且无任何错误可看）。signal 可让上层在整轮取消时一并撤回这次请求。
 */
export async function resolveMetadata(
  url: string,
  mirrorPrefix: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
  timeoutMs: number = META_TIMEOUT_MS,
): Promise<AssetMeta> {
  // 超时与外来的 signal 都归到同一个内部 controller 上：调用方只需接一个 signal。
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const relayAbort = () => ac.abort();
  signal?.addEventListener('abort', relayAbort);

  let res: Response;
  try {
    res = await fetchFn(mirrorPrefix + url, { headers: { Range: 'bytes=0-0' }, signal: ac.signal });
  } catch (e) {
    // 归因要准：超时是「镜像静默」，与「用户取消」不是同一回事，日志里必须能分清。
    if (timedOut) throw new Error(`镜像元数据请求超时（${timeoutMs / 1000}s 未响应）`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }

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
    safeDecode(url.split('/').pop() ?? 'download.bin');

  return { total, filename, acceptRanges };
}

/**
 * 依次向每个镜像索取元数据，**第一个成功者即返回**。
 *
 * 存在的意义有两条，缺一不可：
 *   1. 单个镜像瞬时失败不该让整个下载失败——其余健康镜像本可完成，只押注最快的那一个
 *      直接违背「单个镜像失效绝不能导致整个下载失败」这条关键约束；
 *   2. 单个镜像**永不响应**时必须有界：无超时的 fetch 会让 `run()` 永不 settle，
 *      UI 的 `finally` 永不执行，按钮永久禁用、既无错误也无从取消。
 *
 * 全部失败时抛**最后一个**错误：它最接近「此刻镜像的实际状况」，而第一个错误可能只是
 * 一次早已过时的抖动。`onMirrorError` 供上层逐条记日志（本函数不依赖任何 UI）。
 */
export async function resolveMetadataFromMirrors(
  url: string,
  mirrors: Mirror[],
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = META_TIMEOUT_MS,
  onMirrorError?: (mirror: Mirror, error: unknown) => void,
): Promise<AssetMeta> {
  if (mirrors.length === 0) throw new Error('没有可用镜像，无法获取资源元数据');
  let last: unknown;
  for (const m of mirrors) {
    try {
      return await resolveMetadata(url, m.prefix, fetchFn, undefined, timeoutMs);
    } catch (e) {
      last = e;
      onMirrorError?.(m, e);
    }
  }
  throw new Error(
    `全部 ${mirrors.length} 个镜像的元数据请求均失败：${last instanceof Error ? last.message : String(last)}`,
  );
}
