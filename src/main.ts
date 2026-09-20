import { parseReleaseUrl, resolveMetadataFromMirrors } from './resolver';
import { MirrorPool } from './mirrors';
import { probeMirrors } from './probe';
import { download } from './engine';
import { createFsaSink, supportsFsa, UnsupportedBrowserError } from './sink';
import type { Sink } from './types';
import * as ui from './ui';

/**
 * 本轮下载是否由**用户取消保存对话框**结束。
 * 只由 showSaveFilePicker 的拒绝置位（全项目唯一一处），故外层 catch 依据它判断时，
 * 不会把下载中途其它来源的 AbortError 误当成「用户取消」。
 */
let pickerCancelled = false;

function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/** 单连接回退：整体下载后用 <a download> 保存。无并行、无断点，仅保可用性。 */
async function fallbackDownload(url: string, mirrorPrefix: string, filename: string, total: number): Promise<void> {
  ui.log('使用单连接回退模式（无并行加速）…');
  // **单连接同样必须有界。** 引擎为每个分块都配了空闲超时 + 墙钟死线，正是因为**实测**
  // 过镜像会滴水式卡住（两次 500MB 停在 98.x%、字节数仍在极慢增长）。这条路径若设限不设，
  // 连接一停就永远停在「下载中…」、按钮一直不可用也取消不了——正是本项目最想消灭的形态。
  // 顺带用流式读取补上进度：不这样做，用户在整个传输期间只看得到一个冻结的日志。
  const IDLE_MS = 30_000;
  const ac = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(), IDLE_MS);
  };
  let href = '';
  try {
    armIdle();
    const res = await fetch(mirrorPrefix + url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('响应没有 body');
    const reader = res.body.getReader();
    // 一次性按已知总长分配（而不是用不断增长的 parts 数组再拼 Blob）：
    // 既避免双份占用，也让类型落在 `Uint8Array<ArrayBuffer>` 上——TS 的 BlobPart
    // 要求 ArrayBuffer，而 reader 给出的 Uint8Array 是 ArrayBufferLike（可能含
    // SharedArrayBuffer），直接放进 Blob 会类型不符，且不该用 cast 掩盖。
    const buf = new Uint8Array(total);
    let got = 0;
    for (;;) {
      armIdle();
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        if (got + value.byteLength > total) {
          throw new Error(`响应超出预期长度：已收 ${got + value.byteLength}，应为 ${total}`);
        }
        buf.set(value, got);
        got += value.byteLength;
        ui.setProgress(got, total);
      }
    }
    if (got !== total) throw new Error(`字节数不足：期望 ${total}，实收 ${got}`);
    href = URL.createObjectURL(new Blob([buf]));
  } catch (e) {
    if (ac.signal.aborted) {
      throw new Error(`连接空闲超过 ${IDLE_MS / 1000}s（疑似镜像滴水式限速或已断），已中止`);
    }
    throw e;
  } finally {
    clearTimeout(idleTimer);
  }
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  // 先挂进文档再 click：部分浏览器对游离节点上的程序化 click 不放行。
  document.body.appendChild(a);
  a.click();
  a.remove();
  // **绝不能紧跟 click() 同步 revoke**：部分浏览器要等到稍后才真正开始读取该 URL，
  // 立刻 revoke 会把下载**直接取消掉**，而这个路径正是 Firefox / Safari 用户唯一的路径。
  // 给足时间再释放（顺带避免把大 blob 一直攥在内存里）。
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
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
  // 元数据必须**逐个健康镜像尝试**，不能只押最快的那一个。两条理由都是硬性的：
  //   1. 只押一个时，它一次瞬时失败就会让整个下载失败——另外三个健康镜像本可完成，
  //      直接违背「单个镜像失效绝不能导致整个下载失败」这条关键约束；
  //   2. 它还必须**有界**：镜像接了连接却永不回应时，无超时的 fetch 会让 run() 永不
  //      settle，finally 不执行、按钮永久禁用，既无错误也无从取消。有界性由
  //      resolver.ts 的 META_TIMEOUT_MS 保证（取值理由见那里的常量注释）。
  const meta = await resolveMetadataFromMirrors(raw, usable, fetch, undefined, (m, e) => {
    ui.log(`镜像 ${m.id} 元数据请求失败：${e instanceof Error ? e.message : String(e)}，改用下一个…`);
  });
  ui.log(`文件 ${meta.filename}  大小 ${ui.fmtBytes(meta.total)}`);

  // **必须在弹保存对话框之前**判定上游是否支持 Range：showSaveFilePicker 一旦弹出，
  // 用户就白白选了一个位置，而本分支最终会把它丢掉（文件落到默认下载目录）。
  // 已经知道答案的事，不要拿去问用户。
  if (!meta.acceptRanges) {
    ui.log('上游不支持 Range，无法并行分块，降级为单连接下载…');
    await fallbackDownload(raw, best.prefix, meta.filename, meta.total);
    ui.log('已触发保存。');
    return;
  }

  if (!supportsFsa()) {
    ui.showWarning('当前浏览器不支持 File System Access API，将使用单连接回退模式。建议改用 Chrome / Edge。');
    await fallbackDownload(raw, best.prefix, meta.filename, meta.total);
    ui.log('已触发保存。');
    return;
  }

  let sink: Sink;
  try {
    sink = await createFsaSink(meta.filename);
  } catch (e) {
    // 用户取消保存对话框时 showSaveFilePicker 以 DOMException(AbortError) 拒绝——
    // 这是**用户主动取消，不是失败**，不该在日志里报失败。
    // 但特判必须**只罩住这一处**：先前它罩住整个 run()，会把下载中途其它来源的
    // AbortError 也吞掉，并谎称「本次下载未开始」（此时下载其实早已开始）。
    // 故此处只做**归因标记**（pickerCancelled 全项目仅此处置位），并按原样抛出；
    // 是否静默由最外层 click 处理器依该标记决定——下载中途的 AbortError 不会置位，
    // 因而照常报失败。行为不变：取消保存对话框仍然静默、无「失败」行、按钮照常复位。
    if (isAbortError(e)) pickerCancelled = true;
    throw e;
  }
  // FSA 的写入先进临时文件，只有 close() 才把内容换到用户选定的路径上。于是**整个
  // 下载期间目标文件都是 0 字节**，最后一次性出现——不预先说明的话，人看着一个
  // 0 字节文件会合理地以为卡住了。
  ui.log('说明：目标文件在下载过程中会一直显示 0 字节，下载完毕才一次性写入内容（浏览器先写临时文件）。');

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
  pickerCancelled = false;   // 每轮复位：该标记只能反映**本轮**的 picker 结果
  try {
    await run();
  } catch (e) {
    // 保存对话框被用户取消时，showSaveFilePicker 以 DOMException(AbortError) 拒绝，
    // run() 里的 picker 调用已把这件事记在 pickerCancelled 上。
    // 那是**用户刻意的动作，不是失败**：不该在日志里报「失败：…」、更不该提示
    // 「下载失败，请查看日志」。此处静默结束本轮，按钮照常复位。
    // 判据是**标记而非 `e.name === 'AbortError'`**：后者会把下载中途其它来源的
    // AbortError 一并当成用户取消，并谎称「本次下载未开始」（此时下载其实早已开始）。
    if (pickerCancelled) {
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
