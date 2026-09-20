# GitHub Release 加速下载器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个纯前端单页应用，粘贴 GitHub Release 链接即可通过多镜像并行 Range 分块高速下载，零后端、零安装。

**Architecture:** 浏览器直接 `fetch()` 4 个已验证支持 CORS 的公共 GitHub 代理镜像，每个镜像作为独立 origin 起一个 work-stealing 循环抢块下载，各块通过 File System Access API 的 `write({position})` 直接落到目标文件。并行度来自 **origin 数**（HTTP/2 下同源仅一条 TCP 连接），因此分块必须跨镜像分散而非堆在单一镜像上。

**Tech Stack:** TypeScript + Vite（构建/dev server）+ Vitest（单元测试）。无 UI 框架，直接操作 DOM。

## Global Constraints

- **镜像白名单固定为 4 个**（实测同时具备 Range + CORS）：`gh.xmly.dev`、`gh.xxooo.cf`、`gh.ddlc.top`、`gh.monlor.com`。不得使用 `gh-proxy.com` / `ghproxy.net` 等无 CORS 头者，浏览器无法读取其响应。
- **默认块大小 8 MiB**（`8 * 1024 * 1024`）。块大小下限 1 MiB。
- **永远通过原始 GitHub URL 发起请求**：`mirrorPrefix + originalUrl`，让镜像每次自行 follow 302。302 落点是限时签名 URL，禁止缓存。
- **任何 Range 响应必须校验 `status === 206` 且 `Content-Range` 前缀等于 `bytes ${start}-${end}/`**。收到 `200` 表示上游忽略 Range，此时把整包写入部分文件会静默产出损坏文件——必须判定为失败。
- **下载热路径禁止对响应体整块缓冲**：`engine.ts` 读取 Range 响应体必须用 `body.getReader()` 流式读取、读到即写即弃，**不得调用 `.blob()` / `.arrayBuffer()`**。目的：保证内存占用不随文件大小增长（4 路并发 × 大块）。
  **两处明列豁免，不视为违反本条：**
  1. `probe.ts` 的镜像探针 —— 体量固定 512 KiB，与目标文件大小无关。
  2. `main.ts` 的单连接回退 `fallbackDownload` —— 该路径没有定位写入能力，不整块进内存就无法保存；它是「明知慢但保可用」的降级路径，不参与并行热路径。
- **`sink.write()` 必须 `await` 串行化**，不得并发调用。
- **`createWritable()` 不得传 `keepExistingData: true`**。
- **能力检测必须检测 `createWritable`**，而非仅检测 `showSaveFilePicker`。
- 目标浏览器：Chromium 内核（Chrome / Edge / Opera）。Firefox 与 Safari 走 `<a download>` 回退路径。
- 所有源码文件用 TypeScript，`strict: true`。
- **每个 Range 分块必须有「墙钟」死线，不能只靠空闲超时。**（2026-09-20 实测得出）
  某镜像会**滴水式限速**——每几秒吐少量字节。这同时重置了空闲超时与进度看门狗
  （两者都只判断「有没有动」），于是把下载无限期拖住：两次 500MB 实测都停在 98.x%，
  日志无任何错误、字节数仍在极慢增长。**分块超过墙钟上限（建议 90s）必须中断并换镜像重试。**
  空闲超时与墙钟死线**两者都要**：只有空闲超时抓不到滴水，只有墙钟会误杀慢但活的镜像。

---

### Task 1: FSA 并行定位写入 spike（风险闸门）

**这是全项目最高风险项，必须先做。** 规范允许对同一个 `FileSystemWritableFileStream` 做并行定位写入，但调研未找到任何先例项目验证过——所有认真的浏览器多线程下载产品都配了原生 helper 绕开浏览器。**本任务不通过则整个架构需要改（改用 IndexedDB 拼装或顺序写入），后续任务全部作废。**

本任务不引入任何工具链，只写一个独立 HTML 文件，手工验证。

**Files:**
- Create: `spike/fsa-parallel.html`

**Interfaces:**
- Consumes: 无
- Produces: 对「并行定位写入是否可靠」的明确判定结论（通过 / 不通过 + 内存与校验和数据）

- [ ] **Step 1: 写 spike 页面**

创建 `spike/fsa-parallel.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>FSA 并行定位写入 spike</title>
<body>
<button id="go">开始</button>
<pre id="log"></pre>
<script>
// 预设。?preset=quick 用一个小文件 + 小块大小，几秒钟就能跑完整轮并比对哈希——
// 「定位写入是否正确」与文件大小无关，没必要用 500MB 去撞镜像的滴水限速。
const PRESETS = {
  full: {
    url: 'https://github.com/babalae/better-genshin-impact/releases/download/0.65.0/BetterGI.Install.0.65.0.exe',
    chunk: 8 * 1024 * 1024,
    workers: 4,
  },
  quick: {
    url: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip',
    chunk: 128 * 1024,   // 2 MB 文件 / 128 KB = 16 块，仍能跑出真正的 4 路并行
    workers: 4,
  },
};
const PRESET_NAME = new URLSearchParams(location.search).get('preset') || 'full';
const PRESET = PRESETS[PRESET_NAME] || PRESETS.full;
const URL_ = PRESET.url;
const MIRRORS = ['https://gh.xmly.dev/', 'https://gh.xxooo.cf/', 'https://gh.ddlc.top/', 'https://gh.monlor.com/'];
const CHUNK = PRESET.chunk;
const WORKERS = PRESET.workers;
const REQ_TIMEOUT_MS = 30000;   // 单请求「空闲」超时：只要还在出数据就不重新计时
const CHUNK_DEADLINE_MS = 90000; // 单分块「墙钟」死线。滴水式限速每几秒吐一个字节，
                                 // 能同时骗过空闲超时和进度看门狗（两者都只看「有没有动」），
                                 // 只有按墙钟计时的死线抓得到。实测中正是这个形态把下载无限期拖住。
const log = (m) => { document.getElementById('log').textContent += m + '\n'; };

const HAS_MEM = typeof performance !== 'undefined' && !!performance.memory;
// 无 performance.memory 时一律打印 N/A。打印 0MiB 会被读成「内存极好」——那是假 PASS。
const fmtHeap = (bytes) => HAS_MEM ? `${(bytes / 1048576).toFixed(0)}MiB` : 'N/A';

// 归因只看失败消息的文本，不看阶段前缀：[下载] 里同时装着「写入失败」与
// 「纯镜像请求失败（含忽略 Range 回 200 / Content-Range 失配 / 流被截断）」两类，
// 按前缀判断会把一次镜像退化误判成架构不成立。
// 写入桶只收「写入失败」（已覆盖较新的「写入失败或停滞」标签）：期望 206 / Content-Range / 截断
// 全是读侧、镜像侧的缺陷，与 stream.write 没有因果关系。把它们算进写入桶能直接否决整个架构：
// gh.xmly.dev 既是探针镜像（MIRRORS[0]），也是 WORKERS=1 时唯一使用的镜像；它中途退化时
// 会被判成写入问题 → 页面建议用 WORKERS=1 重跑 → 重跑用的还是同一个坏镜像 → 再失败 →
// 于是把一次瞬时镜像故障读成「定位写入本身不被支持，架构不成立」。截断尤其不能收进来：
// 流被截断不构成任何关于「定位写入是否可行」的证据。
// 注意顺序：[探针] 分支必须最先判——探针的 Content-Range 失配消息里也带着 "Content-Range"，
// 否则会被下面的镜像类正则捞走（好在那也归镜像桶，但结论话术不同，必须在探针分支里说清）。
const PROBE_FAIL_RE = /\[探针\]/;
const FINALIZE_FAIL_RE = /\[收尾\]/;
const WRITE_FAIL_RE = /写入失败/;
const MIRROR_FAIL_RE = /请求失败\/超时|流中断\/超时|期望 206|Content-Range|截断/;
function logFailureAttribution(msg) {
  const m = String(msg == null ? '' : msg);
  if (PROBE_FAIL_RE.test(m)) {
    log('[并发归因] 失败在探针阶段 —— 这是镜像 / 网络问题，与 FSA 无关，本轮没有验证任何东西。');
    log('[并发归因] 把另一个白名单镜像调到 MIRRORS 数组首位后原样重跑（探针硬编码 MIRRORS[0]，只改数组顺序、不换白名单外的镜像）；');
    log('[并发归因] 不要用 WORKERS=1 归因（它换的是并发度，换不掉一个坏镜像，而且照样只用 MIRRORS[0]）。');
  } else if (FINALIZE_FAIL_RE.test(m)) {
    log('[并发归因] 失败发生在收尾（close / 读取落盘文件大小），不是镜像问题；常见原因是磁盘空间不足或落盘失败。');
    log('[并发归因] 先确认目标盘剩余空间后原样重跑；不要用 WORKERS=1 归因——它改的是并发，与收尾无关。');
  } else if (WRITE_FAIL_RE.test(m)) {
    log('[并发归因] 失败消息指向写入本身（stream.write 被拒绝，或写入停滞超时）⇒ 把脚本顶部的 WORKERS 改成 1 后原样重跑（其余步骤不变）：');
    log('[并发归因] WORKERS=1 成功 ⇒ 定位写入本身可行，问题只在「并发写未串行化」（加写互斥即可救回架构）；');
    log('[并发归因] WORKERS=1 仍失败 ⇒ 定位写入本身不被支持，架构不成立。');
    log('[并发归因] 这条「架构不成立」的结论只对写入失败成立：期望 206 / Content-Range / 截断 属镜像侧缺陷，已归入镜像分支，不得据此判定架构不成立。');
  } else if (MIRROR_FAIL_RE.test(m)) {
    log('[并发归因] 失败消息指向某个镜像的请求 / 流问题（忽略 Range 回 200、Content-Range 失配、流被截断、请求 / 流超时），与写入无关 ⇒ 该镜像可疑。');
    log('[并发归因] 动作：把可疑镜像移到 MIRRORS 数组首位后原样重跑（探针硬编码 MIRRORS[0]，WORKERS=1 也只解析到 MIRRORS[0]，所以换镜像只能靠改数组顺序）；只用白名单里那 4 个镜像，不要替换成白名单外的。');
    log('[并发归因] 此时不要改成 WORKERS=1：WORKERS=1 只用 MIRRORS[0]，会静默丢掉故障镜像而「成功」，把镜像退化误读成并发问题。');
  } else {
    log('[并发归因] 失败消息既不像写入问题、也不像镜像请求问题 ⇒ 不得用 WORKERS=1 捷径下结论，先单独复现并记下完整消息。');
  }
}

document.getElementById('go').onclick = async () => {
  // 先在运行最开始、无条件地交代度量口径与归因方法，
  // 这样无论后面是成功还是失败，读日志的人都知道该怎么读这些数字。
  log(`预设 = ${PRESET_NAME}（改 URL 加 ?preset=quick 可跑小文件快速验证）`);
  log(`目标 = ${URL_}`);
  log(`WORKERS = ${WORKERS}（并发 worker 数；镜像白名单共 ${MIRRORS.length} 个）`);
  log(`镜像: ${MIRRORS.join(' , ')}`);
  log(`块大小 = ${CHUNK / 1048576} MiB，单请求超时 = ${REQ_TIMEOUT_MS / 1000}s`);
  log('[MEMORY] 下面的 heap/peak 只是渲染进程 V8 JS 堆的读数：TypedArray/ArrayBuffer 后备存储至多被部分计入，');
  log('[MEMORY] 而 FSA 写入管线与网络缓冲都活在浏览器进程里，performance.memory 完全看不到它们。');
  log('[MEMORY] 因此这个数字无法排除「整个浏览器进程的内存随文件大小增长」。');
  log('[MEMORY] 另外这些读数本身还是粗粒度的：未以 --enable-precise-memory-info 启动时 Chrome 会对该值分桶量化，只可当数量级看。');
  log('[MEMORY] 人工必须另开 Chrome 任务管理器（Shift+Esc），在下载前 / 下载中 / 下载后各记录一次本标签页内存，三项都写进结论。');
  if (!HAS_MEM) log('[MEMORY] 本环境没有 performance.memory：本次 heap=N/A peak=N/A —— 这是「测不到」，不是「内存优秀」。须用 Chrome/Edge 重跑。');
  // 并发归因只在失败时、且按失败消息的文本给出（见 logFailureAttribution）。
  // 在这里先交代判读口径，避免事后读日志的人不知道该怎么归因。
  log('[并发归因] 若失败，归因只看失败消息的文本，不看阶段前缀：[探针] ⇒ 镜像 / 网络问题，本轮无效；[收尾] ⇒ close / 落盘问题；');
  log('[并发归因] 含「写入失败」⇒ stream.write 本身的问题（可做 WORKERS=1 归因）；含「请求失败/超时 / 流中断/超时 / 期望 206 / Content-Range / 截断」⇒ 该镜像的请求 / 流问题，与写入无关：把可疑镜像调到 MIRRORS 数组首位（探针与 WORKERS=1 都只看 MIRRORS[0]）后原样重跑，不要用 WORKERS=1 捷径。');

  // 特性预检：非 Chromium / 非安全上下文时应报「环境不支持」，
  // 而不是抛 TypeError 之后再补一句 SecurityError 的提示，把不支持的环境带进重试死循环。
  if (typeof window.showSaveFilePicker !== 'function') {
    log('无法创建文件: 本环境没有 window.showSaveFilePicker。');
    log('本 spike 需要 Chromium 内核浏览器（Chrome / Edge），且页面必须经 http://localhost 提供；file:// 不是可靠的安全上下文，Firefox / Safari 也不支持该 API。');
    return;
  }
  // 能力检测必须检测 createWritable，而不是只看 showSaveFilePicker：
  // 有选择器、但没有 createWritable 的环境会在下面「若为 SecurityError …
  // 重新点一次即可」那句提示里被带进重试死循环——真正缺失的能力与用户激活无关。
  if (typeof FileSystemFileHandle === 'undefined' || typeof FileSystemFileHandle.prototype.createWritable !== 'function') {
    log('无法创建文件: 本环境有 window.showSaveFilePicker，但 FileSystemFileHandle.prototype.createWritable 不可用。');
    log('本 spike 的定位写入依赖 createWritable() 返回的 FileSystemWritableFileStream；只有保存选择器不构成所需能力，重试点击不会改变结果。');
    return;
  }

  // showSaveFilePicker 依赖用户手势的瞬时激活（Chrome 约 5 秒），
  // 因此它必须排在所有 await 之前。若先等镜像探测再调用，激活会过期并抛
  // SecurityError，表现为「点了没反应」——极易被误判成 FSA 不可行。
  // 这是本 spike 最容易踩的假阴性来源。
  let handle;
  let stream;
  let heapTimer;            // 声明在 try 之外，catch 里才能 clearInterval
  let watchdog;             // 同上：若用 const 声明在 try 内，catch 里引用会 ReferenceError 吞掉失败消息
  let aborted = false;      // 声明在 try 之外，catch 里置位，让其余 worker 立即停手
  // peakHeap / sampleHeap 也必须声明在 try 之外：失败路径同样要报出峰值堆。
  // [收尾] 失败（close 时才落盘、磁盘满时报错）恰恰是「关闭时才落盘」的峰值所在，
  // 那一次运行最需要这个数字；采样函数若定义在 try 内，catch 里引用会直接 ReferenceError，
  // 连失败消息本身都打不出来。它们都在 onclick 回调体里，每次点击重新初始化，不跨次累积。
  let peakHeap = 0;
  const sampleHeap = () => {
    if (!HAS_MEM) return;
    const h = performance.memory.usedJSHeapSize;
    if (Number.isFinite(h) && h > 0) peakHeap = Math.max(peakHeap, h);
  };
  const inflight = new Set(); // 在途请求的 AbortController，失败时统一取消
  try {
    handle = await window.showSaveFilePicker({ suggestedName: 'spike.bin' });
    stream = await handle.createWritable();
  } catch (e) {
    log(`无法创建文件: ${e.name} ${e.message}`);
    log('若为 SecurityError，是用户激活过期（非 FSA 问题），重新点一次即可。');
    return;
  }

  try {
    // ---- 探针阶段：单独标 [探针]，与下载阶段的失败区分开 ----
    // 否则一次纯网络失败会以裸 TypeError 的形式出现在 stream 已打开之后，读起来像下载失败。
    let total;
    try {
      const res0 = await fetch(MIRRORS[0] + URL_, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
      const cr = res0.headers.get('content-range');
      if (res0.status !== 206) {
        throw new Error(`status=${res0.status}（该镜像未返回 206，可能不遵守 Range 或已失效）`);
      }
      if (!cr || !cr.startsWith('bytes 0-0/')) {
        throw new Error(`Content-Range=${JSON.stringify(cr)} 前缀不等于 "bytes 0-0/"`);
      }
      total = Number(cr.split('/')[1]);
      if (!Number.isFinite(total) || total <= 0) {
        throw new Error(`Content-Range=${JSON.stringify(cr)} 解析出的 total=${cr.split('/')[1]} 不是正有限数`);
      }
    } catch (e) {
      throw new Error(`[探针] 镜像 ${MIRRORS[0]} 请求 bytes=0-0 失败: ${e.message}（镜像/网络问题，与 FSA 无关）`);
    }
    log(`total = ${total} (${(total / 1048576).toFixed(1)} MiB)`);

    const t0 = performance.now();
    let done = 0;
    // 独立定时采样峰值堆（采样函数定义在 try 之外，catch 里也要用它，见上）。
    // 只在分块边界采样会漏掉块内瞬时累积，而「堆是否随下载字节数线性增长」正是本 spike 的判定标准之一。
    heapTimer = setInterval(sampleHeap, 100);
    sampleHeap();

    const ranges = [];
    for (let s = 0; s < total; s += CHUNK) ranges.push([s, Math.min(s + CHUNK, total) - 1]);
    log(`chunks = ${ranges.length}`);

    let next = 0;

    // 全局进度看门狗。每个 await 都有 30s 上限，但若某次 abort 没能打断正在进行的
    // 流读取（非标准 Chromium 内核可能如此），就会永久静默——而「失败必须可归因」
    // 正是本 spike 的核心要求，静默停住是它唯一报不出来的形态。
    // 用独立墙钟：只要字节数长时间不增长就响亮报错，并点名在途请求数。
    // 阈值 45s > 单请求 30s，所以正常情况下不会与既有超时抢答。
    let lastSeenDone = -1;
    let lastProgressAt = performance.now();
    const WATCHDOG_MS = 45000;
    // 看门狗不仅要「报告」，更要能「强制结束」：若某个 worker 永久卡在一次不 resolve
    // 的 await 里，Promise.all 永不 settle，外层 catch 永不执行，日志就永远没有失败行
    // ——静默停住。用 Promise.race 保证必然走到 catch。
    let watchdogReject;
    const watchdogFailure = new Promise((_, rej) => { watchdogReject = rej; });
    watchdog = setInterval(() => {
      if (done !== lastSeenDone) {
        lastSeenDone = done;
        lastProgressAt = performance.now();
        return;
      }
      const idle = (performance.now() - lastProgressAt) / 1000;
      if (idle < WATCHDOG_MS / 1000) return;
      aborted = true;
      for (const a of inflight) { try { a.abort(); } catch (e) {} }
      log(`[看门狗] 已有 ${idle.toFixed(0)}s 没有任何字节进展，判定为停住（在途请求 ${inflight.size} 个）。`);
      log('[看门狗] 这是某个流卡住、或该流未被 abort 打断，不是定位写入的问题。');
      watchdogReject(new Error(`[看门狗] 停住：${idle.toFixed(0)}s 无字节进展，在途请求 ${inflight.size} 个（流卡住，非定位写入问题）`));
    }, 2000);

    // 所有抛出的错误都带上「镜像 prefix + 精确字节区间」，
    // 这样 4 个异构镜像里某一个退化（忽略 Range 回 200、或中途断连）才能与
    // 「并行定位写入不被支持」区分开——否则失败不可归因。
    async function worker(prefix) {
      while (!aborted && next < ranges.length) {
        const [start, end] = ranges[next++];
        const ac = new AbortController();
        inflight.add(ac);
        // 空闲超时：每个请求独立计时，且每次读到一个数据块就重新计时。
        // 于是镜像「挂住不动」超过 REQ_TIMEOUT_MS 必定响亮失败——不会不再出进度行、
        // 变成无法归因的停住；同时也不会误杀只是慢、但一直在出数据的镜像。
        let tid, wtid, cdeadline;
        let chunkTimedOut = false;
        const arm = () => { clearTimeout(tid); tid = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS); };
        try {
          arm();
          // 分块墙钟死线：独立于 arm() 的空闲计时。arm() 会被滴水重置，这个不会。
          cdeadline = setTimeout(() => { chunkTimedOut = true; ac.abort(); }, CHUNK_DEADLINE_MS);
          let res;
          try {
            res = await fetch(prefix + URL_, {
              headers: { Range: `bytes=${start}-${end}` },
              cache: 'no-store',   // 302 落点是限时签名 URL，禁止缓存
              signal: ac.signal,
            });
          } catch (e) {
            throw new Error(`[下载] 镜像 ${prefix} 区块 bytes=${start}-${end} 请求失败/超时: ${e.name} ${e.message}`);
          }
          if (res.status !== 206) {
            throw new Error(`[下载] 镜像 ${prefix} 区块 bytes=${start}-${end}: 期望 206，实际 ${res.status}（该镜像忽略了 Range 或已失效；不要把整包写入部分文件）`);
          }
          const cr = res.headers.get('content-range');
          const want = `bytes ${start}-${end}/`;
          if (!cr || !cr.startsWith(want)) {
            throw new Error(`[下载] 镜像 ${prefix} 区块 bytes=${start}-${end}: Content-Range=${JSON.stringify(cr)} 前缀不等于 ${JSON.stringify(want)}`);
          }
          const reader = res.body.getReader();
          let pos = start;
          for (;;) {
            if (aborted) throw new Error(`[下载] 镜像 ${prefix} 区块 bytes=${start}-${end} 因其它镜像先失败而中止`);
            arm();
            let r;
            try {
              r = await reader.read();
            } catch (e) {
              if (chunkTimedOut) {
                throw new Error(`[下载] 镜像 ${prefix} 区块 bytes=${start}-${end} 分块墙钟超时（${CHUNK_DEADLINE_MS / 1000}s 未完成，已读到 ${pos}）：疑似该镜像滴水式限速，换镜像重跑`);
              }
              throw new Error(`[下载] 镜像 ${prefix} 区块 bytes=${start}-${end} 流中断/超时（已读到 ${pos}）: ${e.name} ${e.message}`);
            }
            if (r.done) break;
            // 写入期间停掉「镜像空闲超时」：否则一次超过 REQ_TIMEOUT_MS 的写入会 abort 控制器，
            // 以「流中断/超时」出现在日志里，把写入停滞误标成镜像流超时——正是本任务最在意的归因噪声。
            // 写入侧改用独立且标签明确的计时（写入停滞），写完后再重新 arm()，恢复空闲超时语义。
            clearTimeout(tid);
            try {
              await Promise.race([
                stream.write({ type: 'write', position: pos, data: r.value }),
                new Promise((_, rej) => {
                  wtid = setTimeout(() => rej(new Error(`写入停滞超过 ${REQ_TIMEOUT_MS / 1000}s`)), REQ_TIMEOUT_MS);
                }),
              ]);
            } catch (e) {
              throw new Error(`[下载] 写入失败或停滞: 镜像 ${prefix} 区块 bytes=${start}-${end} 位置 ${pos}: ${e.name} ${e.message}`);
            } finally {
              clearTimeout(wtid);
            }
            arm();   // 写入结束，恢复「镜像空闲超时」语义
            pos += r.value.length;
            done += r.value.length;
          }
          if (pos !== end + 1) {
            throw new Error(`[下载] 镜像 ${prefix} 区块 bytes=${start}-${end} 截断: 已读到 ${pos}，应为 ${end + 1}`);
          }
          const secs = (performance.now() - t0) / 1000;
          const nowHeap = HAS_MEM ? performance.memory.usedJSHeapSize : 0;
          log(`${done} / ${total}  ${(done / 1048576 / secs).toFixed(2)} MiB/s  heap=${fmtHeap(nowHeap)} peak=${fmtHeap(peakHeap)}`);
        } finally {
          clearTimeout(tid);
          clearTimeout(wtid);
          clearTimeout(cdeadline);
          inflight.delete(ac);
        }
      }
    }

    const prefixes = MIRRORS.slice(0, WORKERS);
    if (WORKERS > MIRRORS.length) log(`注意: WORKERS=${WORKERS} 超过镜像数 ${MIRRORS.length}，实际只用 ${prefixes.length} 个 worker`);
    log(`实际启动 worker 数 = ${prefixes.length}`);
    await Promise.race([Promise.all(prefixes.map(worker)), watchdogFailure]);
    clearInterval(watchdog);
    // close() 阶段没有任何进度输出（done 不再增长，看门狗已停），但 500MB 的落盘 +
    // 原子替换可能要等一会。明确说出来，避免把「正在落盘」误判成「卡死」——
    // 这个混淆在实测中真实发生过。
    log('全部分块已下载完成，正在落盘（close）—— 此阶段没有进度输出，可能会静默一会，请等待「完成」行。');

    // 采样必须一直覆盖到 close()：createWritable() 若在 close 时才真正落盘，
    // 真实峰值出现在关闭期间，提前 clearInterval 会把峰值读平 → 假 PASS。
    // close 阶段的失败（磁盘满时最常见的 flush 失败恰好发生在这里，也正是「关闭时才落盘」
    // 的峰值所在）必须自带阶段标签，否则会以裸 DOMException 的形式出现在日志里，没有 [探针]/[下载] 前缀。
    try {
      await stream.close();
    } catch (e) {
      throw new Error(`[收尾] stream.close() 失败: ${e && e.name} ${e && e.message}`);
    }
    sampleHeap();              // close 之后（可能的 flush 之后）再补一次读数
    clearInterval(heapTimer);  // 到这里才停采样，覆盖范围包含 close 完成之后

    const secs = (performance.now() - t0) / 1000;
    log(`完成: ${(total / 1048576 / secs).toFixed(2)} MiB/s, 峰值堆 ${fmtHeap(peakHeap)}`);

    // 自证大小：让「文件字节数正确」直接出现在日志里，不必人工去翻分块日志。
    // 只读 .size —— 这是 500MB 文件，禁止把响应体整块缓冲进内存（见 Global Constraints 热路径禁令）。
    let written;
    try {
      written = (await handle.getFile()).size;
    } catch (e) {
      throw new Error(`[收尾] 大小校验读取失败: ${e && e.name} ${e && e.message}`);
    }
    if (written === total) {
      log(`[大小校验] PASS: 落盘文件 ${written} 字节 === total ${total}`);
      // 这句只在 PASS 分支打印：FAIL 时紧跟一句「长度正确但内容可能错位」是自相矛盾的，
      // 而且恰好出现在读者正要下判定的那一刻。
      log('[大小校验] 注意: 本条只证明长度正确，不证明内容正确——长度正确但内容错位同样会 PASS。');
    } else {
      log(`[大小校验] FAIL: 落盘文件 ${written} 字节 !== total ${total}（大小不符即不通过，无需再比哈希）。`);
    }
  } catch (e) {
    aborted = true;                        // 先置位，其余 worker 立即停止发起新请求
    sampleHeap();                          // 失败前最后采一次，让 peak 覆盖到失败时刻
    // 先落诊断，再做任何可能挂住的清理。清理里含 await stream.abort()——若该 promise
    // 在某些实现下不 settle，把 log 放在其后会让失败原因永远打不出来。实测疑似正是这个
    // 形态：跑到 98.5% 静默停住、目标文件 0 字节、日志里没有任何失败行。
    log(`失败: ${e && e.message}  peak=${fmtHeap(peakHeap)}`);
    logFailureAttribution(e && e.message);
    clearInterval(heapTimer);
    clearInterval(watchdog);
    for (const ac of inflight) { try { ac.abort(); } catch {} }
    try { await stream.abort(); } catch {}
  }
};
</script>
</body>
</html>
```

> **为什么 `showSaveFilePicker` 必须排在所有 `await` 之前：** 它依赖用户手势的「瞬时激活」，
> Chrome 里这个窗口约 5 秒。若先等镜像探测再调用，激活会过期并抛 `SecurityError`，
> 表现为「点了没反应」——极易被误判成 FSA 不可行。**这是本 spike 最容易踩的假阴性，
> 务必保持这个调用顺序**（排在它前面的特性预检只是属性读取，不消耗激活）。预检本身按
> Global Constraints 同时检查 `window.showSaveFilePicker` 与
> `FileSystemFileHandle.prototype.createWritable`：只有选择器、没有 `createWritable` 的环境，
> 会以一句点名真实缺失能力的消息退出，而不是被下面那句 SecurityError 的重试提示带进重试死循环。
> 同理，探针与下载都包在 `try` 里，任何失败都会写进日志面板，不会出现「空白日志」这种无法归因的结果。
>
> **失败必须可归因：** 日志里每一条 `失败:` 都带阶段标签（`[探针]` / `[下载]` / `[收尾]`），
> 并附上具体的镜像 URL 与字节区间。4 个异构镜像里某个退化（忽略 Range 回 200、中途断连、挂住）
> 会因此与「并行定位写入不被支持」区分开——**判读时按失败消息的文本判定，不按阶段前缀判定**
> （`[下载]` 里同时装着写入问题和纯镜像请求失败，见 Step 3 的归因表），
> 否则会把一次镜像故障误判成架构不成立。

- [ ] **Step 2: 起本地服务器并打开**

`file://` 不是可靠的安全上下文，必须走 localhost：

```powershell
cd "D:\github_download++\spike"
python -m http.server 8000
```

> **用两行，不要写成 `cd ... && python ...`。** 本机交互式 shell 是 **PowerShell 5.1**，
> `&&` 在 PowerShell 7 之前不是合法的语句分隔符，会直接报
> 「标记"&&"不是此版本中的有效语句分隔符」。Windows 上给用户的操作命令一律按
> PowerShell 语法写（或拆成多行），不要用 bash 的 `&&` 连接。

浏览器打开 `http://localhost:8000/fsa-parallel.html`。

- [ ] **Step 3: 跑并记录**

**先取内存基线。** 打开 Chrome 任务管理器（`Shift+Esc`），在点击开始**之前**记下本标签页的内存。

页面日志里的 `heap=` / `peak=` **只是渲染进程 V8 JS 堆的读数**：TypedArray/ArrayBuffer 后备存储至多被部分
计入，而 FSA 写入管线与网络缓冲都活在浏览器进程里，`performance.memory` 根本看不到它们。
**所以这个数字无法排除「整个浏览器进程的内存随文件大小增长」**——它必须由人工用任务管理器交叉验证，
否则「峰值堆两百 MiB」会被读成一个并不成立的结论。
另外这个读数本身是粗粒度的：未以 `--enable-precise-memory-info` 启动时，Chrome 会对
`performance.memory` 的取值分桶量化，只能当数量级看，不要拿它做精确对比。

点击「开始」，选择保存位置，等待完成。记录以下数据：

1. **最终速度**（MiB/s）
2. **峰值 JS 堆**（页面日志里的 `peak=`）——若随下载量线性增长，说明有累积，不通过。
   若显示 `N/A`，说明该环境没有 `performance.memory`：这是「测不到」而**不是**「内存优秀」，
   必须改用 Chrome/Edge 重跑，不得据此判定通过。
3. **本标签页内存的三个读数**（任务管理器）：下载**前** / 下载**中** / 下载**后**各一次。
   若读数随下载字节数持续攀升而不是在高位附近波动后回落，说明有整包累积，不通过。
4. **`[大小校验]` 行**：页面在 `close()` 之后会打印 `PASS` 或 `FAIL`。出现 `FAIL` 即不通过。
   **`PASS` 只证明长度正确，不证明内容正确**——长度正确但内容错位（见 Step 5）同样会打印 `PASS`，
   所以这一行既不能替代 SHA-256，也不是「过了就不用算哈希」的通行证。
5. **文件 SHA-256**（参照文件由 Step 4 提供）

算哈希与大小：

```bash
certutil -hashfile "下载到的文件路径" SHA256
```

**`certutil -hashfile` 不打印文件大小**，它只打印路径和哈希。要拿下载文件的确切字节数必须另取，
不要从 `certutil` 的输出里找：

```bash
ls -l "下载到的文件路径"
stat -c '%s' "下载到的文件路径"     # MSYS / Git Bash
```

**若失败，必须做并发归因，否则结论不可用。** 归因**按失败消息的文本判断，不按阶段前缀判断**——
`[下载]` 里既有写入本身的问题，也有纯镜像请求失败（忽略 Range 回 200 / `Content-Range` 失配 / 流被截断）：

| 失败消息里出现 | 含义 | 下一步 |
| --- | --- | --- |
| `写入失败` | 定位写入本身失败（`stream.write` 被拒绝，或写入停滞超时） | 可做 `WORKERS=1` 归因（见下） |
| `期望 206` / `Content-Range` / `截断` / `请求失败/超时` / `流中断/超时` | **该镜像**的请求 / 流缺陷（忽略 Range 回 200、响应头失配、流被截断、超时）——与写入无关 | **换镜像**重跑：把可疑镜像调到 `MIRRORS` 数组首位（探针硬编码 `MIRRORS[0]`，`WORKERS=1` 也只解析到 `MIRRORS[0]`），不要用 `WORKERS=1` |
| `[探针]` | 镜像 / 网络问题，与 FSA 无关，本轮没有验证任何东西 | 换一个可用镜像重跑：把另一个白名单镜像调到 `MIRRORS` 数组首位 |
| `[收尾]` | `close()` / 读取落盘大小失败，常见于磁盘空间不足 | 确认目标盘空间后原样重跑 |

**`期望 206` / `Content-Range` / `截断` 全部是读侧、镜像侧的缺陷，与写入没有因果关系**，
因此**不在**写入桶里：把它们算成写入问题会直接否决整个架构——`gh.xmly.dev` 既是探针镜像（`MIRRORS[0]`），
也是 `WORKERS=1` 时唯一使用的镜像；它中途退化时会被判成写入问题 → 页面建议 `WORKERS=1` 重跑 →
重跑用的还是同一个坏镜像 → 再失败 → 于是把一次瞬时镜像故障读成「定位写入本身不被支持，架构不成立」。
`截断` 尤其不能算作写入问题：流被截断不构成任何关于「定位写入是否可行」的证据。

**只有**失败消息指向写入本身（`写入失败`）时，才把 `spike/fsa-parallel.html` 顶部的
`const WORKERS = 4;` 改成 `1` 后原样重跑：

- `WORKERS=1` **成功** ⇒ 定位写入本身可行，问题只在「并发写未串行化」（spike 里每个 worker 各自
  `await stream.write()`，彼此并未串行）。按 Global Constraints 给 `sink.write()` 加写互斥即可救回架构，
  **这不算本任务不通过**。
- `WORKERS=1` **仍失败** ⇒ 定位写入本身不被支持，架构不成立，本任务不通过。

**若失败消息指向镜像请求 / 流问题（含 `期望 206` / `Content-Range` / `截断`），绝不要用 `WORKERS=1` 归因。**
`WORKERS=1` 只使用 `MIRRORS[0]`，会把故障镜像静默丢掉，于是重跑可能「成功」——那只说明那个镜像坏，
不说明并发有问题。这种情况的正确动作是换一个镜像重跑。

**「换一个镜像」的具体做法是调整 `MIRRORS` 数组顺序，而不是换别的镜像站。** 镜像白名单固定为那 4 个
（见 Global Constraints），不得引入白名单外的镜像；而探针硬编码 `MIRRORS[0]`、`WORKERS=1` 也只解析到
`MIRRORS[0]`，所以「让另一个镜像起作用」的唯一可执行动作就是把它挪到数组首位后原样重跑。

两种结果都要写进结论，因为它决定后续任务的架构改法。

- [ ] **Step 4: 校验正确性（强制，不可跳过）**

预期总大小 `499558899` 字节。用上面的 `ls -l` / `stat` 拿到下载文件的确切字节数，确认与 `499558899`
完全一致，并与页面日志里的 `[大小校验] PASS`（`(await handle.getFile()).size === total`）互相印证。

**但大小一致不等于文件正确。** 本闸门最危险的假 PASS 形态是：流接受了定位写入，却按自己的内部偏移
落盘而不是按 `position` 落盘——产出的文件**长度完全正确、内容整体错位**，而且下载速度照样很好
（正是本任务想要的那种速度）。这种文件能通过任何大小检查，页面自己的 `[大小校验]` 也照样打印 `PASS`，
而 `certutil -hashfile` 根本不打印大小。**只有 SHA-256 能抓到它。**

因此必须取一份参照文件并**比对 SHA-256**，没有替代方案。参照副本**经镜像**获取——直连 0.06 MB/s
太慢，镜像实测单连接 3.8 MB/s、并行 22+ MB/s，所以「直连太慢」不再构成跳过哈希的理由：

```bash
curl -fL --max-time 600 -o "$USERPROFILE/Downloads/ref.exe" "https://gh.xmly.dev/https://github.com/babalae/better-genshin-impact/releases/download/0.65.0/BetterGI.Install.0.65.0.exe"
stat -c '%s' "$USERPROFILE/Downloads/ref.exe"     # MSYS / Git Bash；必须等于 499558899 才能用
certutil -hashfile "$USERPROFILE/Downloads/ref.exe" SHA256
certutil -hashfile "下载到的文件路径" SHA256
```

- **`-f` 不可省**：没有 `-f` 时，镜像返回 4xx / 5xx 会把错误页正文写进 `ref.exe`，
  `curl` 照样退出 0，于是「错误页」被当成参照文件——哈希必然对不上，且看起来像下载文件有问题。
- **`--max-time 600` 不可省**：镜像挂住时必须响亮失败（`curl` 退出非 0），
  而不是让这一步无限期停在那里。
- **参照文件自身的字节数必须等于 `499558899`**（上面的 `stat -c '%s'`），
  **在拿它当尺子之前就要核对**。参照被截断时它的哈希必然与下载文件不符，
  而这个不符是**强制不通过**条件——于是截断的参照会直接伪造出「架构不成立」的假阴性。
  若参照大小不等于 `499558899`，**换另一个镜像重取**，不要拿这个残缺参照继续、也不要因此降级成只比大小。
- **参照文件不要放 `/tmp`**：它在 Windows 上不是 `certutil` 能解析的路径，落到 `%USERPROFILE%\Downloads`。
- `curl` 对这些镜像可用：这 4 个镜像不在 Watt Toolkit 的 hosts 拦截列表里，curl 自带 CA 包即可。
- 如果镜像路径拿到的参照本身可疑（例如下载过程报错），换另一个镜像重取，**不得**因此降级成只比大小。
- 两份 `certutil` 输出的哈希必须逐字相同。**不一致即本任务不通过**，不存在「大小对得上就放过」。

**长度正确但内容错位是本闸门最危险的假 PASS 形态，SHA-256 是唯一能抓到它的检查。**

- [ ] **Step 5: 判定并提交结论**

**通过条件（全部满足，缺一不可）：**

1. **SHA-256 必须与参照完全一致（强制，不可跳过，不接受任何替代）。**
   参照按 Step 4 经镜像获取，两份 `certutil -hashfile … SHA256` 输出逐字相同。
   **文件大小一致不能作为正确性的证据**：长度正确但内容错位的文件能通过任何大小检查，
   包括页面自己的 `[大小校验] PASS`（它比较的只是页面自己数出来的字节数，是循环论证），
   而 `certutil -hashfile` 压根不打印文件大小。唯一能证明内容正确的检查是 SHA-256。
2. **速度显著优于 0.06 MB/s 的直连基线**（预期 > 3 MB/s）。
3. **内存不随下载字节数线性增长**，以下两条证据都要：
   - JS 堆峰值稳定在几百 MiB 以内，且不随下载字节数线性增长；
   - Chrome 任务管理器（`Shift+Esc`）在下载**前 / 中 / 后**三次记录的**本标签页内存**不随下载字节数
     线性增长。

   若页面显示 `heap=N/A`，说明该环境没有 `performance.memory`——此时**以任务管理器读数为唯一依据**，
   并须改用 Chrome / Edge 重跑；不得把 `N/A` 读成「内存优秀」。

**本闸门在防什么：** 长度正确但内容错位是本闸门最危险的假 PASS 形态，SHA-256 是唯一能抓到它的检查。

**若在 `WORKERS=4` 失败但 `WORKERS=1` 成功**（且失败消息确实指向 `写入失败` 本身，见 Step 3 归因表；
若失败消息是 `期望 206` / `Content-Range` / `截断`，那是镜像侧缺陷，不适用本条）：
架构判定为**通过**，但 Task 2 之后的 `sink.write()` 必须实现串行化（Global Constraints 已要求），
计划按此继续。

**不通过** → 停止，回报用户，改走 IndexedDB 拼装或顺序写入方案，本计划需重写。

```bash
cd "D:/github_download++" && git add spike/fsa-parallel.html && git commit -m "spike: 验证 FSA 并行定位写入可行性"
```

---

### Task 2: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `src/types.ts`
- Create: `tests/smoke.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Consumes: 无
- Produces: 可运行的 `npm test` 与 `npm run typecheck`；`src/types.ts` 中的 `Chunk`、`Mirror`、`Sink`、`ProbeResult`、`ReleaseRef`、`AssetMeta` 类型
  （`npm run dev` / `npm run build` 本任务**尚不可用**：Vite 默认构建入口是 `index.html`，
  而本任务禁止创建它。这两条要到 Task 9 建立 `index.html` 之后才生效。）

- [ ] **Step 1: 手写 `package.json` 并安装依赖**

**不要用 `npm init -y`，它会失败。** npm 从目录名推导包名，而本仓库目录名
`github_download++` 含 `+`（非法字符），直接报 `npm error Invalid name: "github_download++"`，
且不可重试。（这与「GitHub 仓库名不能用 `+`」是同一个约束——当初已因此把仓库命名为
`github-download-accelerator`，但 npm 这一侧会撞上同一堵墙。）

直接写 `package.json`：

```json
{
  "name": "github-download-accelerator",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- **`"type": "module"` 是必需的**：本项目配置与源码都是 ESM。不设它，Vite 加载
  `vite.config.ts` 时会警告「ESM 语法被按 CommonJS 处理」（`configLoader: 'native'`），
  而其未来主版本会把 ESM 设为默认，届时直接报错。本项目 npm script 全是
  `vite` / `tsc` 等外部命令，没有项目内的 `.js` 脚本，故设 ESM 无副作用。
- 不写 `"main"`：`npm init` 默认的 `index.js` 并不存在，对 Vite 应用无意义。
- `"private": true`：防止误发布到 npm。

然后安装依赖（两行写，PowerShell 与 bash 通用）：

```bash
cd "D:/github_download++"
npm i -D typescript vite vitest @types/node
```

- [ ] **Step 2: 写配置文件**

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests", "vite.config.ts"]
}
```

`vite.config.ts`：

```ts
// 必须从 'vitest/config' 引入 defineConfig，不能从 'vite'：
// vite 的 UserConfig 类型不认识 `test` 键，从 'vite' 引入会让该键失去类型检查。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  build: { outDir: 'dist' },
  test: { globals: true, environment: 'node' },
});
```

`.gitignore`：

```
node_modules/
dist/
```

`package.json` 的 `scripts` 改为：

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: 定义共享类型**

创建 `src/types.ts`：

```ts
/** 一段待下载的字节区间，闭区间（end 为最后一个字节的下标）。 */
export interface Chunk {
  index: number;
  start: number;
  end: number;
}

/** 一个 GitHub 代理镜像。prefix 形如 "https://gh.xmly.dev/"，用法为 prefix + 原始 GitHub URL。 */
export interface Mirror {
  id: string;
  prefix: string;
}

/** 下载落盘目标。实现可以是 FSA，也可以是内存回退。 */
export interface Sink {
  /** 从文件顶部起 position 字节处写入 data。实现必须串行化，调用方会 await。 */
  write(position: number, data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface ProbeResult {
  mirror: Mirror;
  ok: boolean;
  bytesPerSec: number;
  ttfbMs: number;
}

/** 从 Release URL 解析出的坐标。 */
export interface ReleaseRef {
  owner: string;
  repo: string;
  tag: string;
  file: string;
}

/** 资源元数据。acceptRanges 为 false 时不得分块。 */
export interface AssetMeta {
  total: number;
  filename: string;
  acceptRanges: boolean;
}
```

- [ ] **Step 4: 写冒烟测试**

创建 `tests/smoke.test.ts`：

```ts
import { describe, it, expect } from 'vitest';

describe('脚手架', () => {
  it('TypeScript 与 Vitest 可运行', () => {
    const n: number = 1 + 1;
    expect(n).toBe(2);
  });
});
```

- [ ] **Step 5: 验证**

```bash
cd "D:/github_download++" && npm run typecheck && npm test
```

预期：typecheck 无错，测试 1 passed。

- [ ] **Step 6: 提交**

```bash
cd "D:/github_download++" && git add -A && git commit -m "chore: Vite + TypeScript + Vitest 脚手架与共享类型"
```

---

### Task 3: `planner.ts` 分块规划（TDD）

**Files:**
- Create: `src/planner.ts`
- Test: `tests/planner.test.ts`

**Interfaces:**
- Consumes: `src/types.ts` 的 `Chunk`
- Produces: `DEFAULT_CHUNK_SIZE: number`（`8388608`）、`MIN_CHUNK_SIZE: number`（`1048576`）、`plan(total: number, chunkSize?: number): Chunk[]`、`splitChunk(chunk: Chunk, minChunkSize?: number): [Chunk, Chunk] | null`
  （`minChunkSize` 可覆盖是必需的，不是可选美化：默认下限 1 MiB 时，`len < minChunkSize * 2`
  对 2 KB 的测试块恒成立，`splitChunk` 永远返回 `null`，拆分分支根本走不到。）

- [ ] **Step 1: 写失败的测试**

创建 `tests/planner.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { plan, splitChunk, DEFAULT_CHUNK_SIZE, MIN_CHUNK_SIZE } from '../src/planner';

describe('plan', () => {
  it('总长为 0 时返回空数组', () => {
    expect(plan(0)).toEqual([]);
  });

  it('整除时块数与区间正确', () => {
    expect(plan(8, 4)).toEqual([
      { index: 0, start: 0, end: 3 },
      { index: 1, start: 4, end: 7 },
    ]);
  });

  it('不整除时最后一块被截断到 total-1', () => {
    expect(plan(10, 4)).toEqual([
      { index: 0, start: 0, end: 3 },
      { index: 1, start: 4, end: 7 },
      { index: 2, start: 8, end: 9 },
    ]);
  });

  it('total 小于块大小时只有一块', () => {
    expect(plan(3, 100)).toEqual([{ index: 0, start: 0, end: 2 }]);
  });

  it('覆盖全部字节且无缝隙无重叠', () => {
    const chunks = plan(499558899, DEFAULT_CHUNK_SIZE);
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].end).toBe(499558899 - 1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBe(chunks[i - 1].end + 1);
    }
  });

  it('拒绝负数与非整数', () => {
    expect(() => plan(-1)).toThrow();
    expect(() => plan(1.5)).toThrow();
    expect(() => plan(10, 0)).toThrow();
  });
});

describe('splitChunk', () => {
  it('把一块均分为两块', () => {
    expect(splitChunk({ index: 0, start: 0, end: 9 })).toEqual([
      { index: 0, start: 0, end: 4 },
      { index: 1, start: 5, end: 9 },
    ]);
  });

  it('奇数长度时前半段较短', () => {
    expect(splitChunk({ index: 0, start: 0, end: 8 })).toEqual([
      { index: 0, start: 0, end: 3 },
      { index: 1, start: 4, end: 8 },
    ]);
  });

  it('单字节块无法再分，返回 null', () => {
    expect(splitChunk({ index: 0, start: 5, end: 5 })).toBeNull();
  });

  it('已到 MIN_CHUNK_SIZE 的块返回 null', () => {
    expect(splitChunk({ index: 0, start: 0, end: MIN_CHUNK_SIZE - 1 })).toBeNull();
  });

  it('可用 minChunkSize 覆盖默认下限（测试与小文件场景需要）', () => {
    expect(splitChunk({ index: 0, start: 0, end: 1023 }, 256)).toEqual([
      { index: 0, start: 0, end: 511 },
      { index: 1, start: 512, end: 1023 },
    ]);
    expect(splitChunk({ index: 0, start: 0, end: 511 }, 256)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "D:/github_download++" && npx vitest run tests/planner.test.ts
```

预期：FAIL，报 `Failed to resolve import "../src/planner"`。

- [ ] **Step 3: 写最小实现**

创建 `src/planner.ts`：

```ts
import type { Chunk } from './types';

/** 默认块大小 8 MiB。取保守值以规避「大 Range 被 403」的上游限制（参见 aria2 issue #1627）。 */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

/** 块大小下限。小于此值仍失败则判定为硬失败，不再继续拆分。 */
export const MIN_CHUNK_SIZE = 1024 * 1024;

export function plan(total: number, chunkSize: number = DEFAULT_CHUNK_SIZE): Chunk[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`total 必须是非负整数，收到 ${total}`);
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunkSize 必须是正整数，收到 ${chunkSize}`);
  }
  if (total === 0) return [];

  const chunks: Chunk[] = [];
  let index = 0;
  for (let start = 0; start < total; start += chunkSize) {
    chunks.push({ index: index++, start, end: Math.min(start + chunkSize, total) - 1 });
  }
  return chunks;
}

/**
 * 把一块均分为两块。用于「大 Range 被 403」时的本地递归降级。
 * 块长度不足 minChunkSize * 2 时返回 null，表示已达拆分下限。
 * minChunkSize 可覆盖是为了让测试能用小体积数据驱动拆分逻辑。
 */
export function splitChunk(chunk: Chunk, minChunkSize: number = MIN_CHUNK_SIZE): [Chunk, Chunk] | null {
  const len = chunk.end - chunk.start + 1;
  if (len < minChunkSize * 2) return null;
  const mid = chunk.start + Math.floor(len / 2);
  return [
    { index: 0, start: chunk.start, end: mid - 1 },
    { index: 1, start: mid, end: chunk.end },
  ];
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd "D:/github_download++" && npx vitest run tests/planner.test.ts
```

预期：11 passed（`plan` 组 6 个 + `splitChunk` 组 5 个）。

- [ ] **Step 5: 提交**

```bash
cd "D:/github_download++" && git add src/planner.ts tests/planner.test.ts && git commit -m "feat: 分块规划与块拆分"
```

---

### Task 4: `resolver.ts` 解析 URL 与元数据（TDD）

**Files:**
- Create: `src/resolver.ts`
- Test: `tests/resolver.test.ts`

**Interfaces:**
- Consumes: `src/types.ts` 的 `ReleaseRef`、`AssetMeta`
- Produces: `parseReleaseUrl(raw: string): ReleaseRef`、`resolveMetadata(url: string, mirrorPrefix: string, fetchFn?: typeof fetch): Promise<AssetMeta>`

**设计要点：** 用 `Range: bytes=0-0` 的 GET 而非 HEAD，一次请求同时拿到总大小与 Range 支持情况（206 → 支持，200 → 不支持），减少往返。

- [ ] **Step 1: 写失败的测试**

创建 `tests/resolver.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "D:/github_download++" && npx vitest run tests/resolver.test.ts
```

预期：FAIL，报 `Failed to resolve import "../src/resolver"`。

- [ ] **Step 3: 写最小实现**

创建 `src/resolver.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd "D:/github_download++" && npx vitest run tests/resolver.test.ts
```

预期：11 passed。

- [ ] **Step 5: 提交**

```bash
cd "D:/github_download++" && git add src/resolver.ts tests/resolver.test.ts && git commit -m "feat: Release URL 解析与资源元数据探测"
```

---

### Task 5: `mirrors.ts` 镜像注册表与健康度（TDD）

**Files:**
- Create: `src/mirrors.ts`
- Test: `tests/mirrors.test.ts`

**Interfaces:**
- Consumes: `src/types.ts` 的 `Mirror`、`ProbeResult`
- Produces: `KNOWN_MIRRORS: Mirror[]`、`class MirrorPool`，含 `available(): Mirror[]`、`recordSuccess(id: string, bytesPerSec: number): void`、`recordFailure(id: string): void`、`ranked(): Mirror[]`

**设计要点：** 仅 4 个实测可用的镜像。健康度用「成功率 + 最近吞吐」排序，失败累计到阈值即降权到队尾，避免反复用坏镜像拖慢整体。

- [ ] **Step 1: 写失败的测试**

创建 `tests/mirrors.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "D:/github_download++" && npx vitest run tests/mirrors.test.ts
```

预期：FAIL，报 `Failed to resolve import "../src/mirrors"`。

- [ ] **Step 3: 写最小实现**

创建 `src/mirrors.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd "D:/github_download++" && npx vitest run tests/mirrors.test.ts
```

预期：9 passed（`KNOWN_MIRRORS` 组 3 个 + `MirrorPool` 组 6 个）。

- [ ] **Step 5: 提交**

```bash
cd "D:/github_download++" && git add src/mirrors.ts tests/mirrors.test.ts && git commit -m "feat: 镜像注册表与健康度排序"
```

---

### Task 6: `probe.ts` 镜像测速优选（TDD）

**Files:**
- Create: `src/probe.ts`
- Test: `tests/probe.test.ts`

**Interfaces:**
- Consumes: `src/types.ts` 的 `Mirror`、`ProbeResult`
- Produces: `PROBE_BYTES: number`（`524288`）、`probeMirrors(url: string, mirrors: Mirror[], fetchFn?: typeof fetch, timeoutMs?: number): Promise<ProbeResult[]>`

**设计要点：** 对每个镜像发 512 KiB 的 Range 请求，记录 TTFB 与吞吐。超时或出错标记 `ok: false`。所有镜像的探测**并发**执行，总耗时 = 最慢的那个。

- [ ] **Step 1: 写失败的测试**

创建 `tests/probe.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "D:/github_download++" && npx vitest run tests/probe.test.ts
```

预期：FAIL，报 `Failed to resolve import "../src/probe"`。

- [ ] **Step 3: 写最小实现**

创建 `src/probe.ts`：

```ts
import type { Mirror, ProbeResult } from './types';

/** 探针请求的字节数。512 KiB 足够让吞吐估计脱离 TTFB 主导，又不浪费带宽。 */
export const PROBE_BYTES = 512 * 1024;

export const PROBE_TIMEOUT_MS = 3000;

async function probeOne(
  url: string,
  mirror: Mirror,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetchFn(mirror.prefix + url, {
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
      signal: controller.signal,
    });
    if (res.status !== 206) {
      return { mirror, ok: false, bytesPerSec: 0, ttfbMs: Date.now() - t0 };
    }
    const buf = await res.arrayBuffer();
    const elapsed = (Date.now() - t0) / 1000;
    if (buf.byteLength === 0 || elapsed <= 0) {
      return { mirror, ok: false, bytesPerSec: 0, ttfbMs: Date.now() - t0 };
    }
    return {
      mirror,
      ok: true,
      bytesPerSec: buf.byteLength / elapsed,
      ttfbMs: Date.now() - t0,
    };
  } catch {
    return { mirror, ok: false, bytesPerSec: 0, ttfbMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发探测全部镜像，返回结果（顺序与入参一致）。
 * 单个镜像失败不影响其他镜像。
 */
export async function probeMirrors(
  url: string,
  mirrors: Mirror[],
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult[]> {
  return Promise.all(mirrors.map((m) => probeOne(url, m, fetchFn, timeoutMs)));
}
```

> 注：`probeOne` 里对 512 KiB 用了 `arrayBuffer()`。这是刻意为之——探针体量固定且很小，一次读完最简单；**下载主路径（`engine.ts`）严禁如此**，必须流式。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd "D:/github_download++" && npx vitest run tests/probe.test.ts
```

预期：6 passed。

- [ ] **Step 5: 提交**

```bash
cd "D:/github_download++" && git add src/probe.ts tests/probe.test.ts && git commit -m "feat: 镜像并发测速优选"
```

---

### Task 7: `engine.ts` 下载调度核心（TDD）

**本任务是项目核心。** 用注入的假 `fetchFn` 与假 `Sink` 完整测试，不依赖浏览器。

**Files:**
- Create: `src/engine.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `task3` 的 `plan`/`splitChunk`/`MIN_CHUNK_SIZE`；`task5` 的 `MirrorPool`；`src/types.ts` 的 `Mirror`、`Sink`、`Chunk`
- Produces: `download(opts: DownloadOptions): Promise<void>`；`class ChunkError extends Error`（带 `retryable: boolean`）

**实现说明（相对 spec 的一处刻意简化）：** spec 第 6 节写的是「403 时全局减半块大小并重规划剩余区间」。本计划改为**对失败的那一块做本地递归对半拆分**（`splitChunk`）并重新入队。两者意图相同（把 Range 缩小），但本地拆分无需跨 worker 协调全局队列，实现简单得多且行为等价。

**并发模型的关键约束：** 单个镜像失效**绝不能**导致整个下载失败——这是 spec 明确要求的容错。因此不能用朴素的「worker 抛出 → `Promise.all` 拒绝」写法：那会让 4 个镜像里任意一个坏掉就杀死全部工作。

改用**未完块计数 `outstanding` + 重新入队**：worker 只在 `outstanding === 0` 时才退出；单块在某镜像上反复失败时，把它**放回队尾**而不是抛出，让其他健康镜像有机会接手。放回后本 worker 会先 `await` 退避（约 200ms），而空闲的对等 worker 每 10ms 轮询一次队列，因此健康镜像总能先抢到该块。只有 `outstanding` 无法归零（即所有镜像都救不回某块）时才判为整体失败。

- [ ] **Step 1: 写失败的测试**

创建 `tests/engine.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { download, ChunkError } from '../src/engine';
import type { Mirror, Sink } from '../src/types';

const URL_ = 'https://github.com/o/r/releases/download/v1/a.exe';
const MIRRORS: Mirror[] = [
  { id: 'a', prefix: 'https://a.test/' },
  { id: 'b', prefix: 'https://b.test/' },
];

/** 内存 sink，记录每次写入，用于校验最终文件内容。 */
class MemSink implements Sink {
  readonly buf: Uint8Array;
  readonly writes: { position: number; len: number }[] = [];
  closed = false;
  aborted = false;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
  }
  async write(position: number, data: Uint8Array): Promise<void> {
    this.buf.set(data, position);
    this.writes.push({ position, len: data.byteLength });
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
}

/** 造一个按 Range 返回确定性字节的服务端（字节值 = 位置 mod 251）。 */
function rangeServer(total: number, opts: { failOn?: (start: number, end: number, mirrorPrefix: string) => number | null } = {}) {
  const calls: { prefix: string; start: number; end: number }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const prefix = MIRRORS.find((m) => url.startsWith(m.prefix))?.prefix;
    if (!prefix) return new Response(null, { status: 404 });
    const range = (init?.headers as Record<string, string>).Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    const start = Number(m![1]);
    const end = Number(m![2]);
    calls.push({ prefix, start, end });

    const forced = opts.failOn?.(start, end, prefix);
    if (forced) return new Response(null, { status: forced });
    if (end >= total) return new Response(null, { status: 416 });

    const body = new Uint8Array(end - start + 1);
    for (let i = 0; i < body.length; i++) body[i] = (start + i) % 251;
    return new Response(body, {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${total}` },
    });
  }) as unknown as typeof fetch;
  return { f, calls };
}

/** 逐字节生成期望内容。 */
function expected(total: number): Uint8Array {
  const b = new Uint8Array(total);
  for (let i = 0; i < total; i++) b[i] = i % 251;
  return b;
}

describe('download', () => {
  it('完整下载一个整除块大小之外的文件', async () => {
    const total = 4099;
    const { f } = rangeServer(total);
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(sink.buf).toEqual(expected(total));
    expect(sink.closed).toBe(true);
  });

  it('写入是按偏移定位的，不依赖完成顺序', async () => {
    const total = 2048;
    const { f } = rangeServer(total);
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 512, fetchFn: f });
    expect(sink.writes.length).toBeGreaterThan(0);
    for (const w of sink.writes) expect(w.position % 512).toBe(0);
  });

  it('并发覆盖全部区间，无重复抓取', async () => {
    const total = 4096;
    const { f, calls } = rangeServer(total);
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.start).sort((x, y) => x - y)).toEqual([0, 1024, 2048, 3072]);
  });

  it('分块跨镜像分散（至少用到两个镜像）', async () => {
    const total = 8192;
    const { f, calls } = rangeServer(total);
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(new Set(calls.map((c) => c.prefix)).size).toBeGreaterThan(1);
  });

  it('收到 200（上游忽略 Range）时立即失败，不写入损坏数据', async () => {
    const total = 1024;
    const f = (async () => new Response(new Uint8Array(1024), { status: 200 })) as unknown as typeof fetch;
    const sink = new MemSink(total);
    await expect(
      download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f }),
    ).rejects.toThrow(/200/);
    expect(sink.aborted).toBe(true);
    expect(sink.buf).toEqual(new Uint8Array(total));
  });

  it('Content-Range 与请求区间不符时判为失败', async () => {
    const total = 1024;
    const f = (async () =>
      new Response(new Uint8Array(1024), {
        status: 206,
        headers: { 'content-range': `bytes 999-2022/${total}` },
      })) as unknown as typeof fetch;
    const sink = new MemSink(total);
    await expect(
      download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f }),
    ).rejects.toThrow(/Content-Range/);
  });

  it('返回字节数不足时判为失败', async () => {
    const total = 1024;
    const f = (async () =>
      new Response(new Uint8Array(100), {
        status: 206,
        headers: { 'content-range': `bytes 0-1023/${total}` },
      })) as unknown as typeof fetch;
    const sink = new MemSink(total);
    await expect(
      download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f }),
    ).rejects.toThrow(/字节数不足/);
  });

  it('单镜像失败后由另一镜像补上', async () => {
    const total = 2048;
    const { f } = rangeServer(total, {
      failOn: (_s, _e, prefix) => (prefix === 'https://a.test/' ? 500 : null),
    });
    const sink = new MemSink(total);
    await download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(sink.buf).toEqual(expected(total));
  });

  it('403 时对半拆分块并重试，最终成功', async () => {
    const total = 2048;
    const { f, calls } = rangeServer(total, {
      // 超过 512 字节的 Range 一律 403，拆到 512 及以下才放行
      failOn: (s, e) => (e - s + 1 > 512 ? 403 : null),
    });
    const sink = new MemSink(total);
    await download({
      url: URL_, total, mirrors: MIRRORS, sink, chunkSize: total, fetchFn: f,
      minChunkSize: 256,
    });
    expect(sink.buf).toEqual(expected(total));
    expect(calls.some((c) => c.end - c.start + 1 < total)).toBe(true);
  });

  it('拆分到下限仍持续 403 时抛出而非死循环', async () => {
    const total = 1024;
    const { f } = rangeServer(total, { failOn: () => 403 });
    const sink = new MemSink(total);
    await expect(
      download({
        url: URL_, total, mirrors: MIRRORS, sink, chunkSize: total, fetchFn: f,
        minChunkSize: 256,
      }),
    ).rejects.toThrow(/403/);
    expect(sink.aborted).toBe(true);
  });

  it('全部镜像持续失败时抛错并 abort sink', async () => {
    const total = 1024;
    const f = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const sink = new MemSink(total);
    await expect(
      download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f }),
    ).rejects.toThrow();
    expect(sink.aborted).toBe(true);
  });

  it('报进度：累计字节数单调递增至 total', async () => {
    const total = 4096;
    const { f } = rangeServer(total);
    const sink = new MemSink(total);
    const seen: number[] = [];
    await download({
      url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f,
      onProgress: (done) => seen.push(done),
    });
    expect(seen[seen.length - 1]).toBe(total);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('total 为 0 时直接收尾', async () => {
    const { f } = rangeServer(0);
    const sink = new MemSink(0);
    await download({ url: URL_, total: 0, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f });
    expect(sink.closed).toBe(true);
  });

  it('全部镜像都失败时不再无谓重试（快速失败）', async () => {
    const total = 1024;
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    const sink = new MemSink(total);
    await expect(
      download({ url: URL_, total, mirrors: MIRRORS, sink, chunkSize: 1024, fetchFn: f }),
    ).rejects.toThrow();
    // 2 个镜像 × 每个最多重试 3 次 = 6，允许拆分带来的额外调用但不该失控
    expect(calls).toBeLessThanOrEqual(24);
  });
});

describe('ChunkError', () => {
  it('携带 retryable 标记', () => {
    expect(new ChunkError('x', true).retryable).toBe(true);
    expect(new ChunkError('x', false).retryable).toBe(false);
  });
  it('是 Error 的子类', () => {
    expect(new ChunkError('x', true)).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "D:/github_download++" && npx vitest run tests/engine.test.ts
```

预期：FAIL，报 `Failed to resolve import "../src/engine"`。

- [ ] **Step 3: 写最小实现**

创建 `src/engine.ts`：

```ts
import { plan, splitChunk } from './planner';
import type { Chunk, Mirror, Sink } from './types';

/** 单镜像单块的最大重试次数。 */
export const MAX_SAME_MIRROR_RETRIES = 3;

/** 退避基数（毫秒）。第 n 次重试等待 BASE * 2^n。 */
export const BACKOFF_BASE_MS = 200;

export class ChunkError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ChunkError';
  }
}

export interface DownloadOptions {
  url: string;
  total: number;
  mirrors: Mirror[];
  sink: Sink;
  chunkSize?: number;
  fetchFn?: typeof fetch;
  onProgress?: (bytesDone: number) => void;
  /** 单块持续失败的硬上限，防止病态重试。 */
  maxAttemptsPerChunk?: number;
  /** 403 拆分降级的块大小下限，默认 MIN_CHUNK_SIZE。测试用小值驱动拆分逻辑。 */
  minChunkSize?: number;
}

/** 队列暂空但仍有块未完成时，worker 的轮询间隔。 */
export const SPIN_MS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 抓取单块并写入 sink。
 * 严格校验 206 与 Content-Range：上游忽略 Range 返回 200 时若继续写入，
 * 会把整包内容落到部分文件上，静默产出损坏文件——必须判为失败。
 */
async function fetchChunk(
  mirror: Mirror,
  url: string,
  chunk: Chunk,
  fetchFn: typeof fetch,
  sink: Sink,
  onBytes: (n: number) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(mirror.prefix + url, {
      headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
    });
  } catch (e) {
    throw new ChunkError(`网络错误: ${(e as Error).message}`, true);
  }

  if (res.status === 403) {
    throw new ChunkError(`HTTP 403（疑似大 Range 被拒）`, true);
  }
  if (res.status === 200) {
    throw new ChunkError(
      `HTTP 200：上游忽略了 Range 请求，无法分块下载`,
      false,
    );
  }
  if (res.status !== 206) {
    throw new ChunkError(`HTTP ${res.status}`, res.status >= 500);
  }

  const cr = res.headers.get('content-range');
  const expectPrefix = `bytes ${chunk.start}-${chunk.end}/`;
  if (!cr || !cr.startsWith(expectPrefix)) {
    throw new ChunkError(`Content-Range 不符：期望前缀 "${expectPrefix}"，收到 "${cr}"`, true);
  }

  if (!res.body) throw new ChunkError('响应没有 body', true);

  const reader = res.body.getReader();
  let pos = chunk.start;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      // 串行 await 写入，且读完即写即弃——不累积，内存与文件大小无关。
      await sink.write(pos, value);
      pos += value.byteLength;
      onBytes(value.byteLength);
    }
  }

  if (pos !== chunk.end + 1) {
    throw new ChunkError(`字节数不足：期望 ${chunk.end + 1 - chunk.start} 字节，实收 ${pos - chunk.start} 字节`, true);
  }
}

interface Job {
  chunk: Chunk;
  attempts: number;
}

export async function download(opts: DownloadOptions): Promise<void> {
  const {
    url,
    total,
    mirrors,
    sink,
    chunkSize,
    fetchFn = fetch,
    onProgress,
    maxAttemptsPerChunk = 5,
    minChunkSize,
  } = opts;

  let bytesDone = 0;
  const onBytes = (n: number) => {
    bytesDone += n;
    onProgress?.(bytesDone);
  };

  if (mirrors.length === 0) {
    await sink.abort();
    throw new Error('没有可用镜像');
  }

  // 待办队列。JS 单线程，shift() 天然原子，无需锁。
  const queue: Job[] = plan(total, chunkSize).map((chunk) => ({ chunk, attempts: 0 }));
  /** 尚未成功完成的块数。worker 只在它归零时退出——这是坏镜像不拖垮整体的关键。 */
  let outstanding = queue.length;
  /** 首个不可恢复的错误。一旦置位，所有 worker 尽快退出。 */
  let failure: Error | null = null;

  const worker = async (mirror: Mirror): Promise<void> => {
    while (outstanding > 0 && !failure) {
      const job = queue.shift();
      if (!job) {
        // 队列暂空但仍有块未完成（正被别的 worker 持有），短暂轮询等待。
        await sleep(SPIN_MS);
        continue;
      }

      try {
        await fetchChunk(mirror, url, job.chunk, fetchFn, sink, onBytes);
        outstanding--;
      } catch (e) {
        const err = e instanceof ChunkError ? e : new ChunkError(String(e), true);

        // 不可重试（如上游忽略 Range 返回 200）→ 全局放弃。
        // 此时继续写会产出损坏文件，绝不能容忍。
        if (!err.retryable) {
          failure = err;
          return;
        }

        job.attempts++;

        // 403 优先走「对半拆分」降级：把 Range 缩小再试
        if (/403/.test(err.message)) {
          const halves = splitChunk(job.chunk, minChunkSize);
          if (halves) {
            queue.push({ chunk: halves[0], attempts: 0 }, { chunk: halves[1], attempts: 0 });
            outstanding++; // 一块变两块
            continue;
          }
        }

        if (job.attempts >= maxAttemptsPerChunk) {
          failure = err;
          return;
        }

        // 放回队尾让其他健康镜像接手。本 worker 随即退避，而空闲的对等 worker
        // 每 SPIN_MS 轮询一次队列，因此健康镜像总能先抢到该块。
        queue.push(job);
        await sleep(BACKOFF_BASE_MS * 2 ** (job.attempts - 1));
      }
    }
  };

  try {
    await Promise.all(mirrors.map(worker));
    if (failure) throw failure;
    if (outstanding > 0) throw new Error(`下载未完成，仍有 ${outstanding} 个分块未获取`);
    await sink.close();
  } catch (e) {
    await sink.abort();
    throw e;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd "D:/github_download++" && npx vitest run tests/engine.test.ts
```

预期：16 passed。

- [ ] **Step 5: 提交**

```bash
cd "D:/github_download++" && git add src/engine.ts tests/engine.test.ts && git commit -m "feat: 多镜像 work-stealing 下载调度核心"
```

---

### Task 8: `sink.ts` 落盘实现

**Files:**
- Create: `src/sink.ts`
- Test: `tests/sink.test.ts`

**Interfaces:**
- Consumes: `src/types.ts` 的 `Sink`
- Produces: `createFsaSink(suggestedName: string): Promise<Sink>`、`class UnsupportedBrowserError extends Error`、`supportsFsa(): boolean`

**设计要点：** 本模块只做浏览器 API 的薄封装与能力检测，逻辑极少，故用 mock 的 `window` 测试检测分支，真实写入行为已在 Task 1 spike 中验证。

- [ ] **Step 1: 写失败的测试**

创建 `tests/sink.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { supportsFsa, createFsaSink, UnsupportedBrowserError } from '../src/sink';

describe('supportsFsa', () => {
  it('showSaveFilePicker 与 createWritable 同时存在时为 true', () => {
    const stream = { createWritable: vi.fn() };
    expect(supportsFsa({ showSaveFilePicker: vi.fn(), FileSystemFileHandle: { prototype: stream } } as never)).toBe(true);
  });

  it('showSaveFilePicker 缺失时为 false', () => {
    expect(supportsFsa({} as never)).toBe(false);
  });

  it('仅有 showSaveFilePicker 而 createWritable 缺失时为 false（iOS Firefox 的情况）', () => {
    expect(supportsFsa({ showSaveFilePicker: vi.fn() } as never)).toBe(false);
  });
});

describe('createFsaSink', () => {
  it('不支持时抛 UnsupportedBrowserError', async () => {
    await expect(createFsaSink('a.bin', {} as never)).rejects.toBeInstanceOf(UnsupportedBrowserError);
  });

  it('调用 showSaveFilePicker 并传入 suggestedName', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({ write, close, abort }),
    });
    const win = {
      showSaveFilePicker,
      FileSystemFileHandle: { prototype: { createWritable: vi.fn() } },
    } as never;

    const sink = await createFsaSink('a.bin', win);
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'a.bin' });

    await sink.write(100, new Uint8Array([1, 2, 3]));
    expect(write).toHaveBeenCalledWith({ type: 'write', position: 100, data: new Uint8Array([1, 2, 3]) });

    await sink.close();
    expect(close).toHaveBeenCalled();
  });

  it('createWritable 不得传 keepExistingData', async () => {
    const createWritable = vi.fn().mockResolvedValue({
      write: vi.fn(), close: vi.fn(), abort: vi.fn(),
    });
    const win = {
      showSaveFilePicker: vi.fn().mockResolvedValue({ createWritable }),
      FileSystemFileHandle: { prototype: { createWritable: vi.fn() } },
    } as never;
    await createFsaSink('a.bin', win);
    expect(createWritable).toHaveBeenCalledWith();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "D:/github_download++" && npx vitest run tests/sink.test.ts
```

预期：FAIL，报 `Failed to resolve import "../src/sink"`。

- [ ] **Step 3: 写最小实现**

创建 `src/sink.ts`：

```ts
import type { Sink } from './types';

export class UnsupportedBrowserError extends Error {
  constructor() {
    super('当前浏览器不支持 File System Access API（请使用 Chrome / Edge / Opera）');
    this.name = 'UnsupportedBrowserError';
  }
}

/**
 * 能力检测必须同时检查 createWritable——iOS 上的 Firefox 会暴露
 * showSaveFilePicker 却没有 createWritable。
 */
export function supportsFsa(win: unknown = globalThis): boolean {
  const w = win as Record<string, unknown>;
  if (typeof w.showSaveFilePicker !== 'function') return false;
  const proto = (w.FileSystemFileHandle as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  return typeof proto?.createWritable === 'function';
}

/** 把 FSA 的流包成 Sink。不做任何缓冲——直接透传定位写入。 */
function wrap(stream: {
  write(d: { type: 'write'; position: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}): Sink {
  return {
    write: (position, data) => stream.write({ type: 'write', position, data }),
    close: () => stream.close(),
    abort: async () => {
      await (stream.abort?.() ?? stream.close());
    },
  };
}

export async function createFsaSink(suggestedName: string, win: unknown = globalThis): Promise<Sink> {
  if (!supportsFsa(win)) throw new UnsupportedBrowserError();
  const w = win as {
    showSaveFilePicker(o: { suggestedName: string }): Promise<{
      createWritable(): Promise<Parameters<typeof wrap>[0]>;
    }>;
  };
  const handle = await w.showSaveFilePicker({ suggestedName });
  // 刻意不传 keepExistingData：传 true 会先整份复制现有文件，对大文件是一次完整拷贝。
  const stream = await handle.createWritable();
  return wrap(stream);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd "D:/github_download++" && npx vitest run tests/sink.test.ts
```

预期：6 passed。

- [ ] **Step 5: 全量测试 + 类型检查 + 提交**

```bash
cd "D:/github_download++" && npm run typecheck && npm test && git add src/sink.ts tests/sink.test.ts && git commit -m "feat: FSA 落盘 sink 与浏览器能力检测"
```

---

### Task 9: 界面与端到端串联

**Files:**
- Create: `index.html`
- Create: `src/main.ts`
- Create: `src/ui.ts`

**Interfaces:**
- Consumes: `resolver.parseReleaseUrl` / `resolveMetadata`、`mirrors.MirrorPool`、`probe.probeMirrors`、`engine.download`、`sink.createFsaSink` / `supportsFsa`
- Produces: 可用的单页应用

- [ ] **Step 1: 写页面骨架**

创建 `index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub Release 加速下载</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 780px; margin: 40px auto; padding: 0 20px; }
  input[type=url] { width: 100%; padding: 10px; font-size: 14px; box-sizing: border-box; }
  button { padding: 10px 22px; font-size: 15px; cursor: pointer; }
  button:disabled { cursor: not-allowed; opacity: .5; }
  #bar { height: 22px; background: #8883; border-radius: 4px; overflow: hidden; margin: 14px 0 6px; }
  #fill { height: 100%; width: 0; background: #3b82f6; transition: width .15s; }
  #stats { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 14px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #8883; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  #log { font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; color: #888; max-height: 190px; overflow: auto; }
  .err { color: #dc2626; }
  #warn { padding: 10px; border: 1px solid #f59e0b; border-radius: 4px; margin-bottom: 14px; display: none; }
</style>
</head>
<body>
  <h1>GitHub Release 加速下载</h1>
  <div id="warn"></div>
  <p><input type="url" id="url" placeholder="https://github.com/owner/repo/releases/download/tag/file.exe" autocomplete="off"></p>
  <p><button id="go">开始下载</button> <span id="hint"></span></p>
  <div id="bar"><div id="fill"></div></div>
  <div id="stats"><span id="pct">—</span><span id="spd"></span><span id="eta"></span></div>
  <div id="mirrors"></div>
  <div id="log"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

- [ ] **Step 2: 写视图辅助**

创建 `src/ui.ts`：

```ts
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
        `<td class="num">${r.ttfbMs} ms</td></tr>`,
    )
    .join('');
  els.mirrors.innerHTML =
    `<table><thead><tr><th>镜像</th><th>状态</th><th class="num">吞吐</th><th class="num">首字节</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function setBusy(busy: boolean): void {
  els.go.disabled = busy;
  els.go.textContent = busy ? '下载中…' : '开始下载';
}
```

- [ ] **Step 3: 串联主流程**

创建 `src/main.ts`：

```ts
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
  const usable = probes.filter((p) => p.ok).map((p) => p.mirror);
  if (usable.length === 0) throw new Error('全部镜像均不可用，请稍后重试');

  const best = usable[0];
  const meta = await resolveMetadata(raw, best.prefix);
  ui.log(`文件 ${meta.filename}  大小 ${ui.fmtBytes(meta.total)}`);

  let sink: Sink;
  if (supportsFsa()) {
    sink = await createFsaSink(meta.filename);
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
```

- [ ] **Step 4: 构建与类型检查**

```bash
cd "D:/github_download++" && npm run typecheck && npm run build
```

预期：typecheck 无错，`dist/` 生成。

- [ ] **Step 5: 真实端到端验证**

先用一个**小文件**做快速冒烟（迭代快、不浪费带宽），再用大文件做验收。

小文件：任选一个已知的、体积 < 5 MB 的 GitHub Release 资产链接。
**本计划不提供具体小文件 URL，因为我未验证过任何一个仍然有效**——请自行从任意仓库的 Releases 页面取一个。
下载完成后用 `certutil -hashfile <文件> SHA256` 与页面显示的大小核对。

```bash
cd "D:/github_download++" && npm run dev
```

浏览器打开 Vite 提示的地址，粘贴验收链接：

```
https://github.com/babalae/better-genshin-impact/releases/download/0.65.0/BetterGI.Install.0.65.0.exe
```

预期：镜像面板显示 4 个镜像状态与吞吐 → 保存对话框弹出 → 进度条推进、速度与 ETA 更新 → 完成后文件大小精确等于 `499558899` 字节。

校验：

```bash
certutil -hashfile "下载到的文件" SHA256
```

与 Task 1 spike 得到的哈希比对，必须一致。

- [ ] **Step 6: 提交**

```bash
cd "D:/github_download++" && git add -A && git commit -m "feat: 单页界面与端到端串联"
```

---

### Task 10: 部署到 GitHub Pages

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `vite.config.ts`（增加 `base`）

**Interfaces:**
- Consumes: Task 9 产出的 `dist/`
- Produces: 一个可访问的线上地址

**注意：** GitHub Pages 是 HTTPS，`showSaveFilePicker` 需要安全上下文，Pages 满足。仓库必须是 Public，或账号有 Pages 私有仓库权限。

- [ ] **Step 1: 配置 base 路径**

修改 `vite.config.ts`，加入 `base`。仓库名已定：**`github-download-accelerator`**（原目录名 `github_download++` 含 `+`，GitHub 仓库名不允许该字符）：

```ts
// 同 Task 2：从 'vitest/config' 引入，否则 `test` 键失去类型检查。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  base: '/github-download-accelerator/',
  build: { outDir: 'dist' },
  test: { globals: true, environment: 'node' },
});
```

- [ ] **Step 2: 写部署工作流**

创建 `.github/workflows/deploy.yml`：

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 3: 提交并推送**

```bash
cd "D:/github_download++" && git add -A && git commit -m "ci: GitHub Pages 自动部署"
```

推送：

```bash
cd "D:/github_download++" && git push -u origin main
```

> **当前状态：用户决定暂不推送到 GitHub，仓库仅存在于本地。** 目标仓库名为
> `github-download-accelerator`（Public），但**尚未创建**。执行到本步骤时先向用户确认是否建仓，
> 不要擅自创建远程仓库或推送。
> 届时建仓方式：用户在 github.com 新建空仓库（不勾 README），把 URL 交给执行者，
> 执行者再 `git remote add origin <URL>` 并 push（首次 push 会弹 Git Credential Manager 登录）。

- [ ] **Step 4: 在仓库设置中启用 Pages**

用户需手动操作：仓库 → Settings → Pages → Source 选 **GitHub Actions**。

- [ ] **Step 5: 验证线上可用**

等 Actions 跑完，打开 `https://zhuiluo.github.io/github-download-accelerator/`，用 Task 9 的同一条链接重跑一次，确认功能与本地一致。

---

## 附录：验收清单

- [ ] `npm run typecheck` 无错
- [ ] `npm test` 全绿（预计 60 个用例）
- [ ] Task 1 spike 通过（架构闸门）
- [ ] 499558899 字节文件下载完成，大小精确匹配，SHA-256 与参照一致
- [ ] 速度显著优于 0.06 MB/s 直连基线
- [ ] 镜像面板正确显示 4 个镜像的状态
- [ ] 手动让某镜像失败，验证 work-stealing 与降级生效
- [ ] Firefox 下显示单连接回退提示且不崩溃
- [ ] 线上 Pages 地址可用
