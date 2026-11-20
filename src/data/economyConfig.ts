/**
 * 经济系统集中配置：所有金额、掉落概率、奖励倍率都集中在这里，
 * 各游戏模块不得散落硬编码数值。
 */
import { START_CASH } from '../config';

export const ECONOMY = {
  /** 初始现金（美元） */
  initialCash: START_CASH,
  /** 初始积分 */
  initialScore: 0,

  /** 犯罪行为积分奖励（仅在犯罪被警察目击计入通缉时发放，冷却机制复用 WantedSystem，天然防重复领取） */
  scorePerCrime: {
    steal_vehicle: 10,
    hit_npc: 15,
    hit_police: 25,
    attack_npc: 10,
    attack_police: 30,
  } as Record<string, number>,

  /** NPC 被击败后的现金掉落 */
  npcCashDrop: {
    chance: 0.55, // 掉落概率（不保证每个 NPC 都掉）
    min: 5, // 单次掉落金额下限（美元）
    max: 25, // 单次掉落金额上限（美元）
    streetCap: 60, // 街头现金收益窗口上限（美元）
    recoverPerSec: 1, // 收益预算恢复速率（美元/秒），防止无限刷钱
    maxBagsOnGround: 24, // 地面现金包上限，超出移除最早的
    pickupRadius: 30, // 自动拾取半径（px）
    bagLifetimeMs: 60000, // 现金包存在时长，超时消失
  },

  /** 交易记录上限（内存保留条数） */
  txHistoryMax: 20,
  /** HUD 最近交易显示条数 */
  txHudLines: 3,
  /** 金钱浮动提示持续时间（ms） */
  floatMs: 1600,
  /** 存档节流时间（ms） */
  saveDebounceMs: 800,
  /** localStorage 存档 key */
  saveKey: 'retroCity.save.v1',
} as const;

/** 收入来源 → HUD 标签 */
export const INCOME_LABELS: Record<string, string> = {
  mission_reward: 'MISSION REWARD',
  cash_pickup: 'CASH PICKUP',
  vehicle_sale: 'VEHICLE SOLD',
  special: 'BONUS',
};

/** 支出原因 → HUD 标签 */
export const SPEND_LABELS: Record<string, string> = {
  weapon: 'WEAPON PURCHASE',
  ammo: 'AMMO PURCHASE',
  armor: 'BODY ARMOR',
  vehicle_repair: 'VEHICLE REPAIR',
  vehicle_purchase: 'VEHICLE PURCHASE',
  spray: 'RESPRAY',
  bust_fine: 'BUST FINE',
};
