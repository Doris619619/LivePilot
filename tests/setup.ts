/**
 * Vitest 全局初始化：在 Node 测试环境中把 Next.js 的 server-only 标记替换为空模块。
 */
import { vi } from 'vitest'

/** 允许服务端模块在单元测试中加载，同时不削弱生产构建的 server-only 约束。 */
vi.mock('server-only', () => ({}))
