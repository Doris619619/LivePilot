/**
 * LivePilot 首页入口，只渲染多账号 Channel/Job/Run 控制台。
 */
import { ControlPlaneConsole } from '@/components/control-plane-console'

/** 返回浏览器端多账号直播控制台。 */
export default function HomePage() {
  return <ControlPlaneConsole />
}
