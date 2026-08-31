/**
 * LivePilot 服务端单元测试配置，统一路径别名、Node 环境和全局测试初始化。
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
    setupFiles: ['tests/setup.ts'],
  },
})
