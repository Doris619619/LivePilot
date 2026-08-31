/**
 * LivePilot 的 ESLint flat config，启用 Next.js Core Web Vitals 与 TypeScript 规则。
 */
import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    '.next/**',
    'coverage/**',
    'node_modules/**',
    '.upstream-stream-manager/**',
    '.tools/**',
  ]),
])
