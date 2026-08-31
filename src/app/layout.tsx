/**
 * LivePilot App Router 的根布局，设置页面元数据、语言和全局样式。
 */
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'LivePilot · YouTube Live Control',
  description: 'Single-account YouTube Live control console',
}

/** 将所有 LivePilot 页面装入唯一的中文文档外壳。 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
