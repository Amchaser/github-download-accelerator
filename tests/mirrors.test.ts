import { describe, it, expect } from 'vitest';
import { KNOWN_MIRRORS, MirrorPool, FAILURE_DEMOTE_THRESHOLD } from '../src/mirrors';

describe('KNOWN_MIRRORS', () => {
  it('恰好 4 个，且 prefix 以 / 结尾（拼接原始 URL 的前提）', () => {
    expect(KNOWN_MIRRORS).toHaveLength(4);
    for (const m of KNOWN_MIRRORS) {
      expect(m.prefix.endsWith('/')).toBe(true);
      expect(m.prefix.startsWith('https://')).toBe(true);
    }
  });

  it('id 唯一', () => {
    const ids = KNOWN_MIRRORS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('不包含已知无 CORS 头的镜像', () => {
    const banned = ['gh-proxy.com', 'ghproxy.net', 'v6.gh-proxy.org', 'gh.noki.icu'];
    for (const m of KNOWN_MIRRORS) {
      for (const b of banned) expect(m.prefix).not.toContain(b);
    }
  });
});

describe('MirrorPool', () => {
  it('初始按注册顺序返回全部镜像', () => {
    expect(new MirrorPool().available().map((m) => m.id)).toEqual(
      KNOWN_MIRRORS.map((m) => m.id),
    );
  });

  it('记录的吞吐越高排得越前', () => {
    const p = new MirrorPool();
    p.recordSuccess('monlor', 10 * 1048576);
    expect(p.ranked()[0].id).toBe('monlor');
  });

  it('连续失败到阈值后被降权到队尾', () => {
    const p = new MirrorPool();
    p.recordSuccess('xmly', 5 * 1048576);
    for (let i = 0; i < FAILURE_DEMOTE_THRESHOLD; i++) p.recordFailure('xmly');
    expect(p.ranked()[p.ranked().length - 1].id).toBe('xmly');
  });

  it('成功一次即清除失败计数', () => {
    const p = new MirrorPool();
    for (let i = 0; i < FAILURE_DEMOTE_THRESHOLD; i++) p.recordFailure('ddlc');
    p.recordSuccess('ddlc', 1024);
    expect(p.ranked().map((m) => m.id).filter((id) => id === 'ddlc')).toHaveLength(1);
    expect(p.ranked()[p.ranked().length - 1].id).not.toBe('ddlc');
  });

  it('未测速的镜像排在已测速的之后', () => {
    const p = new MirrorPool();
    p.recordSuccess('xxooo', 1048576);
    expect(p.ranked()[p.ranked().length - 1].id).not.toBe('xxooo');
  });

  it('available 不因失败而减少（失败只降权，不移除）', () => {
    const p = new MirrorPool();
    for (let i = 0; i < FAILURE_DEMOTE_THRESHOLD * 2; i++) p.recordFailure('xmly');
    expect(p.available()).toHaveLength(KNOWN_MIRRORS.length);
  });
});
