import { parseReleaseUrl, resolveMetadata } from './resolver';
import { MirrorPool } from './mirrors';
import { probeMirrors } from './probe';
import { download } from './engine';
import { createFsaSink, supportsFsa, UnsupportedBrowserError } from './sink';
import type { Sink } from './types';
import * as ui from './ui';

/** 单连接回退：整体下载后用 <a download> 保存。无并行、无断点，仅保可用性。 */
async function fallbackDownload(url: string, mirrorPrefix: string, filename: string): Promise<void> {
  ui.log('使用单连接回退模式（无并行加速）…');
  const res = await fetch(mirrorPrefix + url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}

async function run(): Promise<void> {
  const raw = ui.els.url.value.trim();
  ui.els.log.textContent = '';
  ui.setProgress(0, 1);

  const ref = parseReleaseUrl(raw);
  ui.log(`仓库 ${ref.owner}/${ref.repo}  标签 ${ref.tag}`);

  const pool = new MirrorPool();
  const mirrors = pool.available();

  ui.log(`探测 ${mirrors.length} 个镜像…`);
  const probes = await probeMirrors(raw, mirrors);
  ui.renderMirrors(probes);

  for (const p of probes) {
    if (p.ok) pool.recordSuccess(p.mirror.id, p.bytesPerSec);
    else pool.recordFailure(p.mirror.id);
  }

  // 必须用 pool.ranked()（按**实测吞吐**排序）而不是 probes 的顺序：
  // probes 的顺序就是 MIRRORS 的注册顺序，与快慢无关，于是 usable[0] 只是
  // 「第一个探针通过的镜像」，名字叫 best 会撒谎。实测镜像间吞吐可差 10 倍以上，
  // 让元数据探测走最快的镜像是实打实的收益（那是一次真实往返，且它承载着
  // 「镜像是否支持 Range」的判定，失败就要整体降级）。
  const okIds = new Set(probes.filter((p) => p.ok).map((p) => p.mirror.id));
  const usable = pool.ranked().filter((m) => okIds.has(m.id));
  if (usable.length === 0) throw new Error('全部镜像均不可用，请稍后重试');

  const best = usable[0]; // ranked() 已按实测吞吐降序
  ui.log(`镜像次序（按实测吞吐）: ${usable.map((m) => m.id).join(' > ')}`);
  const meta = await resolveMetadata(raw, best.prefix);
  ui.log(`文件 ${meta.filename}  大小 ${ui.fmtBytes(meta.total)}`);

  let sink: Sink;
  if (supportsFsa()) {
    sink = await createFsaSink(meta.filename);
    // FSA 的写入先进临时文件，只有 close() 才把内容换到用户选定的路径上。于是**整个
    // 下载期间目标文件都是 0 字节**，最后一次性出现——不预先说明的话，人看着一个
    // 0 字节文件会合理地以为卡住了。
    ui.log('说明：目标文件在下载过程中会一直显示 0 字节，下载完毕才一次性写入内容（浏览器先写临时文件）。');
  } else {
    ui.showWarning('当前浏览器不支持 File System Access API，将使用单连接回退模式。建议改用 Chrome / Edge。');
    await fallbackDownload(raw, best.prefix, meta.filename);
    ui.log('已触发保存。');
    return;
  }

  if (!meta.acceptRanges) {
    ui.log('上游不支持 Range，降级为单连接下载…');
    await sink.abort();
    await fallbackDownload(raw, best.prefix, meta.filename);
    return;
  }

  const t0 = Date.now();
  let lastBytes = 0;
  let lastT = t0;

  await download({
    url: raw,
    total: meta.total,
    mirrors: usable,
    sink,
    onProgress: (done) => {
      ui.setProgress(done, meta.total);
      const now = Date.now();
      if (now - lastT >= 400) {
        ui.setSpeed(((done - lastBytes) / (now - lastT)) * 1000, done, meta.total);
        lastBytes = done;
        lastT = now;
      }
    },
  });

  const secs = (Date.now() - t0) / 1000;
  ui.setProgress(meta.total, meta.total);
  ui.setSpeed(meta.total / secs, meta.total, meta.total);
  ui.log(`完成：${ui.fmtBytes(meta.total)} 用时 ${secs.toFixed(1)}s，平均 ${ui.fmtBytes(meta.total / secs)}/s`);
}

ui.els.go.addEventListener('click', async () => {
  ui.setBusy(true);
  ui.els.hint.textContent = '';
  try {
    await run();
  } catch (e) {
    // 保存对话框被用户取消时，showSaveFilePicker 以 DOMException(AbortError) 拒绝。
    // 那是**用户刻意的动作，不是失败**：不该在日志里报「失败：…」、更不该提示
    // 「下载失败，请查看日志」。此处静默结束本轮，按钮照常复位。
    if (e instanceof DOMException && e.name === 'AbortError') {
      ui.log('已取消：未选择保存位置，本次下载未开始。');
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    ui.log(`失败：${msg}`, true);
    ui.els.hint.textContent = e instanceof UnsupportedBrowserError ? '请改用 Chrome / Edge' : '下载失败，请查看日志';
  } finally {
    ui.setBusy(false);
  }
});

if (!supportsFsa()) {
  ui.showWarning('检测到当前浏览器不支持 File System Access API（Firefox / Safari 均不支持）。功能将受限为单连接回退模式，建议改用 Chrome / Edge。');
}
