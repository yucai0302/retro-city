/**
 * 警察实体：继承 Vehicle 的驾驶物理与碰撞，叠加 AI 状态机。
 *
 * 状态机：PATROL 巡逻 / ALERT 警戒 / CHASE 追捕 / SEARCH 搜索
 * - AI 不直接设置速度，而是输出 DriveInput 交给 Vehicle.update()，
 *   与玩家驾驶共用同一套物理（加速/转向/碰撞），保证警车不能穿墙、受同样惯性约束。
 * - 寻路与目标分配由 PoliceManager 完成（道路 BFS + 视野判断），本类负责
 *   状态切换决策与沿路径驾驶。
 */
import * as Phaser from 'phaser';
import { Vehicle, DriveInput } from './Vehicle';
import { POLICE, ARREST } from '../config';

export type PoliceState = 'PATROL' | 'ALERT' | 'CHASE' | 'SEARCH';

export interface PoliceCtx {
  playerX: number;
  playerY: number;
  playerInVehicle: boolean;
  seesPlayer: boolean; // PoliceManager 计算好的视野结果（距离 + 建筑遮挡）
  wantedLevel: number;
  time: number; // scene.time.now
  holdPosition: boolean; // true = 停车（警察下车抓捕中），本车不追击
}

/** 各状态的视野范围（px），4 星以上加成 */
const SIGHT_BY_STATE: Record<PoliceState, number> = { PATROL: 320, ALERT: 360, CHASE: 440, SEARCH: 380 };
/** 各状态的巡航速度（px/s） */
const CRUISE: Record<PoliceState, number> = { PATROL: 120, ALERT: 190, CHASE: 330, SEARCH: 175 };
/** 失去视线多久后从 CHASE 转入 SEARCH（ms） */
const CHASE_MEMORY = 2600;
/** ALERT 到达现场后的停留观察时长（ms） */
const ALERT_LINGER = 6000;
/** 卡死判定：油门下速度低于该值持续 STUCK_MS 则倒车脱困 */
const STUCK_SPEED = 12;
const STUCK_MS = 1100;
const REVERSE_MS = 700;

export class Police extends Vehicle {
  state: PoliceState = 'PATROL';

  // 路径跟随（路径由 PoliceManager 寻路生成）
  path: Array<{ x: number; y: number }> = [];
  pathIdx = 0;
  needTarget = true; // 请求 Manager 分配新目标
  repathTimer = 0;
  sightTimer = 0;

  // 视野记忆
  seesPlayer = false;
  lastSeenX = 0;
  lastSeenY = 0;
  lastSeenAt = -1e9;

  // 状态计时
  stateTimer = 0;
  arriveLinger = 0;

  // 卡死脱困
  private stuckTimer = 0;
  private reverseTimer = 0;
  private stuckSteer = 1;
  private stuckCheckTimer = 0;
  private lastStuckCheckX = 0;
  private lastStuckCheckY = 0;
  /** 连续卡死次数（Manager 据此换方位重新寻路） */
  stuckCount = 0;

  // 真实位移速度（px/s）：碰撞挤压时 body 速度仍是设定值，只有位移可信
  actualMoveSpeed = 0;
  private prevX = 0;
  private prevY = 0;

  // 包围方位序号（0-3，3 星起 PoliceManager 按方位分配拦截目标）
  chaseSlot = 0;
  slotFresh = true; // 进入 CHASE 后由 Manager 分配一次包围方位

  // Phase 3.1：本车是否已放出步行警察（下车抓捕中）
  officerDeployed = false;

  // ALERT 调查点
  alertX = 0;
  alertY = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, rotation = 0) {
    super(scene, x, y, 'police', rotation);
    this.driven = true; // 与玩家驾驶的车辆同等处理（碰撞盒尺寸 + 位置钳制）
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setImmovable(false);
    // 警车由 AI 驾驶，必须可移动（Vehicle 构造默认停放态 moves=false）
    body.moves = true;
    // 警车不得驶出世界边界（曾出现沿边界外直线狂奔的失控案例）
    body.setCollideWorldBounds(true);
    this.setDepth(4);
  }

  get chasing(): boolean {
    return this.state === 'CHASE';
  }

  /** 当前状态视野范围 */
  sightRange(wantedLevel: number): number {
    const base = SIGHT_BY_STATE[this.state];
    return wantedLevel >= 4 ? base + 80 : base;
  }

  /** 状态切换：清空路径并请求新目标 */
  enterState(s: PoliceState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateTimer = 0;
    this.arriveLinger = 0;
    this.path = [];
    this.pathIdx = 0;
    this.needTarget = true;
    this.repathTimer = 0;
    if (s === 'CHASE') this.slotFresh = true;
  }

  /** 收到犯罪/无线电通报：前往该位置调查 */
  investigate(x: number, y: number): void {
    this.alertX = x;
    this.alertY = y;
    if (this.state === 'PATROL') this.enterState('ALERT');
  }

  setPath(pts: Array<{ x: number; y: number }>): void {
    this.path = pts;
    this.pathIdx = 0;
    this.needTarget = false;
    this.repathTimer = POLICE.repathChase;
  }

  private wrapAngle(a: number): number {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  /**
   * 沿路径输出驾驶输入：瞄准下一个路点，角度差决定转向与油门。
   * 路点由道路 BFS 生成，警车自然沿路网行驶，不会直穿建筑。
   */
  private driveToPath(cruise: number): DriveInput {
    let wp: { x: number; y: number } | null = null;
    while (this.pathIdx < this.path.length) {
      const w = this.path[this.pathIdx];
      if (Math.hypot(w.x - this.x, w.y - this.y) < 36) {
        this.pathIdx++;
        continue;
      }
      wp = w;
      break;
    }
    if (!wp) {
      this.needTarget = true; // 到达终点，请求新目标
      return { throttle: false, brake: true, steer: 0, handbrake: false };
    }
    return this.driveToward(wp.x, wp.y, cruise);
  }

  /** 朝目标点直线驾驶（仅用于 CHASE 中视野良好的近距离逼近，不穿建筑） */
  private driveToward(tx: number, ty: number, cruise: number): DriveInput {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const desired = Math.atan2(dx, -dy);
    const ang = this.wrapAngle(desired - this.rotation);
    const steer = ang > 0.08 ? 1 : ang < -0.08 ? -1 : 0;
    const speed = this.speed;
    const throttle = Math.abs(ang) < 0.65 && speed < cruise;
    const brake = Math.abs(ang) > 1.15 && speed > 90;
    return { throttle, brake, steer, handbrake: false };
  }

  /**
   * AI 主更新：状态机决策 + 输出驾驶输入。
   * @param onSpotted 首次从非追捕状态发现玩家时的回调（供 Manager 播报）
   */
  updateAI(delta: number, ctx: PoliceCtx, onSpotted: () => void): void {
    this.stateTimer += delta;
    this.repathTimer -= delta;

    // 真实位移速度（上帧到本帧的位移；挤压/阻挡时远小于 body 速度）
    this.actualMoveSpeed = Math.hypot(this.x - this.prevX, this.y - this.prevY) / Math.max(delta, 1) * 1000;
    this.prevX = this.x;
    this.prevY = this.y;

    // 视野记忆维护
    if (ctx.seesPlayer) {
      if (!this.seesPlayer && this.state !== 'CHASE') onSpotted();
      this.seesPlayer = true;
      this.lastSeenX = ctx.playerX;
      this.lastSeenY = ctx.playerY;
      this.lastSeenAt = ctx.time;
    } else {
      this.seesPlayer = false;
    }

    let cruise = CRUISE[this.state];
    const dist = Math.hypot(ctx.playerX - this.x, ctx.playerY - this.y);

    switch (this.state) {
      case 'PATROL': {
        if (ctx.seesPlayer && ctx.wantedLevel >= 2) {
          this.enterState('CHASE');
        } else if (ctx.seesPlayer && ctx.wantedLevel === 1) {
          // 1 星：警察注意到玩家，靠近观察（警戒）
          this.enterState('ALERT');
        }
        break;
      }
      case 'ALERT': {
        if (ctx.seesPlayer) {
          this.enterState('CHASE');
          break;
        }
        // 到达调查点后停留观察，超时结束
        if (this.pathIdx >= this.path.length && !this.needTarget) {
          this.arriveLinger += delta;
          if (this.arriveLinger > ALERT_LINGER) this.enterState('PATROL');
        }
        break;
      }
      case 'CHASE': {
        if (!ctx.seesPlayer && ctx.time - this.lastSeenAt > CHASE_MEMORY) {
          this.enterState('SEARCH'); // 失去视线：前往最后目击位置搜索
          break;
        }
        // 玩家步行且距离很近：减速逼停，避免无脑碾压
        if (!ctx.playerInVehicle && dist < 80) cruise = 0;
        // 玩家驾驶且警车已进入控制范围：贴近并停稳（形成"有效控制"，供抓捕进度判定）
        if (ctx.playerInVehicle && dist < ARREST.vehicleControlDist) cruise = 0;
        // 警察已下车抓捕：本车保持停车
        if (ctx.holdPosition) cruise = 0;
        break;
      }
      case 'SEARCH': {
        if (ctx.seesPlayer) {
          this.enterState('CHASE'); // 再次发现：恢复追捕
          break;
        }
        if (this.stateTimer > POLICE.searchTimeout) {
          this.enterState('PATROL'); // 搜索超时：放弃，返回巡逻
        }
        break;
      }
    }

    // 驾驶输出
    let input: DriveInput;
    if (ctx.holdPosition) {
      // 停车：警察下车抓捕中，本车手刹驻停
      input = { throttle: false, brake: true, steer: 0, handbrake: true };
    } else if (this.reverseTimer > 0) {
      // 脱困倒车
      this.reverseTimer -= delta;
      input = { throttle: false, brake: true, steer: this.stuckSteer, handbrake: false };
    } else if (this.needTarget) {
      input = { throttle: false, brake: true, steer: 0, handbrake: false };
    } else if (
      this.state === 'CHASE' &&
      ctx.seesPlayer &&
      dist < 340 &&
      this.pathIdx >= this.path.length - 1
    ) {
      // 追捕末段：视野良好时直线逼近（开阔地/园区），建筑遮挡时仍走路径
      input = this.driveToward(ctx.playerX, ctx.playerY, cruise);
    } else {
      input = this.driveToPath(cruise);
    }

    // 卡死检测：想走但实际位移接近零 → 倒车脱困
    // （不能用速度判断：碰撞挤压时 update 每帧重设速度，速度非零但位移为零）
    const wantsMove = !this.needTarget && this.reverseTimer <= 0 && (input.throttle || input.steer !== 0);
    this.stuckCheckTimer += delta;
    if (this.stuckCheckTimer >= 250) {
      const moved = Math.hypot(this.x - this.lastStuckCheckX, this.y - this.lastStuckCheckY);
      if (wantsMove && moved < 10) this.stuckTimer += this.stuckCheckTimer;
      else {
        this.stuckTimer = Math.max(0, this.stuckTimer - this.stuckCheckTimer * 0.6);
        if (moved >= 10) this.stuckCount = Math.max(0, this.stuckCount - 1); // 正常移动：衰减卡死计数
      }
      this.lastStuckCheckX = this.x;
      this.lastStuckCheckY = this.y;
      this.stuckCheckTimer = 0;
    }
    if (this.stuckTimer > STUCK_MS) {
      this.reverseTimer = REVERSE_MS;
      this.stuckSteer = Math.random() < 0.5 ? -1 : 1;
      this.stuckTimer = 0;
      this.stuckCount++; // 触发脱困：累计卡死次数
      this.needTarget = true; // 脱困后重新寻路，避免反复撞同一障碍
    }

    // 输出给 Vehicle.update —— 与玩家驾驶完全同一套物理
    this.update(delta, input);
  }

  /** 停止警灯闪烁（巡逻状态） */
  lightsOff(): void {
    if (this.anims.isPlaying) this.anims.stop();
    this.setFrame(0);
  }

  /** 红蓝警灯交替闪烁（警戒/追捕/搜索状态） */
  lightsOn(): void {
    if (!this.anims.isPlaying || this.anims.currentAnim?.key !== 'police-flash') {
      this.play('police-flash');
    }
  }
}
