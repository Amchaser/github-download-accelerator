// 必须从 'vitest/config' 引入 defineConfig，不能从 'vite'：
// vite 的 UserConfig 类型不认识 `test` 键，从 'vite' 引入会让该键失去类型检查。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  // GitHub Pages 的项目站点挂在 /<仓库名>/ 子路径下，不是域名根。
  // 缺了这一行，构建出的 index.html 会去根路径找资源 → 线上白屏（本地 dev 一切正常，
  // 所以这个坑只在部署后才现形）。
  base: '/github-download-accelerator/',
  build: { outDir: 'dist' },
  test: {
    globals: true,
    environment: 'node',
    // 一旦显式指定 exclude，vitest 的默认值就被整体替换，必须自己带上 node_modules / dist。
    // 加 .superpowers 是因为 vitest 的默认 include 是 **/*.test.ts，它**不看 .gitignore**——
    // 放在忽略目录里的临时验证测试文件会被一起收集，静默膨胀套件并让「预期 N passed」核对失效。
    exclude: ['**/node_modules/**', '**/dist/**', '**/.superpowers/**'],
    // 单测上限 15s（默认 5s）：引擎里走真实退避重试的用例在慢机器或 CI 上会接近 5s，
    // 留出余量，免得「超时失败」被误读成「断言失败」。
    testTimeout: 15_000,
  },
});
