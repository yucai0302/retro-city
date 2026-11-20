/**
 * 被捕结算系统（BUSTED）：抓捕进度 100% 后的结算与游戏恢复。
 *
 * begin()：立即结算 —— 扣罚款（现金 20%，最低罚款）、扣押当前车辆、
 *          停止玩家输入与警车行动、显示 BUSTED 界面。
 * respawn()：玩家确认后恢复 —— 传送至警察局、恢复步行、清空通缉、
 *          全部警车回巡逻、重置抓捕进度；不重建地图/NPC/车辆。
 */
import { BUST_FINE_RATE, BUST_FINE_MIN } from '../config';
import type { GameScene } from '../scenes/GameScene';

export interface BustInfo {
  level: number;
  fine: number;
  seized: boolean;
  vehicleName: string;
  cash: number;
}

export class BustSystem {
  private scene: GameScene;
  private lastInfo: BustInfo | null = null;

  constructor(scene: GameScene) {
    this.scene = scene;
  }

  get info(): BustInfo | null {
    return this.lastInfo;
  }

  /** 触发被捕结算：冻结世界 + 扣款 + 扣车 + 显示界面 */
  begin(level: number): void {
    const s = this.scene;
    const v = s.vehicles.active;

    // 停止玩家车辆并扣押（从可驾驶车辆池移除）
    let seized = false;
    let vehicleName = 'NONE';
    if (v) {
      v.halt();
      v.driven = false;
      seized = true;
      vehicleName = v.spec.name;
      s.vehicles.removeVehicle(v);
    }

    // 罚款：现金的 20%，设最低罚款（统一走经济系统接口，记录交易）
    const fine = Math.max(BUST_FINE_MIN, Math.floor(s.economy.getCash() * BUST_FINE_RATE));
    s.economy.spendCash(fine, 'bust_fine');

    // 冻结警察行动（全部急停），停警笛
    s.police.freezeAll();

    this.lastInfo = {
      level,
      fine,
      seized,
      vehicleName,
      cash: s.economy.getCash(),
    };
    s.registry.set('busted', { show: true, ...this.lastInfo });
  }

  /** 玩家确认 RESPawn：恢复游戏（不重建地图 / 不重置 NPC 与其他车辆） */
  respawn(): void {
    const s = this.scene;
    s.registry.set('busted', { show: false, ...this.lastInfo });
    this.lastInfo = null;

    // 通缉清零 + 全部警车回巡逻 + 抓捕进度清零
    s.wanted.reset();
    s.police.resetToPatrol();
    s.arrest.reset();

    // 玩家传送至警察局附近，恢复步行控制
    s.respawnAtStation();
  }
}
