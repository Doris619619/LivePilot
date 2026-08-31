/**
 * LivePilot 首页入口，只渲染单账号 YouTube Live 控制台。
 */
import { LiveConsole } from '@/components/live-console'

/** 返回浏览器端直播控制台。 */
export default function HomePage() {
  return <LiveConsole />
}
