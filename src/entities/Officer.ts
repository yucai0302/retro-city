/**
 * 步行警察：警车靠近步行玩家后下车追捕的警察实体。
 * - 复用 NPC 行走动画帧（tint 警服蓝），零新增美术。
 * - 简单采样避障（前方不可行走则偏转），加物理碰撞体，绝不穿建筑。
 * - 抓捕判定使用警察自身坐标（ArrestSystem），与警车坐标无关。
 */
import * as Phaser from 'phaser';
import { DIR_NAMES, ARREST } from '../config';
import { CityGenerator } from '../systems/CityGenerator';
import { Vehicle } from './Vehicle';

type OfficerState = 'DEPLOY' | 'PURSUE' | 'RETURN';

export class Officer extends Phaser.Physics.Arcade.Sprite {
  state: OfficerState = 'DEPLOY';
  returnTimer = 0;

  private gen: CityGenerator;
  private car: Vehicle;
  private deployX: number;
  private deployY: number;

  constructor(scene: Phaser.Scene, x: number, y: number, gen: CityGenerator, car: Vehicle) {
    super(scene, x, y, 'npc0');
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(5);
    this.setTint(0x3557c9); // 警服蓝
    this.gen = gen;
    this.car = car;

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setSize(14, 12);
    body.setOffset(9, 18);
    body.setCollideWorldBounds(true);

    // 下车点：警车侧面
    const fx = Math.sin(car.rotation);
    const fy = -Math.cos(car.rotation);
    this.deployX = car.x + -fy * 30;
    this.deployY = car.y + fx * 30;
    this.state = 'DEPLOY';
  }

  /** 是否已到达下车点（进入 PURSUE） */
  get deployed(): boolean {
    return this.state !== 'DEPLOY';
  }

  update(delta: number, playerX: number, playerY: number): void {
    if (this.state === 'RETURN') this.returnTimer += delta;

    switch (this.state) {
      case 'DEPLOY': {
        if (this.stepToward(this.deployX, this.deployY, true)) this.state = 'PURSUE';
        break;
      }
      case 'PURSUE': {
        const d = Math.hypot(playerX - this.x, playerY - this.y);
        // 玩家拉太远：撤回警车
        if (d > ARREST.officerCatchRange) {
          this.state = 'RETURN';
          this.returnTimer = 0;
          break;
        }
        this.stepToward(playerX, playerY, false);
        break;
      }
      case 'RETURN': {
        if (this.stepToward(this.car.x, this.car.y, true)) {
          this.emit('arrived-car'); // 到达警车旁：由 PoliceManager 移除
        }
        break;
      }
    }
  }

  /** 警察可站立：人行道或道路（不允许进建筑） */
  private canStand(px: number, py: number): boolean {
    const tx = Math.floor(px / 32);
    const ty = Math.floor(py / 32);
    const g = this.gen;
    const road = (g.inH[ty] && g.inH[ty][tx]) || (g.inV[ty] && g.inV[ty][tx]);
    return road || g.isWalkablePx(px, py);
  }

  /**
   * 朝目标移动（速度恒定），带采样避障。
   * @returns 是否已到达目标附近
   */
  private stepToward(tx: number, ty: number, arriveEarly: boolean): boolean {
    const b = this.body as Phaser.Physics.Arcade.Body;
    const dx = tx - this.x;
    const dy = ty - this.y;
    const d = Math.hypot(dx, dy);
    if (d < (arriveEarly ? 12 : 6)) {
      b.setVelocity(0, 0);
      this.anims.stop();
      return true;
    }
    // 避障：理想方向被建筑挡住时依次尝试偏转角
    // （警察可以走道路：可站立 = 非建筑（人行道或道路））
    const base = Math.atan2(dy, dx);
    const offsets = [0, 0.55, -0.55, 1.1, -1.1, 1.7, -1.7, 2.4, -2.4];
    let ang = base;
    let found = false;
    for (const off of offsets) {
      const a = base + off;
      const px = this.x + Math.cos(a) * 22;
      const py = this.y + Math.sin(a) * 22;
      if (this.canStand(px, py)) {
        ang = a;
        found = true;
        break;
      }
    }
    if (!found) {
      b.setVelocity(0, 0);
      this.anims.stop();
      return false;
    }
    b.setVelocity(Math.cos(ang) * ARREST.officerSpeed, Math.sin(ang) * ARREST.officerSpeed);
    // 行走动画按主方向
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const dir = Math.abs(c) > Math.abs(s) ? (c > 0 ? 3 : 2) : s > 0 ? 0 : 1;
    this.play(`npc0-${DIR_NAMES[dir]}`, true);
    return false;
  }
}
