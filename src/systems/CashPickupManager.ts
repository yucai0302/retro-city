/**
 * 街头现金掉落与拾取：
 * - NPC 被玩家击败（驾车撞击）后按配置概率掉落 $5-25 现金包；
 * - 每个 NPC 只能产生一次掉落（按精灵实例记录）；
 * - 现金包为地面像素包，玩家靠近自动拾取并更新 CASH；
 * - 单位时间街头收益上限 + 递减恢复机制，防止无限刷钱；
 * - 犯罪本身仍走 WantedSystem（撞击上报 hit_npc），掉落是独立事件不重复结算。
 */
import * as Phaser from 'phaser';
import { ECONOMY } from '../data/economyConfig';
import { EconomyManager } from './EconomyManager';

interface CashBag {
  sprite: Phaser.GameObjects.Image;
  amount: number;
  bornAt: number;
}

export class CashPickupManager {
  private scene: Phaser.Scene;
  private economy: EconomyManager;
  private bags: CashBag[] = [];
  private defeatedNpcs = new Set<Phaser.Physics.Arcade.Sprite>();
  private streetBudget: number = ECONOMY.npcCashDrop.streetCap;

  constructor(scene: Phaser.Scene, economy: EconomyManager) {
    this.scene = scene;
    this.economy = economy;
  }

  /** 当前地面现金包列表（小地图显示用） */
  get activeBags(): readonly CashBag[] {
    return this.bags;
  }

  /**
   * NPC 被击败时的掉落尝试。
   * @param npc 被击败的 NPC 精灵（用于"每个 NPC 只掉一次"判定）
   * @returns 是否真的掉落了现金
   */
  tryDropFromNpc(npc: Phaser.Physics.Arcade.Sprite): boolean {
    if (this.defeatedNpcs.has(npc)) return false; // 同一 NPC 不重复掉落
    this.defeatedNpcs.add(npc);

    const cfg = ECONOMY.npcCashDrop;
    if (Math.random() >= cfg.chance) return false;

    const amount = Phaser.Math.Between(cfg.min, cfg.max);
    if (this.streetBudget < amount) return false; // 收益窗口耗尽：本包不生成（递减防刷）
    this.streetBudget -= amount;

    this.spawnBag(npc.x, npc.y, amount);
    return true;
  }

  /** 直接在指定位置生成一个现金包（未来特殊奖励复用） */
  spawnBag(x: number, y: number, amount: number): void {
    const sprite = this.scene.add
      .image(x, y, 'cash-bag')
      .setDepth(2)
      .setScale(1);
    const bag: CashBag = { sprite, amount, bornAt: this.scene.time.now };
    this.bags.push(bag);

    // 落地弹跳动画
    sprite.setScale(0.2);
    this.scene.tweens.add({ targets: sprite, scale: 1, duration: 220, ease: 'Back.easeOut' });

    // 地面现金包数量上限：移除最早的
    if (this.bags.length > ECONOMY.npcCashDrop.maxBagsOnGround) {
      const oldest = this.bags.shift();
      if (oldest) this.removeBag(oldest);
    }
  }

  private removeBag(bag: CashBag): void {
    const idx = this.bags.indexOf(bag);
    if (idx >= 0) this.bags.splice(idx, 1);
    bag.sprite.destroy();
  }

  /** 每帧：收益预算恢复 + 现金包超时清理 + 玩家靠近自动拾取 */
  update(delta: number, playerX: number, playerY: number): void {
    const cfg = ECONOMY.npcCashDrop;
    this.streetBudget = Math.min(cfg.streetCap, this.streetBudget + (cfg.recoverPerSec * delta) / 1000);

    const now = this.scene.time.now;
    for (let i = this.bags.length - 1; i >= 0; i--) {
      const bag = this.bags[i];
      if (now - bag.bornAt > cfg.bagLifetimeMs) {
        this.removeBag(bag);
        continue;
      }
      const dx = bag.sprite.x - playerX;
      const dy = bag.sprite.y - playerY;
      if (dx * dx + dy * dy < cfg.pickupRadius * cfg.pickupRadius) {
        this.economy.addCash(bag.amount, 'cash_pickup');
        this.removeBag(bag);
      }
    }
  }
}
