/**
 * 警车拦截系统：追上玩家后从"跟随"升级为"主动拦截"。
 *
 * 职责：
 * - 玩家驾驶时，为进入拦截距离的警车计算前置拦截点（沿玩家速度方向前导），
 *   让警车超车到玩家前方阻挡，而不是一直跟在车尾。
 * - 偶数 slot 车负责前置拦截，奇数 slot 车继续直接追击（多车多方向）。
 * - 3 星以上的包围方位偏移仍由 PoliceManager 负责，本系统只提供前导目标。
 *
 * 所有目标都走道路 BFS 寻路，警车不允许瞬移或直穿建筑。
 */
import { ARREST } from '../config';
import type { Police } from '../entities/Police';

export interface InterceptSnapshot {
  playerX: number;
  playerY: number;
  playerVX: number;
  playerVY: number;
  playerSpeed: number;
  inVehicle: boolean;
}

export class PoliceInterceptionSystem {
  /** 各警车当前的前置拦截目标（世界坐标），null 表示不拦截直接追 */
  private goals = new Map<Police, { x: number; y: number } | null>();

  /**
   * 为一辆 CHASE 警车计算导航目标：
   * - 玩家驾驶且在拦截距离内：偶数 slot 前置阻挡，奇数 slot 尾随逼近
   * - 其他情况返回 null（由 PoliceManager 使用默认追捕目标）
   */
  goalFor(p: Police, snap: InterceptSnapshot, distToPlayer: number): { x: number; y: number } | null {
    if (!snap.inVehicle || distToPlayer > ARREST.engageDist) {
      this.goals.delete(p);
      return null;
    }
    if (p.chaseSlot % 2 !== 0) {
      // 奇数 slot：尾随追击（贴近后由追捕末段逻辑直接逼撞）
      this.goals.delete(p);
      return null;
    }
    // 前导距离随玩家速度缩放，钳制在配置窗口内
    const lead = Math.min(ARREST.leadMax, Math.max(ARREST.leadMin, snap.playerSpeed * 1.1));
    const sp = Math.max(snap.playerSpeed, 1);
    const gx = snap.playerX + (snap.playerVX / sp) * lead;
    const gy = snap.playerY + (snap.playerVY / sp) * lead;
    const goal = { x: gx, y: gy };
    this.goals.set(p, goal);
    return goal;
  }

  /** 警车被裁撤时清理目标缓存 */
  forget(p: Police): void {
    this.goals.delete(p);
  }
}
