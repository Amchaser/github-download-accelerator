// 必须从 'vitest/config' 引入 defineConfig，不能从 'vite'：
// vite 的 UserConfig 类型不认识 `test` 键，从 'vite' 引入会让该键失去类型检查。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  build: { outDir: 'dist' },
  test: { globals: true, environment: 'node' },
});
