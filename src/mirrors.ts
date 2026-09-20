import type { Mirror } from './types';

/**
 * 仅收录 2026-09-20 实测同时具备 Range 与 CORS 响应的镜像。
 * gh-proxy.com / ghproxy.net 等虽支持 Range 且更快，但不发
 * Access-Control-Allow-Origin，浏览器读不到响应，故排除。
 */
export const KNOWN_MIRRORS: Mirror[] = [
  { id: 'xmly', prefix: 'https://gh.xmly.dev/' },
  { id: 'xxooo', prefix: 'https://gh.xxooo.cf/' },
  { id: 'ddlc', prefix: 'https://gh.ddlc.top/' },
  { id: 'monlor', prefix: 'https://gh.monlor.com/' },
];

/** 连续失败达到此次数即降权到队尾。 */
export const FAILURE_DEMOTE_THRESHOLD = 3;

interface Health {
  consecutiveFailures: number;
  bytesPerSec: number | null;
}

export class MirrorPool {
  private readonly health = new Map<string, Health>();

  constructor(private readonly mirrors: Mirror[] = KNOWN_MIRRORS) {
    for (const m of mirrors) {
      this.health.set(m.id, { consecutiveFailures: 0, bytesPerSec: null });
    }
  }

  available(): Mirror[] {
    return [...this.mirrors];
  }

  recordSuccess(id: string, bytesPerSec: number): void {
    const h = this.health.get(id);
    if (!h) return;
    h.consecutiveFailures = 0;
    h.bytesPerSec = bytesPerSec;
  }

  recordFailure(id: string): void {
    const h = this.health.get(id);
    if (!h) return;
    h.consecutiveFailures += 1;
  }

  /** 降权镜像排到队尾；已测速者按吞吐降序排在未测速者之前。 */
  ranked(): Mirror[] {
    return [...this.mirrors].sort((a, b) => this.score(a.id) - this.score(b.id));
  }

  /** 分数越小越靠前。降权镜像直接给一个大偏移。 */
  private score(id: string): number {
    const h = this.health.get(id);
    if (!h) return Number.MAX_SAFE_INTEGER;
    const demoted = h.consecutiveFailures >= FAILURE_DEMOTE_THRESHOLD ? 1e15 : 0;
    const measured = h.bytesPerSec === null ? 1e12 : -h.bytesPerSec;
    return demoted + measured;
  }
}
