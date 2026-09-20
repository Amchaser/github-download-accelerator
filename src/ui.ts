import type { ProbeResult } from './types';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export const els = {
  url: $<HTMLInputElement>('url'),
  go: $<HTMLButtonElement>('go'),
  hint: $<HTMLSpanElement>('hint'),
  fill: $<HTMLDivElement>('fill'),
  pct: $<HTMLSpanElement>('pct'),
  spd: $<HTMLSpanElement>('spd'),
  eta: $<HTMLSpanElement>('eta'),
  mirrors: $<HTMLDivElement>('mirrors'),
  log: $<HTMLDivElement>('log'),
  warn: $<HTMLDivElement>('warn'),
};

export function showWarning(msg: string): void {
  els.warn.textContent = msg;
  els.warn.style.display = 'block';
}

export function log(msg: string, isError = false): void {
  const line = document.createElement('div');
  if (isError) line.className = 'err';
  line.textContent = msg;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

export function setProgress(done: number, total: number): void {
  const pct = total > 0 ? (done / total) * 100 : 0;
  els.fill.style.width = `${pct.toFixed(1)}%`;
  els.pct.textContent = `${pct.toFixed(1)}%  ${fmtBytes(done)} / ${fmtBytes(total)}`;
}

export function setSpeed(bytesPerSec: number, done: number, total: number): void {
  els.spd.textContent = `${fmtBytes(bytesPerSec)}/s`;
  if (bytesPerSec > 0 && total > done) {
    const s = (total - done) / bytesPerSec;
    els.eta.textContent = `剩余 ${s < 60 ? `${s.toFixed(0)} 秒` : `${(s / 60).toFixed(1)} 分`}`;
  }
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

export function renderMirrors(results: ProbeResult[]): void {
  if (results.length === 0) { els.mirrors.textContent = ''; return; }
  const rows = results
    .map(
      (r) =>
        `<tr><td>${r.mirror.id}</td><td>${r.ok ? '可用' : '<span class="err">不可用</span>'}</td>` +
        `<td class="num">${r.ok ? `${fmtBytes(r.bytesPerSec)}/s` : '—'}</td>` +
        `<td class="num">${r.ttfbMs.toFixed(1)} ms</td></tr>`,
    )
    .join('');
  els.mirrors.innerHTML =
    `<table><thead><tr><th>镜像</th><th>状态</th><th class="num">吞吐</th><th class="num">首字节</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function setBusy(busy: boolean): void {
  els.go.disabled = busy;
  els.go.textContent = busy ? '下载中…' : '开始下载';
}
