/**
 * 游戏积分：SCORE 累计积分，用于任务表现与后续进度。
 * 与 CASH 完全独立，不能用于购买商品。
 */
export class ScoreSystem {
  private score: number;

  constructor(initialScore: number) {
    this.score = Math.max(0, Math.floor(initialScore));
  }

  get value(): number {
    return this.score;
  }

  add(amount: number): void {
    if (amount <= 0) return;
    this.score += Math.floor(amount);
  }

  serialize(): number {
    return this.score;
  }

  deserialize(v: unknown): void {
    if (typeof v === 'number' && v >= 0) this.score = Math.floor(v);
  }
}
