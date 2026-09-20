import { describe, it, expect } from 'vitest';
import { parseReleaseUrl, resolveMetadata } from '../src/resolver';

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
});
