/**
 * NPC 管理：在城市人行道/公园/广场生成行人，随机游走。
 * 遇到建筑或不可行走区域时自动换向，不穿墙。
 */
import * as Phaser from 'phaser';
import { TILE, NPC_COUNT, DIR_NAMES, DIR_VEC } from '../config';
import { CityGenerator } from './CityGenerator';
import { NPC_VARIANTS } from './TextureFactory';

interface Walker {
  sprite: Phaser.Physics.Arcade.Sprite;
  body: Phaser.Physics.Arcade.Body;
  variant: number;
  dir: number;
  speed: number;
  timer: number;
}

const LOOK_AHEAD = 26; // 前方探测距离（像素）

export class NPCManager {
  readonly group: Phaser.Physics.Arcade.Group;
  private walkers: Walker[] = [];
  private gen: CityGenerator;
  private scene: Phaser.Scene;

  constructor(scene: Phaser.Scene, gen: CityGenerator) {
    this.scene = scene;
    this.gen = gen;
    this.group = scene.physics.add.group();

    for (let i = 0; i < NPC_COUNT; i++) {
      const spawn = gen.randomWalkableTile();
      const variant = Phaser.Math.Between(0, NPC_VARIANTS - 1);
      const sprite = scene.physics.add.sprite(
        spawn.tx * TILE + TILE / 2,
        spawn.ty * TILE + TILE / 2,
        `npc${variant}`
      );
      sprite.setDepth(4);
      this.group.add(sprite);

      const body = sprite.body as Phaser.Physics.Arcade.Body;
      body.setSize(14, 12);
      body.setOffset(9, 18);
      sprite.setCollideWorldBounds(true);

      const walker: Walker = {
        sprite,
        body,
        variant,
        dir: Phaser.Math.Between(0, 3),
        speed: Phaser.Math.Between(38, 72),
        timer: Phaser.Math.Between(1000, 4000),
      };
      // 初始方向必须可行走，否则待机
      if (!this.canGo(walker, walker.dir)) walker.dir = -1;
      this.walkers.push(walker);
    }
  }

  private canGo(w: Walker, dir: number): boolean {
    if (dir < 0) return false;
    const vec = DIR_VEC[dir];
    return this.gen.isWalkablePx(w.sprite.x + vec[0] * LOOK_AHEAD, w.sprite.y + vec[1] * LOOK_AHEAD);
  }

  private pickDir(w: Walker): void {
    const candidates: number[] = [];
    for (let d = 0; d < 4; d++) {
      if (d !== this.opposite(w.dir) && this.canGo(w, d)) candidates.push(d);
    }
    if (candidates.length === 0) {
      for (let d = 0; d < 4; d++) {
        if (this.canGo(w, d)) candidates.push(d);
      }
    }
    if (candidates.length === 0) {
      w.dir = -1; // 四面受阻，短暂待机
      w.timer = 600;
      return;
    }
    w.dir = Phaser.Utils.Array.GetRandom(candidates);
    w.timer = Phaser.Math.Between(1500, 4500);
  }

  private opposite(dir: number): number {
    if (dir < 0) return -1;
    return [1, 0, 3, 2][dir];
  }

  update(delta: number): void {
    for (const w of this.walkers) {
      w.timer -= delta;
      const blocked =
        w.body.blocked.down || w.body.blocked.up || w.body.blocked.left || w.body.blocked.right;

      if (blocked || (w.timer <= 0 && w.dir >= 0)) {
        this.pickDir(w);
      } else if (w.dir >= 0 && !this.canGo(w, w.dir)) {
        this.pickDir(w);
      }

      if (w.dir >= 0) {
        const vec = DIR_VEC[w.dir];
        w.body.setVelocity(vec[0] * w.speed, vec[1] * w.speed);
        w.sprite.play(`npc${w.variant}-${DIR_NAMES[w.dir]}`, true);
      } else {
        w.body.setVelocity(0, 0);
        w.sprite.anims.stop();
      }
    }
  }

  /**
   * NPC 被击败（玩家驾车高速撞击）：停止 AI、原地倒地。
   * 精灵保留在场景中作为"倒地"状态，可供现金掉落系统引用；
   * 每个 NPC 只会进入一次该状态（walkers 中移除后不可重复触发）。
   * @returns 是否首次击败
   */
  defeat(sprite: Phaser.Physics.Arcade.Sprite): boolean {
    const idx = this.walkers.findIndex((w) => w.sprite === sprite);
    if (idx < 0) return false; // 已击败过
    const w = this.walkers[idx];
    this.walkers.splice(idx, 1);
    w.body.setVelocity(0, 0);
    w.body.enable = false;
    w.sprite.anims.stop();
    w.sprite.setAngle(90); // 倒地
    w.sprite.setAlpha(0.75);
    w.sprite.setDepth(3); // 压在站立实体之下
    return true;
  }
}
