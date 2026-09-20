import { describe, it, expect } from 'vitest';
import { probeMirrors, PROBE_BYTES } from '../src/probe';
import type { Mirror } from '../src/types';

const URL_ = 'https://github.com/o/r/releases/download/v1/a.exe';
const M: Mirror[] = [
  { id: 'a', prefix: 'https://a.test/' },
  { id: 'b', prefix: 'https://b.test/' },
];

/** 造一个返回 bodyLen 字节的 206 响应。 */
function okFetch(bodyLen: number) {
  return (async () =>
    new Response(new Uint8Array(bodyLen), {
      status: 206,
      headers: { 'content-range': `bytes 0-${bodyLen - 1}/999999` },
    })) as unknown as typeof fetch;
}

describe('probeMirrors', () => {
  it('返回每个镜像的结果', async () => {
    const r = await probeMirrors(URL_, M, okFetch(1024));
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.ok)).toBe(true);
  });

  it('请求 512 KiB 的 Range', async () => {
    const seen: string[] = [];
    const f = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>).Range);
      return new Response(new Uint8Array(16), { status: 206, headers: {} });
    }) as unknown as typeof fetch;
    await probeMirrors(URL_, M, f);
    expect(seen).toEqual([`bytes=0-${PROBE_BYTES - 1}`, `bytes=0-${PROBE_BYTES - 1}`]);
  });

  it('必须带 cache: no-store —— 命中 HTTP 缓存会把速度与排名一起变成虚构', async () => {
    // 缺这一行时的实测现象：首字节 1.9ms（局域网量级）、吞吐 83 MiB/s（≈660 Mbps），
    // 而同一时刻、同一镜像、同样带浏览器 UA 用 curl 只有 388 KB/s——相差 215 倍，全来自缓存。
    // 后果不止读数难看：**排名**的依据是假的，而且已失效的镜像会因缓存显得还活着。
    const seen: (RequestCache | undefined)[] = [];
    const f = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.cache);
      return new Response(new Uint8Array(16), { status: 206, headers: {} });
    }) as unknown as typeof fetch;
    await probeMirrors(URL_, M, f);
    expect(seen).toEqual(['no-store', 'no-store']);
  });

  it('非 206 的镜像标记为不可用', async () => {
    const f = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    const r = await probeMirrors(URL_, M, f);
    expect(r.every((x) => x.ok === false)).toBe(true);
    expect(r.every((x) => x.bytesPerSec === 0)).toBe(true);
  });

  it('抛异常的镜像标记为不可用而不影响其他镜像', async () => {
    const f = (async (i: RequestInfo | URL) => {
      if (String(i).includes('a.test')) throw new Error('boom');
      return new Response(new Uint8Array(64), { status: 206, headers: {} });
    }) as unknown as typeof fetch;
    const r = await probeMirrors(URL_, M, f);
    expect(r.find((x) => x.mirror.id === 'a')!.ok).toBe(false);
    expect(r.find((x) => x.mirror.id === 'b')!.ok).toBe(true);
  });

  it('超时的镜像标记为不可用', async () => {
    const f = (async (_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch;
    const r = await probeMirrors(URL_, M, f, 20);
    expect(r.every((x) => x.ok === false)).toBe(true);
  });

  it('请求的是镜像前缀 + 原始 URL', async () => {
    const seen: string[] = [];
    const f = (async (i: RequestInfo | URL) => {
      seen.push(String(i));
      return new Response(new Uint8Array(8), { status: 206, headers: {} });
    }) as unknown as typeof fetch;
    await probeMirrors(URL_, M, f);
    expect(seen).toContain(`https://a.test/${URL_}`);
    expect(seen).toContain(`https://b.test/${URL_}`);
  });
});
