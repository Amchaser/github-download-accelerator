# GitHub Release 加速下载

粘贴一条 GitHub Release 的下载链接，用 4 个公共镜像**并行分块**把它拉下来。

## 直接用

**https://amchaser.github.io/github-download-accelerator/**

打开就能用——零安装、零后端、零账号。建议用 **Chrome / Edge / Opera**（原因见下方「已知边界」）。

## 怎么用

1. 在 GitHub Release 页面右键某个资产 → 「复制链接地址」
2. 粘进输入框，点「开始下载」
3. 选保存位置
4. 等。页面会实时显示每个镜像的实测速度、总进度和 ETA

> **目标文件在下载完成前会一直显示 0 字节。** 这是浏览器 File System Access API 的机制：
> 内容先写临时文件，`close()` 时才原子替换到目标路径。不是卡住了。

## 它为什么快

并行度来自**镜像数量**，不是分块数量。

HTTP/2 下浏览器对同一个域名只开一条 TCP 连接，所有 Range 流共享同一个拥塞窗口——所以对**单个**镜像开 32 个分块**不会**得到 32 倍带宽。分块必须**跨镜像分散**。这是本项目最反直觉的一点，也是全部设计的出发点。

## 已知边界（不粉饰）

- **只有 Chromium 内核（Chrome / Edge / Opera）有并行加速。** Firefox 与 Safari 不实现 File System Access API，会退到单连接 `<a download>` 路径：能下，但没有并行、也没有进度显示。
- **4 个公共镜像是别人的免费服务，随时可能失效。** 失效了就改 `src/mirrors.ts` 里的白名单并重推——Pages 会自动重新部署。
- **下载期间标签页必须保持打开。** 关掉就全部作废：FSA 路径下磁盘上连半成品都没有。
- 镜像在中国大陆通常好用，在海外不一定；反过来也一样。

## 镜像失效了怎么办

公共镜像是别人的免费服务，**会持续烂掉**，而且延迟在几分钟内就剧烈波动（实测同一个镜像 **918ms → 6313ms → 超时**）。检测和替换是一条命令：

```bash
npm run mirrors
```

它用**与应用探针完全相同的判据**（Range 512 KiB + 3 秒超时 + 必须带 CORS 头）测一遍候选池，列出合格的，并直接打印**可粘进 `src/mirrors.ts`** 的代码行。把挂掉的换掉、重推即可，Pages 会自动重新部署。

> ⚠️ **必须带 `--use-system-ca`**（`npm run mirrors` 已内置）。本机装了 Watt Toolkit 做 MITM，它只把自签 CA 装进 Windows 证书存储，而 **Node 默认只信自带的 Mozilla CA 集合、不读系统存储**。不带这个 flag 会出现 `fetch failed`，报告**看起来像所有镜像都挂了**——那是假象。

## 本机开发

```bash
npm install
npm run dev        # 起开发服务器
npm test           # 84 个用例
npm run typecheck
npm run build
```

需要 **Node 22 或 24**。`vitest@5` 的 `engines` 是 `^22.12.0 || ^24.0.0 || >=26.0.0`——Node 20 会让测试直接跑不起来。

## 设计文档与实现计划

- **设计文档**（含实测数据、镜像可用性实测、为什么排除 Watt Toolkit）：`docs/superpowers/specs/`
- **实现计划**（任务分解）：`docs/superpowers/plans/`

## 自建镜像

白名单是硬编码的，只收**同时具备 `Range` 与 CORS 响应头**的代理。想换成自己的反代，可参考 [`hunshcn/gh-proxy`](https://github.com/hunshcn/gh-proxy)——它无条件发 `Access-Control-Allow-Origin: *`。

**关键取舍**：没有 CORS 头的镜像，浏览器**一个字节都取不到**。实测 `gh-proxy.com` 单连接能跑 22 MB/s，是全场最快，但正因为缺 CORS 头而完全用不了。这是纯前端方案最痛的地方。
