/**
 * 现金钱包：CASH 可消费现金 + 交易记录。
 * 不与 SCORE 混用；所有变动都附带来源标签与时间。
 */
import { ECONOMY } from '../data/economyConfig';

export interface TxRecord {
  amount: number; // 正 = 收入，负 = 支出
  label: string; // 来源/原因标签（HUD 展示用）
  time: number; // 真实时间戳（ms）
}

export class WalletSystem {
  private cash: number;
  private records: TxRecord[] = [];

  constructor(initialCash: number) {
    this.cash = Math.max(0, Math.floor(initialCash));
  }

  get balance(): number {
    return this.cash;
  }

  add(amount: number, label: string): void {
    if (amount <= 0) return;
    this.cash += Math.floor(amount);
    this.record(amount, label);
  }

  /** 扣款：余额不足时整体失败，不做部分扣除 */
  spend(amount: number, label: string): boolean {
    const n = Math.floor(amount);
    if (n <= 0) return true;
    if (this.cash < n) return false;
    this.cash -= n;
    this.record(-n, label);
    return true;
  }

  private record(amount: number, label: string): void {
    this.records.push({ amount, label, time: Date.now() });
    if (this.records.length > ECONOMY.txHistoryMax) this.records.shift();
  }

  get history(): readonly TxRecord[] {
    return this.records;
  }

  /** 存档用：只保留最近若干条记录 */
  serialize(): { cash: number; records: TxRecord[] } {
    return { cash: this.cash, records: this.records.slice(-10) };
  }

  deserialize(data: { cash?: number; records?: TxRecord[] }): void {
    if (typeof data.cash === 'number' && data.cash >= 0) this.cash = Math.floor(data.cash);
    if (Array.isArray(data.records)) {
      this.records = data.records.filter((r) => r && typeof r.amount === 'number').slice(-ECONOMY.txHistoryMax);
    }
  }
}
