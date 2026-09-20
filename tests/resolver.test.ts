import { describe, it, expect } from 'vitest';
import { parseReleaseUrl, resolveMetadata, resolveMetadataFromMirrors } from '../src/resolver';
import type { Mirror } from '../src/types';

const GOOD = 'https://github.com/babalae/better-genshin-impact/releases/download/0.65.0/BetterGI.Install.0.65.0.exe';

describe('parseReleaseUrl', () => {
  it('解析标准 Release 链接', () => {
    expect(parseReleaseUrl(GOOD)).toEqual({
      owner: 'babalae',
      repo: 'better-genshin-impact',
      tag: '0.65.0',
      file: 'BetterGI.Install.0.65.0.exe',
    });
  });

  it('对文件名做 URL 解码', () => {
    const u = 'https://github.com/o/r/releases/download/v1/a%20b.zip';
    expect(parseReleaseUrl(u).file).toBe('a b.zip');
  });

  it('容忍首尾空白', () => {
    expect(parseReleaseUrl(`  ${GOOD}  `).owner).toBe('babalae');
  });

  it('拒绝非 Release 链接', () => {
    expect(() => parseReleaseUrl('https://github.com/o/r')).toThrow(/不是有效的/);
    expect(() => parseReleaseUrl('https://example.com/a.exe')).toThrow(/不是有效的/);
    expect(() => parseReleaseUrl('')).toThrow(/不是有效的/);
  });

  it('拒绝 raw/blob 链接（本工具只处理 Release 资产）', () => {
    expect(() => parseReleaseUrl('https://github.com/o/r/raw/main/a.exe')).toThrow();
    expect(() => parseReleaseUrl('https://github.com/o/r/blob/main/a.exe')).toThrow();
  });

  it('文件名含畸形百分号转义时不抛 URIError，退回原串', () => {
    // decodeURIComponent('100%.zip') 抛 URIError：`%` 后必须是两位十六进制。
    // 那是**上游数据**的问题，不是本工具的失败——用户不该看到「失败：URI malformed」。
    const u = 'https://github.com/o/r/releases/download/v1/100%.zip';
    expect(parseReleaseUrl(u).file).toBe('100%.zip');
  });
});

/** 造一个假的 fetch，返回指定的 status 与 headers。 */
function fakeFetch(status: number, headers: Record<string, string>) {
  return (async () => new Response(null, { status, headers })) as unknown as typeof fetch;
}

describe('resolveMetadata', () => {
  it('206 时从 Content-Range 取总大小，并判定支持 Range', async () => {
    const f = fakeFetch(206, {
      'content-range': 'bytes 0-0/499558899',
      'content-disposition': 'attachment; filename="BetterGI.Install.0.65.0.exe"',
    });
    const meta = await resolveMetadata(GOOD, 'https://gh.xmly.dev/', f);
    expect(meta).toEqual({
      total: 499558899,
      filename: 'BetterGI.Install.0.65.0.exe',
      acceptRanges: true,
    });
  });

  it('200 时从 Content-Length 取总大小，并判定不支持 Range', async () => {
    const f = fakeFetch(200, { 'content-length': '12345' });
    const meta = await resolveMetadata(GOOD, 'https://gh.xmly.dev/', f);
    expect(meta.total).toBe(12345);
    expect(meta.acceptRanges).toBe(false);
  });

  it('Content-Disposition 缺失时回退到 URL 末段文件名', async () => {
    const f = fakeFetch(206, { 'content-range': 'bytes 0-0/100' });
    const meta = await resolveMetadata(GOOD, 'https://gh.xmly.dev/', f);
    expect(meta.filename).toBe('BetterGI.Install.0.65.0.exe');
  });

  it('无法确定总大小时抛错', async () => {
    const f = fakeFetch(200, {});
    await expect(resolveMetadata(GOOD, 'https://gh.xmly.dev/', f)).rejects.toThrow(/无法确定/);
  });

  it('非 2xx/206 状态抛错', async () => {
    const f = fakeFetch(403, {});
    await expect(resolveMetadata(GOOD, 'https://gh.xmly.dev/', f)).rejects.toThrow(/403/);
  });

  it('请求的是镜像前缀 + 原始 URL', async () => {
    let seen = '';
    const f = (async (input: RequestInfo | URL) => {
      seen = String(input);
      return new Response(null, { status: 206, headers: { 'content-range': 'bytes 0-0/100' } });
    }) as unknown as typeof fetch;
    await resolveMetadata(GOOD, 'https://gh.xmly.dev/', f);
    expect(seen).toBe(`https://gh.xmly.dev/${GOOD}`);
  });

  it('用 GET + Range: bytes=0-0 探测，而不是 HEAD（一次往返同时拿大小与 Range 支持）', async () => {
    // 这条钉住本模块的设计前提：用带 Range 的 GET 一次拿到「总大小」与「是否支持 Range」。
    // 若有人改成 HEAD，其余用例仍会全绿，而 206/200 分支的前提与「减少往返」的理由会静默失效。
    let init: RequestInit | undefined;
    const f = (async (_i: RequestInfo | URL, i?: RequestInit) => {
      init = i;
      return new Response(null, { status: 206, headers: { 'content-range': 'bytes 0-0/100' } });
    }) as unknown as typeof fetch;
    await resolveMetadata(GOOD, 'https://gh.xmly.dev/', f);
    expect(init?.method ?? 'GET').toBe('GET');
    expect((init?.headers as Record<string, string>).Range).toBe('bytes=0-0');
  });

  it('取完响应头后取消（丢弃）响应体，避免 200 路径在后台继续传完整个文件', async () => {
    // 不取消的话，镜像忽略 Range 时整个文件会继续传输，白占连接与镜像并发配额；
    // 探针按镜像并行运行，可能把下载引擎随后要用的连接池抽干。
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const f = (async () =>
      new Response(body, { status: 200, headers: { 'content-length': '12345' } })) as unknown as typeof fetch;
    const meta = await resolveMetadata(GOOD, 'https://gh.xmly.dev/', f);
    expect(meta.total).toBe(12345);
    expect(cancelled).toBe(true);
  });

  it('206 但 Content-Range 不可解析时必须抛错，绝不退用分片的 Content-Length', async () => {
    // 206 的 Content-Length 是**分片**长度（Range: bytes=0-0 时就是 1）。
    // 若拿它当总大小，500MB 的资产会变成「1 字节下载成功」且无任何报错——静默损坏。
    const f = fakeFetch(206, { 'content-range': 'bytes 0-0/*', 'content-length': '1' });
    await expect(resolveMetadata(GOOD, 'https://gh.xmly.dev/', f)).rejects.toThrow(/无法确定/);
  });

  it('抛错路径同样取消响应体（2xx 但可信大小不可得时，不得让文件在后台继续传）', async () => {
    // 「2xx 且无可信大小」正是镜像忽略 Range 并 chunked 回传的形态——镜像最不正常、
    // 探针最该起作用的时刻。此时若不取消，整个文件会继续传输并占住连接。
    // 这条钉住 cancel 必须位于所有 throw 之前，而不只是返回之前。
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const f = (async () =>
      new Response(body, { status: 200 })) as unknown as typeof fetch; // 无 Content-Length
    await expect(resolveMetadata(GOOD, 'https://gh.xmly.dev/', f)).rejects.toThrow(/无法确定/);
    expect(cancelled).toBe(true);
  });

  it('Content-Disposition 里的畸形百分号转义同样不抛 URIError', async () => {
    // 文件名由镜像控制，正常世界之外的值必然出现（这里是 `%A`，只有一位十六进制）。
    const f = fakeFetch(206, {
      'content-range': 'bytes 0-0/100',
      'content-disposition': 'attachment; filename="%E0%A4%A"',
    });
    const meta = await resolveMetadata(GOOD, 'https://gh.xmly.dev/', f);
    expect(meta.filename).toBe('%E0%A4%A');
  });
});

/** 一个「接受连接但永不回应」的镜像。真实 fetch 在 abort 时会拒绝，这里照实模拟。 */
function silentFetch(): typeof fetch {
  return (async (_i: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
}

const MIRRORS: Mirror[] = [
  { id: 'a', prefix: 'https://a.test/' },
  { id: 'b', prefix: 'https://b.test/' },
];

/** 按镜像前缀分派：a.test 用 silent，其余用 good。 */
function perMirror(silent: typeof fetch, good: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith('https://a.test/') ? silent(input, init) : good(input, init)) as unknown as typeof fetch;
}

describe('resolveMetadata 的有界性', () => {
  it('镜像接住连接却永不回应时按超时中断，不会永久挂起', async () => {
    // 无超时的话这里**永不 settle**：main.ts 的 run() 不返回 → finally 不执行 →
    // 按钮永久禁用，既无错误也无从取消。这正是元数据请求必须自带超时的理由。
    await expect(
      resolveMetadata(GOOD, 'https://a.test/', silentFetch(), undefined, 20),
    ).rejects.toThrow(/超时/);
  });

  it('第一个镜像静默时改用下一个镜像，并报出是哪一个失败', async () => {
    // 一个镜像静默或瞬时失败，绝不能让整轮下载失败（其余健康镜像本可完成）——
    // 这是本项目的关键约束在元数据阶段的体现。
    const good = fakeFetch(206, { 'content-range': 'bytes 0-0/499558899' });
    const failed: string[] = [];
    const meta = await resolveMetadataFromMirrors(
      GOOD, MIRRORS, perMirror(silentFetch(), good), 20, (m) => failed.push(m.id),
    );
    expect(meta.total).toBe(499558899);
    expect(meta.acceptRanges).toBe(true);
    expect(failed).toEqual(['a']);   // 静默的那个被记录，且确实轮到了下一个
  });

  it('全部镜像都失败时抛最后一个错误（最接近此刻的实况）', async () => {
    const f = (async (input: RequestInfo | URL) =>
      new Response(null, { status: String(input).startsWith('https://a.test/') ? 500 : 503 })) as unknown as typeof fetch;
    await expect(resolveMetadataFromMirrors(GOOD, MIRRORS, f, 20)).rejects.toThrow(/503/);
  });

  it('没有可用镜像时立即抛错，不做无谓等待', async () => {
    await expect(resolveMetadataFromMirrors(GOOD, [], fakeFetch(206, {}), 20)).rejects.toThrow(/没有可用镜像/);
  });
});
