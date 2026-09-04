/**
 * LivePilot 首页入口，只渲染 Channel-scoped Portable OBS 控制台。
 */
import { ControlPlaneConsole } from '@/components/control-plane-console'

/** 返回浏览器端直播控制台。 */
export default function HomePage() {
  return <ControlPlaneConsole />
}
