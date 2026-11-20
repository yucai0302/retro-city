/**
 * 经济系统统一接口（EconomyManager）：
 * - addCash(amount, source) / spendCash(amount, reason)
 * - addScore(amount, source)
 * - getCash() / getScore() / getTransactionHistory()
 *
 * 未来 MissionManager 完成任务后必须通过本接口发放现金与积分，
 * 任务系统不得自建现金变量。现金与积分相互独立。
 * HUD 数据（现金 / 积分 / 浮动提示 / 交易记录）通过 registry 推送。
 * 存档使用 localStorage（节流写入，含现金、积分、最近交易）。
 */
import * as Phaser from 'phaser';
import { ECONOMY, INCOME_LABELS, SPEND_LABELS } from '../data/economyConfig';
import { WalletSystem, TxRecord } from './WalletSystem';
import { ScoreSystem } from './ScoreSystem';

export class EconomyManager {
  private wallet: WalletSystem;
  private score: ScoreSystem;
  private saveAcc = 0;
  private dirty = false;
  private floatSeq = 0;

  constructor(private scene: Phaser.Scene) {
    let saved: { cash?: number; records?: TxRecord[]; score?: number } | null = null;
    try {
      const raw = localStorage.getItem(ECONOMY.saveKey);
      if (raw) saved = JSON.parse(raw);
    } catch {
      saved = null; // 存档损坏时按全新账户处理
    }

    this.wallet = new WalletSystem(ECONOMY.initialCash);
    this.score = new ScoreSystem(ECONOMY.initialScore);
    if (saved) {
      this.wallet.deserialize(saved);
      this.score.deserialize(saved.score);
    }
    this.syncHud();
  }

  // ---------- 统一接口 ----------

  /** 收入：完成任务 / 现金拾取 / 出售车辆 / 特殊奖励等 */
  addCash(amount: number, source: string): void {
    if (amount <= 0) return;
    this.wallet.add(amount, INCOME_LABELS[source] ?? source.toUpperCase());
    this.syncHud();
    this.scheduleSave();
  }

  /** 支出：购买武器 / 弹药 / 防弹衣 / 维修 / 购车 / 喷漆 / 罚款。余额不足返回 false */
  spendCash(amount: number, reason: string): boolean {
    if (amount <= 0) return true;
    const ok = this.wallet.spend(amount, SPEND_LABELS[reason] ?? reason.toUpperCase());
    if (ok) {
      this.syncHud();
      this.scheduleSave();
    }
    return ok;
  }

  /** 积分：犯罪行为 / 任务表现 / 特殊奖励 */
  addScore(amount: number, _source: string): void {
    if (amount <= 0) return;
    this.score.add(amount);
    this.syncHud();
    this.scheduleSave();
  }

  getCash(): number {
    return this.wallet.balance;
  }

  getScore(): number {
    return this.score.value;
  }

  getTransactionHistory(): readonly TxRecord[] {
    return this.wallet.history;
  }

  // ---------- HUD 同步与存档 ----------

  /** 每帧调用：处理存档节流写入 */
  update(delta: number): void {
    if (!this.dirty) return;
    this.saveAcc += delta;
    if (this.saveAcc >= ECONOMY.saveDebounceMs) {
      this.saveAcc = 0;
      this.dirty = false;
      this.save();
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    this.saveAcc = 0;
  }

  private save(): void {
    try {
      const data = { ...this.wallet.serialize(), score: this.score.serialize() };
      localStorage.setItem(ECONOMY.saveKey, JSON.stringify(data));
    } catch {
      // localStorage 不可用时静默跳过（隐私模式等）
    }
  }

  private syncHud(): void {
    const reg = this.scene.registry;
    reg.set('cash', this.wallet.balance);
    reg.set('score', this.score.value);
    const lines = this.wallet.history
      .slice(-ECONOMY.txHudLines)
      .reverse()
      .map((r) => `${r.amount >= 0 ? '+' : '-'}$${Math.abs(r.amount)} ${r.label}`);
    reg.set('tx', lines);
    const last = this.wallet.history[this.wallet.history.length - 1];
    if (last) {
      reg.set('float', { id: ++this.floatSeq, amount: last.amount, label: last.label });
    }
  }
}
