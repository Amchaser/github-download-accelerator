#!/usr/bin/env node
/**
 * 镜像体检：用**与应用完全相同的判据**测一批 GitHub 代理候选。
 *
 * 判定标准直接对齐 `src/probe.ts`，而不是另立一套：
 *   - 请求 `Range: bytes=0-${PROBE_BYTES - 1}`（512 KiB）
 *   - 超时 3 秒（`PROBE_TIMEOUT_MS`）——**拉不完就算不可用**
 *   - 返回 206 且 Content-Range 前缀正确
 *   - 带 CORS 头（`Access-Control-Allow-Origin`）
 *
 * 为什么必须对齐：先前这脚本用「8 秒拉 1 KiB」，会把 TTFB 6 秒的镜像判为合格——
 * 而应用探针 3 秒就把它踢了。**判据不一致的体检报告比没有更糟**：它给你一个
 * 应用根本不会用的白名单，而你以为问题已经修好了。
 *
 * 为什么需要它：公共镜像是别人的免费服务，**会持续烂掉**，且延迟在几分钟内剧烈波动
 * （实测同一个镜像 918ms → 6313ms → 超时）。本脚本让「发现挂了 → 换一个」变成一条命令。
 *
 * ⚠️ **吞吐数字的已知偏差**：本脚本用 Node 的 `fetch`，它默认走 **HTTP/1.1**；
 * 浏览器走 **HTTP/2**（同一 origin 一条连接多路复用）。所以**吞吐只可作参考**，
 * 不能直接当作浏览器里的表现。可达性、CORS、Range 支持这三项判定是可靠的。
 *
 * 用法：
 *   npm run mirrors                                         # 推荐入口（已带好下面那个 flag）
 *   node --use-system-ca scripts/check-mirrors.mjs          # 等价的手写形式
 *   node ... --timeout 10000                                # 放宽超时（诊断「是死了还是只是慢」）
 *   node ... https://a/ https://b/                          # 只测给定的
 *   node ... --json
 *
 * ⚠️ **必须带 `--use-system-ca`**（npm script 已内置）。本机装了 Watt Toolkit，
 * 它以 hosts 模式做 MITM，其自签 CA 只进 Windows 证书存储；Node 默认只信自带的
 * Mozilla CA 集合，**不读系统存储**——不带这个 flag 会出现 `fetch failed`，
 * 而报告里**看起来像镜像全挂了**。实测：带 flag 连跑 4 次 0 次 fetch failed，
 * 不带时出现过。这项噪声会直接毁掉本脚本的结论，故强制内置。
 *
 * 退出码恒为 0：这是**报告**，不是测试。镜像挂掉是常态，不是失败。
 */

// ── 与应用对齐的判据（改动前请先看 src/probe.ts）────────────────────────
const PROBE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 3000;

// ── 候选池 ────────────────────────────────────────────────────────────────
// 前缀用法是 `prefix + 原始 GitHub URL`，故结尾必须带 `/`。加候选直接加一行。
const CANDIDATES = [
  // 当前白名单（src/mirrors.ts）
  'https://gh.xmly.dev/',
  'https://gh.xxooo.cf/',
  'https://gh.ddlc.top/',
  'https://gh.monlor.com/',
  // 历史上有 Range 但**缺 CORS**，留着以便哪天补上能被自动发现
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://v6.gh-proxy.org/',
  'https://gh.noki.icu/',
  'https://github.akams.cn/',
  'https://ghfast.top/',
  'https://gh.h233.eu.org/',
];

// 探测目标：任何**稳定存在**的公开 Release 文件都行。必须 ≥ 512 KiB，否则取不满。
const TARGET =
  process.env.MIRROR_TEST_URL ??
  'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip';

// 镜像要放行**跨域**读取，这个头是必须的（浏览器页面的 Origin）。
const ORIGIN = 'https://amchaser.github.io';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const tIdx = args.indexOf('--timeout');
const timeoutMs = tIdx >= 0 ? Number(args[tIdx + 1]) || DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
const custom = args.filter((a, i) => !a.startsWith('--') && i !== tIdx + 1);
const pool = custom.length ? custom : CANDIDATES;

const normalize = (u) => (u.endsWith('/') ? u : u + '/');

/** 体检单个候选。判据与应用探针一致。 */
async function check(prefix) {
  const base = normalize(prefix);
  const url = base + TARGET;
  const out = { prefix: base, ok: false, reason: '' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}`, Origin: ORIGIN },
      signal: ac.signal,
    });

    const cors = res.headers.get('access-control-allow-origin');
    const cr = res.headers.get('content-range');
    const wantPrefix = `bytes 0-${PROBE_BYTES - 1}/`;

    // 先判头部：这些不合格时不必读 body，且能给出比「超时」更准确的归因。
    if (res.status === 404) { out.reason = '404（代理不认这条 URL）'; await res.body?.cancel().catch(() => {}); return out; }
    if (res.status !== 206) { out.reason = `HTTP ${res.status}（非 206，无法分块）`; await res.body?.cancel().catch(() => {}); return out; }
    if (!cr || !cr.startsWith(wantPrefix)) {
      out.reason = `Content-Range 不符：期望前缀 "${wantPrefix}"，收到 "${cr ?? '(无)'}"`;
      await res.body?.cancel().catch(() => {}); return out;
    }
    if (!cors) {
      out.reason = '**缺 CORS 头** ⇒ 浏览器读不到任何字节（速度再快也没用）';
      await res.body?.cancel().catch(() => {}); return out;
    }

    // 头部合格 → 必须**真的把 512 KiB 拉完**，与应用探针一致。
    if (!res.body) { out.reason = '响应没有 body'; return out; }
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) got += value.byteLength;
    }
    const elapsedMs = Date.now() - t0;

    if (got < PROBE_BYTES) { out.reason = `字节数不足：期望 ${PROBE_BYTES}，实收 ${got}`; return out; }

    out.ok = true;
    out.elapsedMs = elapsedMs;
    out.bytesPerSec = got / (Math.max(elapsedMs, 1) / 1000);
    out.total = Number(cr.split('/')[1]) || null;
    return out;
  } catch (e) {
    out.reason = e.name === 'AbortError'
      ? `超时 >${timeoutMs}ms（未拉完 ${PROBE_BYTES / 1024} KiB）`
      : `请求失败: ${e.message}`;
    return out;
  } finally {
    clearTimeout(timer);
  }
}

const mb = (bps) => (bps / 1024 / 1024).toFixed(2) + ' MB/s';

const results = await Promise.all(pool.map(check));
const ok = results.filter((r) => r.ok).sort((a, b) => b.bytesPerSec - a.bytesPerSec);
const bad = results.filter((r) => !r.ok);

if (asJson) {
  console.log(JSON.stringify({ target: TARGET, timeoutMs, probeBytes: PROBE_BYTES, ok, bad }, null, 2));
} else {
  console.log(`探测目标   ${TARGET}`);
  console.log(`判据       Range ${PROBE_BYTES / 1024} KiB + CORS，超时 ${timeoutMs}ms（与应用 probe.ts 一致）`);
  console.log(`⚠️  吞吐仅供参考：Node 走 HTTP/1.1，浏览器走 HTTP/2\n`);

  console.log(`=== 合格 ${ok.length} / ${results.length} ===`);
  if (!ok.length) console.log('  （一个都没有——这就是应用此刻会报「全部镜像均不可用」的原因）');
  for (const r of ok) {
    console.log(`  ✓ ${r.prefix.padEnd(30)} ${String(r.elapsedMs).padStart(6)}ms  ${mb(r.bytesPerSec)}`);
  }

  console.log(`\n=== 不合格 ${bad.length} ===`);
  for (const r of bad) console.log(`  ✗ ${r.prefix.padEnd(30)} ${r.reason}`);

  if (ok.length) {
    console.log('\n=== 可直接粘进 src/mirrors.ts（按实测吞吐降序）===');
    for (const r of ok) {
      console.log(`  { id: '${new URL(r.prefix).hostname}', prefix: '${r.prefix}' },`);
    }
  }
}
