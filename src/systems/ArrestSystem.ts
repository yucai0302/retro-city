/**
 * 抓捕系统：统一管理抓捕进度（ARRESTING 0-100%），步行与驾驶两套规则。
 *
 * 步行规则：
 * - 警察（Officer 实体，用其自身坐标）进入抓捕距离 → 进度增长；
 *   多名警察同时控制时进度加快。
 * - 玩家脱离一定距离 → 进度暂停；彻底脱离 → 进度回退。
 *
 * 驾驶规则：
 * - 玩家高速行驶时无法抓捕（进度不增长/回退）。
 * - 车辆被逼停（低速）且有警车在控制范围内低速压住 → 进度增长。
 * - 玩家重新加速逃跑 → 进度快速回退。
 *
 * 进度 100% 触发一次 'busted' 事件（单例管理器保证多辆警车不重复触发）。
 */
import * as Phaser from 'phaser';
import { ARREST } from '../config';

export interface ArrestCop {
  x: number;
  y: number;
  speed: number; // 控制者当前速度（警车用于"有效控制"判定）
}

export interface ArrestCtx {
  inVehicle: boolean;
  playerX: number;
  playerY: number;
  playerSpeed: number;
  level: number;
  chaseActive: boolean;
  cops: ArrestCop[];
}

export class ArrestSystem extends Phaser.Events.EventEmitter {
  progress = 0;
  active = false;
  private bustedFired = false;

  /** 距玩家最近的控制者距离（供 HUD/调试） */
  nearestDist = 9999;

  update(delta: number, ctx: ArrestCtx): void {
    const dt = delta / 1000;

    if (ctx.level === 0 || (!ctx.chaseActive && this.progress <= 0)) {
      this.decay(dt, 40);
      return;
    }

    // 控制者与玩家的距离集合
    let control = 0;
    let nearest = 9999;
    for (const c of ctx.cops) {
      const d = Math.hypot(c.x - ctx.playerX, c.y - ctx.playerY);
      if (d < nearest) nearest = d;
    }
    this.nearestDist = nearest;

    if (ctx.inVehicle) {
      // 驾驶抓捕：控制者 = 控制范围内且自身低速的警车
      for (const c of ctx.cops) {
        const d = Math.hypot(c.x - ctx.playerX, c.y - ctx.playerY);
        if (d < ARREST.vehicleControlDist && c.speed < ARREST.policeControlSpeed) control++;
      }
      if (ctx.playerSpeed < ARREST.playerStoppedSpeed && control > 0) {
        // 被逼停且被控制：进度增长（多车加快）
        this.progress += (ARREST.driveRate + ARREST.drivePerCop * Math.min(control - 1, 2)) * dt;
      } else if (ctx.playerSpeed > 80 && control > 0) {
        // 玩家重新加速突破：快速回退
        this.decay(dt, ARREST.driveDecay);
      } else if (ctx.playerSpeed < ARREST.playerStoppedSpeed && control === 0) {
        // 停着但没有警车有效控制
        this.decay(dt, ARREST.driveNoControlDecay);
      }
      // 中间速度区间：进度冻结（警察正在逼近）
    } else {
      // 步行抓捕：控制者 = 进入抓捕距离的步行警察
      for (const c of ctx.cops) {
        const d = Math.hypot(c.x - ctx.playerX, c.y - ctx.playerY);
        if (d < ARREST.catchDistFoot) control++;
      }
      if (control > 0) {
        this.progress += ARREST.footRate * (1 + 0.4 * (control - 1)) * dt;
      } else if (nearest < ARREST.footLoseDist) {
        // 警察还在附近追：进度暂停
      } else {
        this.decay(dt, ARREST.footDecay);
      }
    }

    this.progress = Phaser.Math.Clamp(this.progress, 0, 100);
    this.active = this.progress >= 1 && this.progress < 100;

    if (this.progress >= 100 && !this.bustedFired) {
      this.bustedFired = true;
      this.active = false;
      this.emit('busted');
    }
  }

  /** 被捕结算/重生后重置 */
  reset(): void {
    this.progress = 0;
    this.active = false;
    this.bustedFired = false;
    this.nearestDist = 9999;
  }

  private decay(dt: number, rate: number): void {
    this.progress = Math.max(0, this.progress - rate * dt);
    this.active = this.progress >= 1;
    this.nearestDist = 9999;
  }
}
