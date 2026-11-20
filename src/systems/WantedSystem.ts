/**
 * 通缉等级系统：五级通缉（0-5 星）+ 统一犯罪事件接口。
 *
 * 设计要点：
 * - Player / Vehicle / Police 一律通过 reportCrime() 上报犯罪，不直接修改通缉等级。
 * - 犯罪发生 ≠ 警察知道：多数犯罪需要警察在距离内且无建筑遮挡时"目击"才计入通缉。
 * - 通缉值（heat）累积决定星级；警察失去玩家视线一段时间后 heat 持续衰减，
 *   归零即"逃脱成功"，全部警车恢复巡逻。
 */
import * as Phaser from 'phaser';
import { POLICE } from '../config';

export type CrimeType =
  | 'steal_vehicle' // 偷车
  | 'hit_npc' // 驾车撞击 NPC
  | 'hit_police' // 驾车撞击警车
  | 'attack_npc' // 攻击 NPC（第三阶段预留接口，未接入触发源）
  | 'attack_police'; // 攻击警察（第三阶段预留接口，未接入触发源）

export interface CrimeRecord {
  type: CrimeType;
  x: number;
  y: number;
  time: number;
  witnessed: boolean; // 是否被警察目击
  heatAfter: number; // 事件后的通缉值
}

/** 各犯罪的严重程度（单次增加的通缉值） */
const SEVERITY: Record<CrimeType, number> = {
  steal_vehicle: 25,
  hit_npc: 20,
  hit_police: 45,
  attack_npc: 15,
  attack_police: 60,
};

/** 同类犯罪的最小间隔（ms）：防止同一次碰撞在连续帧内重复累计 */
const COOLDOWN: Record<CrimeType, number> = {
  steal_vehicle: 1200,
  hit_npc: 900,
  hit_police: 900,
  attack_npc: 500,
  attack_police: 500,
};

/** 是否需要警察目击才计入通缉（警车作为受害者时不需要目击） */
const NEEDS_WITNESS: Record<CrimeType, boolean> = {
  steal_vehicle: true,
  hit_npc: true,
  hit_police: false,
  attack_npc: true,
  attack_police: false,
};

/** 各星级对应的通缉值门槛 */
export const LEVEL_THRESHOLDS = [0, 20, 60, 120, 200, 300];
const HEAT_MAX = 400;
/** 逃脱：失去视线 2.5s 后开始衰减（5.5/s），15s 后加速（9/s） */
const DECAY_GRACE = 2500;
const DECAY_RATE = 5.5;
const DECAY_RATE_FAST = 9;

export interface WantedHooks {
  /** 目击判定：该位置是否被任意警车看到（距离 + 建筑遮挡） */
  witness(x: number, y: number): boolean;
  /** 通知目击的警察前往犯罪现场调查 */
  dispatch(x: number, y: number): void;
}

export class WantedSystem extends Phaser.Events.EventEmitter {
  private heat = 0;
  private lvl = 0;
  private history: CrimeRecord[] = [];
  private lastCrimeTime: Partial<Record<CrimeType, number>> = {};
  private lastKnownPos = { x: 0, y: 0, t: -1e9 };
  private unseenMs = 9999; // 警察失去玩家视线的持续时间

  constructor(private hooks: WantedHooks) {
    super();
  }

  get level(): number {
    return this.lvl;
  }

  get heatValue(): number {
    return this.heat;
  }

  get lastKnown(): { x: number; y: number; t: number } {
    return this.lastKnownPos;
  }

  /** 当前等级下全城警车目标数量 */
  get targetPoliceCount(): number {
    return POLICE.targetByLevel[this.lvl];
  }

  get crimeHistory(): readonly CrimeRecord[] {
    return this.history;
  }

  /**
   * 统一犯罪上报入口。
   * @returns 是否计入通缉（false = 冷却中 或 未被目击仅记录）
   */
  reportCrime(type: CrimeType, x: number, y: number, time: number): boolean {
    const last = this.lastCrimeTime[type];
    if (last !== undefined && time - last < COOLDOWN[type]) return false; // 同一次碰撞不重复累计
    this.lastCrimeTime[type] = time;

    const witnessed = this.hooks.witness(x, y);

    if (NEEDS_WITNESS[type] && !witnessed) {
      // 未被目击：只记录，不通缉
      this.history.push({ type, x, y, time, witnessed, heatAfter: this.heat });
      if (this.history.length > 80) this.history.shift();
      return false;
    }

    this.heat = Math.min(HEAT_MAX, this.heat + SEVERITY[type]);
    if (this.lvl === 0) this.heat = Math.max(this.heat, LEVEL_THRESHOLDS[1]); // 首次被目击的犯罪至少 1 星
    this.history.push({ type, x, y, time, witnessed, heatAfter: this.heat });
    if (this.history.length > 80) this.history.shift();
    this.hooks.dispatch(x, y); // 目击的警察前往现场
    this.recompute();
    // 犯罪被计入通缉（冷却后的有效事件）：供经济系统发放犯罪积分（同事件不重复领取）
    this.emit('crime-counted', { type, x, y, time });
    return true;
  }

  /** 警察真实目击玩家（更新最后已知位置，重置逃脱计时） */
  markSeen(x: number, y: number, time: number): void {
    this.lastKnownPos = { x, y, t: time };
    this.unseenMs = 0;
  }

  /**
   * 每帧更新：无警察目击且无警察追捕时，通缉值逐渐衰减 → 星级下降 → 归零逃脱。
   * @param anySeen 本帧是否有警察真实目击玩家
   * @param anyChasing 是否有警察处于 CHASE 追捕状态
   */
  update(delta: number, anySeen: boolean, anyChasing: boolean): void {
    if (anySeen) this.unseenMs = 0;
    else this.unseenMs += delta;

    if (this.lvl > 0 && !anySeen && !anyChasing && this.unseenMs > DECAY_GRACE) {
      const rate = this.unseenMs > 15000 ? DECAY_RATE_FAST : DECAY_RATE;
      this.heat = Math.max(0, this.heat - (rate * delta) / 1000);
      this.recompute();
    }
  }

  /** 被捕后清空通缉（BUSTED 结算用，不触发 escaped 事件） */
  reset(): void {
    this.heat = 0;
    this.lvl = 0;
    this.unseenMs = 9999;
    this.emit('reset');
  }

  private recompute(): void {
    let nl = 0;
    for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
      if (this.heat >= LEVEL_THRESHOLDS[i]) nl = i;
    }
    if (nl > this.lvl) {
      this.lvl = nl;
      this.emit('level-up', nl);
    } else if (nl < this.lvl) {
      this.lvl = nl;
      this.emit('level-down', nl);
      if (nl === 0) this.emit('escaped');
    }
  }
}
