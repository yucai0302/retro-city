/** 全局配置常量 */
export const TILE = 32;
export const MAP_W = 100;
export const MAP_H = 100;
export const WORLD_W = MAP_W * TILE;
export const WORLD_H = MAP_H * TILE;

export const PLAYER_SPEED = 155;
export const NPC_COUNT = 45;

/** 朝向: 0 下 1 上 2 左 3 右（与精灵图帧行对应） */
export const DIR_NAMES = ['down', 'up', 'left', 'right'] as const;
export const DIR_VEC: Array<[number, number]> = [
  [0, 1],
  [0, -1],
  [-1, 0],
  [1, 0],
];

/** 警察与通缉系统配置 */
export const POLICE = {
  initialCount: 5, // 初始巡逻警车数
  maxCount: 8, // 全城警车上限
  targetByLevel: [4, 4, 5, 6, 7, 8], // 各通缉等级的目标警车数（0-5 星）
  spawnMinDist: 760, // 增援生成点距玩家最小距离（距离制视野排除，兼容超大视口）
  spawnMaxDist: 1400, // 增援生成点距玩家最大距离
  minSpacing: 170, // 警车之间的最小生成间距
  witnessDist: 350, // 目击犯罪的判定距离
  radioLevel: 2, // 该通缉等级起警用无线电持续通报玩家位置
  searchTimeout: 18000, // 单辆警车搜索超时（ms），超时后返回巡逻
  repathChase: 480, // 追捕状态重寻路间隔（ms）
  repathOther: 900, // 其他状态重寻路间隔（ms）
  sightTick: 160, // 视野检测间隔（ms），各警车错开
} as const;

/** Phase 3.1：拦截 / 抓捕 / 被捕系统配置 */
export const ARREST = {
  engageDist: 520, // 警车进入拦截机动（前置阻挡）的距离
  leadMin: 120, // 前置拦截点最小前导距离（px）
  leadMax: 420, // 前置拦截点最大前导距离（px）
  footDeployDist: 230, // 玩家步行时警车停车放警察下车的距离（警车停在最近道路 tile，距人行道玩家可能达 ~2 tile）
  footDeploySpeed: 60, // 警车低于该速度才可放警察下车
  officerSpeed: 112, // 步行警察追捕速度（略低于玩家，跑得掉但不容易）
  officerMax: 4, // 全城步行警察上限（性能约束）
  catchDistFoot: 46, // 步行抓捕判定距离（警察自身坐标）
  footRate: 30, // 步行抓捕基础进度（%/s）
  footLoseDist: 150, // 步行抓捕：脱离该距离进度开始回退
  footDecay: 35, // 步行抓捕进度回退速率（%/s）
  vehicleControlDist: 140, // 驾驶抓捕：警车控制范围（px）
  playerStoppedSpeed: 45, // 玩家车辆低于该速度视为被逼停（px/s）
  policeControlSpeed: 40, // 控制警车自身低于该速度视为"有效控制"
  driveRate: 16, // 驾驶抓捕基础进度（%/s）
  drivePerCop: 9, // 每增加一辆控制警车的额外进度（%/s）
  driveDecay: 30, // 玩家重新加速逃跑时进度回退（%/s）
  driveNoControlDecay: 10, // 被逼停但无警车有效控制时进度回退（%/s）
  officerCatchRange: 320, // 步行警察距玩家超过该距离时撤回
  officerReturnMs: 6000, // 步行警察返回警车的最长时限
} as const;

/** 被捕结算配置 */
export const START_CASH = 500; // 初始现金（第四阶段金钱系统的基础状态）
export const BUST_FINE_RATE = 0.2; // 罚款 = 现金 × 20%
export const BUST_FINE_MIN = 100; // 最低罚款
