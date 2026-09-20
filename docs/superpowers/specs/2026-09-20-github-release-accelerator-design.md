# GitHub Release 加速下载器 — 设计文档

日期：2026-09-20
形态：纯前端单页 Web 应用（零后端、零安装）
状态：设计已确认，待实现

---

## 1. 问题

从中国大陆下载 GitHub Release 资产极慢。实测本机直连下载
`babalae/better-genshin-impact` 的 `BetterGI.Install.0.65.0.exe`（499,558,899 字节）：

| 路径 | 吞吐 | 该文件耗时 |
|---|---|---|
| 直连 GitHub | **0.06 MB/s** | ≈ 2.3 小时 |
| 直连 + Watt Toolkit 加速（1 连接） | 0.06 MB/s | ≈ 2.3 小时 |
| 直连 + Watt Toolkit 强制走代理 | **1.5 KB/s** | 不可用 |
| Watt Toolkit × 8 连接 | **0.04 MB/s** | ≈ 3.5 小时 |
| gh.xmly.dev × 1 连接 | 3.80 MB/s | ≈ 2.2 分钟 |
| gh.xmly.dev × 32 连接（curl） | **32.34 MB/s** | ≈ 15 秒 |

结论：**加速来源是「镜像 + 并行」，不是 Watt Toolkit。**

### 1.1 关于 Watt Toolkit 的实测结论（明确排除）

本机 `Steam++.Accelerator.exe`（PID 7748）监听 `0.0.0.0:80` 与 `0.0.0.0:443`，
以 hosts 模式把 73 个域名重定向到 `127.0.0.1` 做本地 MITM 反代。

**它对本下载场景无效，原因有三，均已实测：**

1. **关键域名缺失**：GitHub 现在从 `release-assets.githubusercontent.com` 提供
   Release 资产，而该域名**不在** Watt Toolkit 的 hosts 白名单里（白名单里只有
   已过时的 `objects.githubusercontent.com`）。因此只有 302 跳转被加速，
   **499 MB 的实际载荷走直连**。
2. **强制走代理也是死路**：用 `--resolve` 把该域名强行指到 `127.0.0.1`，
   实测 200 但仅 **1551 B/s**；开 8 连接也只有 0.04 MB/s。
3. **证书信任库冲突**：MITM 要求客户端信任其自签 CA。`curl` / Python `requests`
   （certifi） / aria2c（Windows 构建）都**自带 CA bundle、不读 Windows 证书存储**，
   在 hosts 模式下会直接 TLS 失败（实测 `curl` 退出码 35）。浏览器与 .NET 走
   Windows 证书存储，不受影响。

**决策：不依赖 Watt Toolkit。** 它既没有更快，也没有更简单，且无第三人可编程接口。
「不依赖第三方」的目标通过镜像方案 + 可选自建 Worker 达成。

### 1.2 一个反向收获

上述第 3 点对技术选型有正面意义：**浏览器天然信任 Windows 证书存储**，
所以纯网页方案在证书层面零配置、零坑。

---

## 2. 镜像可用性实测（2026-09-20 本机）

对 30 个公共 GitHub 代理站逐一发 `Range: bytes=0-131071` + `Origin` 头探测。

### 2.1 浏览器可用（Range + CORS 同时具备）

| 镜像 | 206 | Content-Range | `Access-Control-Allow-Origin` |
|---|---|---|---|
| `gh.xmly.dev` | ✓ | ✓ | `*` |
| `gh.xxooo.cf` | ✓ | ✓ | `*` |
| `gh.ddlc.top` | ✓ | ✓ | `*` |
| `gh.monlor.com` | ✓ | ✓ | `*` |

`gh.xmly.dev` 与 `gh.xxooo.cf` 另实测通过 OPTIONS 预检（`204`，
`access-control-max-age: 1728000`）并发送 `access-control-expose-headers: *`。
**后者是关键**：没有它，JS 读不到 `Content-Length` / `Content-Range`，无法分块。

### 2.2 有 Range 但无 CORS（浏览器不可用）

`gh-proxy.com`、`ghproxy.net`、`v6.gh-proxy.org`、`gh.noki.icu`、`github.akams.cn`

> 注：`gh-proxy.com` 实测单连接可达 22 MB/s，是全场最快，但**因为没有 CORS 头，
> 浏览器一个字节都取不到**。这是纯网页方案最痛的取舍。

### 2.3 其余 20+ 个

失效、403（`ghfast.top`、`gh.h233.eu.org`）或超时不可达。

### 2.4 `Range` 长请求的坑

aria2 issue #1627 记录有服务器**只允许 ≤20 MB 的 Range，超出直接 403**。
故默认分块取保守值，并必须有降级路径。

---

## 3. 目标与非目标

**目标**
- 粘贴 GitHub Release 链接 → 选择保存位置 → 高速下载完成
- 自动测速优选镜像，自动分块并行，自动重试与降级
- 实时显示进度、速度、ETA
- 零安装、零后端、零第三方账号

**明确不做（YAGNI）**
- 下载队列 / 多任务并发（未来可加）
- 断点续传（纯网页下关页即丢，做不了）
- GitHub 仓库页解析、批量勾选
- 下载历史、速度图表
- 依赖 Watt Toolkit 或任何本地代理

**已知能力边界（不粉饰）**
- 仅 Chromium 内核（Chrome / Edge / Opera）。Firefox 与 Safari 不实现
  `showSaveFilePicker`，必须走 `<a download>` 回退（回退路径无并行、无进度）。
- 下载期间标签页必须保持打开。
- 并行度受限于 4 个可用 origin，预计 **5–15 MB/s**，非 32 MB/s。

---

## 4. 架构

```
                    ┌──────────────┐
   粘贴 URL ───────► │  resolver    │ 解析 owner/repo/tag/file
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │  probe       │ 4 镜像并行发 512 KB 探针，测吞吐，排序
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │  HEAD 解析   │ Content-Length + Accept-Ranges
                    └──────┬───────┘
                           ▼
   FSA 选保存位置 ─────────┤
                           ▼
                    ┌──────────────┐
                    │  planner     │ 分块（默认 8 MB）
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐
                    │  engine      │ 每 origin 一个循环，work-stealing 抢块
                    └──────┬───────┘  重试 / 退避 / 换镜像 / 降级
                           ▼
                    ┌──────────────┐
                    │  sink        │ write({type:'write', position})
                    └──────┬───────┘
                           ▼
                      校验总字节数 → 完成
```

**核心洞察：并行度来自 origin 数，不是分块数。**
HTTP/2 下浏览器对同一 host 只开一条 TCP 连接，所有 Range 流共享同一拥塞窗口，
所以对单镜像开 32 块**不会**得到 32 倍带宽。分块必须**跨 origin 分散**。
（这与朴素的「多线程下载」直觉相反，是本设计最反直觉的一点。）

---

## 5. 模块设计

每个模块单一职责、可独立测试。

### `mirrors.js` — 镜像注册表
- 硬编码 4 个可用镜像及其前缀模板
- 记录运行时健康度：成功/失败次数、最近吞吐、最近失败时间
- 提供 `rankedMirrors()`：按健康度排序

### `probe.js` — 测速优选
- 对每个镜像发 `Range: bytes=0-524287`（512 KB）探针
- 记录**到首字节时间**与**吞吐**，据此排序
- 超时 3s 判为不可用，从本轮排除
- 输出：可用镜像列表 + 排序

### `resolver.js` — URL 解析与元数据
- 正则解析 `https://github.com/{owner}/{repo}/releases/download/{tag}/{file}`
- 取文件名（优先用 `Content-Disposition` 的 `filename=`，回退 URL 末段）
- `HEAD` 取 `Content-Length`；`Accept-Ranges: bytes` **仅作参考，不当作保证**

### `planner.js` — 分块规划
- 块大小默认 8 MB（避开长 Range 被 403 的风险），可配置
- 块数 = `ceil(total / chunkSize)`
- 输出区间列表 `[{index, start, end}]`

### `engine.js` — 调度核心
- 每个可用 origin 起一个异步循环，从共享队列 **work-stealing** 取块
- 每块流程：
  1. `fetch(mirrorPrefix + originalUrl, {headers:{Range: 'bytes=a-b'}})`
  2. **校验 `status === 206` 且 `Content-Range` 与请求区间一致**，否则丢弃重试
  3. `reader.read()` 流式循环，256 KB 粒度交给 sink
**降级阶梯（严格按顺序，逐级上升）**

单块失败时：
1. 同镜像指数退避重试，最多 3 次
2. 换其他镜像重试（该镜像标记为不健康，降权）
3. 若失败原因是 `403`（疑似大 Range 被拒）→ **全局**将块大小减半，重新规划剩余未完成区间后继续
4. 块大小已降到下限（1 MB）仍失败 → 转为**单连接顺序下载剩余区间**

全局失败（`resolver` / `HEAD` 阶段即发现）：
- 若 `HEAD` 显示无 `Accept-Ranges` 或首个 Range 请求返回 `200` →
  **不做分块**，整个文件走单连接下载（仍有镜像加速，但无并行）

终止条件：所有镜像、所有块大小、单连接路径全部失败 → 中止并显示明确错误原因。
纯网页无法保留部分文件，用户需重新开始。

**内存约束**：并发块数 = 可用 origin 数（4），每块在途缓冲上限 256 KB，
故在途内存峰值 ≈ 4 × 256 KB ≈ 1 MB，与文件大小无关。

### `sink.js` — 写入
- 主路径：`showSaveFilePicker()` → `createWritable()` → `write({type:'write', position, data})`
- **必须 feature-detect `createWritable`，而非只检测 `showSaveFilePicker`**
  （iOS 上的 Firefox 会暴露前者却无后者）
- 回退路径：`<a download>`（无并行、无进度，仅保可用性）

### `ui.js` — 界面
单页：输入框 → 镜像面板（实时吞吐）→ 保存按钮 → 进度条 / 速度 / ETA → 日志区

---

## 6. 必须遵守的实现约束

1. **永远通过原始 GitHub URL 请求**，让镜像每次重新 follow 302。
   302 落点是**限时签名 URL**（Azure/S3），缓存它必然过期。
2. **绝不 `await response.blob()` / `arrayBuffer()`**。必须 `reader.read()` 流式，
   即读即写即弃。否则 4 × 8 MB 并发直接爆内存。
3. **`206` 校验不可省**。上游若忽略 Range 返回 `200`，把整包追加到部分文件上
   会静默产出损坏文件——这是最危险的失败模式。
4. **写入必须 `await` 串行化**。下载并行，落盘串行（写流有锁，并发写无意义且危险）。
5. **`createWritable()` 的 `keepExistingData` 保持 `false`**（默认）。
   设 `true` 会先整份复制现有文件，对大文件是一次完整拷贝。

---

## 7. 测试策略

| 层级 | 内容 |
|---|---|
| 单元 | `resolver` URL 解析（含畸形输入）；`planner` 分块边界（整除/余数/单块） |
| 单元 | `engine` 的 `206` 校验逻辑：伪造 `200`、伪造错误 `Content-Range` 必须被判失败 |
| 集成 | 真实小文件（< 5 MB）端到端下载，比对 SHA-256 |
| 集成 | 故意让一个镜像失败，验证 work-stealing 与降级是否生效 |
| 手工 | 499 MB 真实文件，校验字节数与 SHA-256，观察内存曲线 |

**每个镜像探测结果与下载吞吐必须记录**，用于持续更新 `mirrors.js` 的可用性。

---

## 8. 风险

| 风险 | 等级 | 应对 |
|---|---|---|
| **FSA 并行定位写入的可靠性未经验证** | **高** | **先做 spike，见第 9 节** |
| 4 个公共镜像随时可能失效 | 中 | 健康度记录 + 快速探测；文档给自建 Worker 指引 |
| 上游不支持 Range | 中 | 检测到 `200` 即降级单连接 |
| 大 Range 被 403 | 中 | 缩小块重试 |
| 内存膨胀 | 中 | 256 KB 粒度流式写入 |

---

## 9. 第一步：FSA spike（动手前必须通过）

Chrome 的 `write({type:'write', position})` 能否可靠地对同一
`FileSystemWritableFileStream` 做**并行定位写入**，规范允许，
但**调研未找到任何先例项目验证过**——所有认真做多线程的浏览器下载产品
（Vortex、Surge、downloader 扩展等）都配了原生 helper 来绕开浏览器限制。

> WICG/file-system-access issue #67 曾提议 `"inPlace"` 模式（直接改底层文件），
> **Chrome 未实现**。规范明确：stream close 之前磁盘上的真实文件不变，
> 实现通常写临时文件、close 时原子替换。

**spike 内容（约 30 行，半小时）**
1 GB 文件、4 路并行 Range、`write({position})` 直写同一 handle
→ 观察内存曲线 + 最终文件 SHA-256。

**判定**
- 通过 → 按本设计继续
- 不通过 → 改用替代方案：分片落 IndexedDB / 内存后按序组装，或改为顺序写入

**这一步先于任何其他实现工作。**

---

## 10. 参考项目

| 项目 | 价值 |
|---|---|
| `cn-fast-dl` (npm) | 自动测速选最快代理 + N 路并行 Range 分块合并，默认 16 连接，Range 不支持时自动降级。**与本方案思路最接近，实现前先读源码** |
| `justget` (npm) | 多源竞速分块：主站 + 多镜像同时下，谁快用谁；断点续传；多哈希校验 |
| `hx-cdn-forge` (npm) | 多 CDN 并行 + IDM 式跨节点 Range 分段 + 多 CDN 竞速 |
| `hunshcn/gh-proxy` | 反代 Worker 参考实现，无条件发 `ACAO: *`；**自建 Worker 时基于它改** |
| `aria2` | 多连接 Range 分块的经典参考实现（两级 piece/segment 模型、`.aria2` 控制文件、`If-Range` 校验器） |
