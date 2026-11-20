/**
 * 车辆实体：俯视角驾驶物理。
 * 模型：把车体速度分解为"前向速度 vf + 侧向速度 vl"，
 * 侧向速度按抓地力快速衰减（手刹时衰减变慢 → 漂移），
 * 转向速率随速度变化（低速灵敏 / 高速迟钝），倒车转向自动反向。
 * 旋转角 0 = 车头朝上（北），前向向量 = (sin r, -cos r)。
 */
import * as Phaser from 'phaser';
import { WORLD_W, WORLD_H } from '../config';

export type VehicleKind = 'sedan' | 'sports' | 'taxi' | 'truck' | 'police';

export interface VehicleSpec {
  key: string;
  name: string;
  bodyW: number; // 碰撞体宽（垂直于车头方向）
  bodyL: number; // 碰撞体长（沿车头方向）
  maxSpeed: number; // 最大前进速度 px/s
  reverseMax: number; // 最大倒车速度
  accel: number; // 加速度
  brake: number; // 制动减速度
  coast: number; // 松开油门后的自然摩擦减速
  turnRate: number; // 基础转向速率 rad/s
  grip: number; // 侧向抓地（衰减速率）
}

export const VEHICLE_SPECS: Record<VehicleKind, VehicleSpec> = {
  sedan: { key: 'car-sedan', name: 'SEDAN', bodyW: 22, bodyL: 44, maxSpeed: 300, reverseMax: 130, accel: 210, brake: 480, coast: 130, turnRate: 2.7, grip: 8 },
  sports: { key: 'car-sports', name: 'SPORTS', bodyW: 22, bodyL: 40, maxSpeed: 400, reverseMax: 140, accel: 300, brake: 520, coast: 110, turnRate: 3.3, grip: 9 },
  taxi: { key: 'car-taxi', name: 'TAXI', bodyW: 22, bodyL: 44, maxSpeed: 320, reverseMax: 130, accel: 240, brake: 500, coast: 130, turnRate: 2.9, grip: 8.5 },
  truck: { key: 'car-truck', name: 'TRUCK', bodyW: 26, bodyL: 56, maxSpeed: 220, reverseMax: 100, accel: 130, brake: 380, coast: 150, turnRate: 1.8, grip: 7 },
  // 警车：速度快、转向灵，专供 Police AI 驾驶（由 PoliceManager 生成，不在民用车辆中随机出现）
  police: { key: 'car-police', name: 'POLICE', bodyW: 22, bodyL: 44, maxSpeed: 340, reverseMax: 130, accel: 250, brake: 520, coast: 140, turnRate: 2.9, grip: 8.5 },
};

export interface DriveInput {
  throttle: boolean; // W 加速
  brake: boolean; // S 刹车/倒车
  steer: number; // -1 左转 / 1 右转
  handbrake: boolean; // SPACE 手刹
}

export class Vehicle extends Phaser.Physics.Arcade.Sprite {
  readonly spec: VehicleSpec;
  readonly kind: VehicleKind;
  driven = false;
  private expectedSpeed = 0;
  private lastImpact = 0;
  private crashHandler: ((impact: number) => void) | null = null;

  constructor(scene: Phaser.Scene, x: number, y: number, kind: VehicleKind, rotation = 0, texKey?: string) {
    super(scene, x, y, texKey ?? VEHICLE_SPECS[kind].key);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(4);
    this.kind = kind;
    this.spec = VEHICLE_SPECS[kind];

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setCollideWorldBounds(true);
    // 停放状态完全静态：immovable + moves=false，人物和其他车辆都无法推动
    body.setImmovable(true);
    body.moves = false;
    this.setRotation(rotation);
    this.applyBodySize();
  }

  /** 停放/启动切换：停放时完全静止不可推动，驾驶时可移动 */
  setParked(parked: boolean): void {
    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setImmovable(parked);
    body.moves = !parked;
    if (parked) this.halt();
  }

  /** 根据车头朝向切换碰撞体尺寸（车长/车宽随朝向对调） */
  private applyBodySize(): void {
    const vertical = Math.abs(Math.cos(this.rotation)) >= Math.abs(Math.sin(this.rotation));
    const w = vertical ? this.spec.bodyW : this.spec.bodyL;
    const h = vertical ? this.spec.bodyL : this.spec.bodyW;
    (this.body as Phaser.Physics.Arcade.Body).setSize(w, h, true);
  }

  get forwardVector(): [number, number] {
    return [Math.sin(this.rotation), -Math.cos(this.rotation)];
  }

  get speed(): number {
    const v = (this.body as Phaser.Physics.Arcade.Body).velocity;
    return Math.hypot(v.x, v.y);
  }

  setCrashHandler(fn: (impact: number) => void): void {
    this.crashHandler = fn;
  }

  /** 碰撞回调（由 collider 触发）：重撞击时损失速度并通知场景做震屏反馈 */
  noteImpact(time: number): void {
    const impact = this.expectedSpeed - this.speed;
    if (impact < 90 || time - this.lastImpact < 260) return;
    this.lastImpact = time;

    const b = this.body as Phaser.Physics.Arcade.Body;
    const [fx, fy] = this.forwardVector;
    const rx = Math.cos(this.rotation);
    const ry = Math.sin(this.rotation);
    let vf = b.velocity.x * fx + b.velocity.y * fy;
    let vl = b.velocity.x * rx + b.velocity.y * ry;
    vf *= 0.35; // 正撞：前向动能大幅损失
    vl *= 0.5;
    b.setVelocity(fx * vf + rx * vl, fy * vf + ry * vl);
    if (this.crashHandler) this.crashHandler(impact);
  }

  /** 最近一次踩油门的时间戳（scene time）：用于区分玩家主动撞击与被警车推撞 */
  lastThrottleAt = -1e9;

  update(delta: number, input: DriveInput | null): void {
    // 停放车辆不做任何速度处理，保持完全静止
    if (!this.driven) {
      this.expectedSpeed = 0;
      return;
    }
    const dt = Math.min(delta, 50) / 1000;
    const b = this.body as Phaser.Physics.Arcade.Body;
    const s = this.spec;
    const [fx, fy] = this.forwardVector;
    const rx = Math.cos(this.rotation);
    const ry = Math.sin(this.rotation);
    // 从碰撞后的真实速度反推前向/侧向分量（碰撞效果天然保留）
    let vf = b.velocity.x * fx + b.velocity.y * fy;
    let vl = b.velocity.x * rx + b.velocity.y * ry;

    if (input) {
      if (input.throttle) this.lastThrottleAt = this.scene.time.now;
      // 油门 / 刹车 / 倒车
      if (input.throttle && !input.brake) {
        vf = Math.min(vf + s.accel * dt, s.maxSpeed);
      } else if (input.brake) {
        if (vf > 5) {
          vf = Math.max(vf - s.brake * dt, 0);
        } else {
          vf = Math.max(vf - s.accel * 0.55 * dt, -s.reverseMax); // 倒车
        }
      }
      if (input.handbrake) {
        vf -= Math.sign(vf) * Math.min(Math.abs(vf), s.brake * 1.6 * dt);
      }
      // 转向：低速灵敏，高速迟钝；倒车时方向反转（符合真实操控）
      const spd = Math.abs(vf);
      let steerEff = s.turnRate * Math.min(1, spd / 80) * (1.12 - 0.4 * Math.min(1, spd / s.maxSpeed));
      if (input.handbrake) steerEff *= 1.35;
      if (input.steer !== 0 && spd > 2) {
        this.rotation += input.steer * steerEff * dt * (vf < 0 ? -1 : 1);
      }
    } else {
      // 停放 / 滑行：摩擦自然减速
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), s.coast * dt);
    }

    // 侧向抓地：手刹时抓地下降 → 轻微漂移
    const grip = input?.handbrake ? s.grip * 0.28 : s.grip;
    vl -= vl * Math.min(1, grip * dt);

    // 用旋转后的新朝向重组世界速度
    const nfx = Math.sin(this.rotation);
    const nfy = -Math.cos(this.rotation);
    const nrx = Math.cos(this.rotation);
    const nry = Math.sin(this.rotation);
    const wvx = nfx * vf + nrx * vl;
    const wvy = nfy * vf + nry * vl;
    b.setVelocity(wvx, wvy);
    this.expectedSpeed = Math.hypot(wvx, wvy);

    if (this.driven) {
      this.applyBodySize();
      // 双保险：世界边界钳制（防止异常情况下驶出地图）
      this.x = Phaser.Math.Clamp(this.x, 14, WORLD_W - 14);
      this.y = Phaser.Math.Clamp(this.y, 14, WORLD_H - 14);
    }
  }

  halt(): void {
    (this.body as Phaser.Physics.Arcade.Body).setVelocity(0, 0);
    this.expectedSpeed = 0;
  }
}
