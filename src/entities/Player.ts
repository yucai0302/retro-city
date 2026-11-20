/**
 * 玩家：WASD / 方向键移动，四方向行走动画，与建筑碰撞。
 */
import * as Phaser from 'phaser';
import { PLAYER_SPEED, DIR_NAMES, DIR_VEC } from '../config';

export class Player extends Phaser.Physics.Arcade.Sprite {
  private facing = 0; // 0 下 1 上 2 左 3 右
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd: Record<'W' | 'A' | 'S' | 'D', Phaser.Input.Keyboard.Key>;

  /** 当前朝向对应的世界角度（弧度，供小地图方向箭头使用） */
  get facingAngle(): number {
    const [vx, vy] = DIR_VEC[this.facing];
    return Math.atan2(vy, vx);
  }

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'hero');
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(5);

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setSize(16, 14);
    body.setOffset(8, 17);
    this.setCollideWorldBounds(true);

    const kb = scene.input.keyboard!;
    this.cursors = kb.createCursorKeys();
    this.wasd = kb.addKeys('W,A,S,D') as Record<'W' | 'A' | 'S' | 'D', Phaser.Input.Keyboard.Key>;
  }

  update(): void {
    const down = this.cursors.down.isDown || this.wasd.S.isDown;
    const up = this.cursors.up.isDown || this.wasd.W.isDown;
    const left = this.cursors.left.isDown || this.wasd.A.isDown;
    const right = this.cursors.right.isDown || this.wasd.D.isDown;

    let vx = (right ? 1 : 0) - (left ? 1 : 0);
    let vy = (down ? 1 : 0) - (up ? 1 : 0);

    const body = this.body as Phaser.Physics.Arcade.Body;
    if (vx !== 0 || vy !== 0) {
      if (vx !== 0 && vy !== 0) {
        const inv = Math.SQRT1_2;
        vx *= inv;
        vy *= inv;
      }
      body.setVelocity(vx * PLAYER_SPEED, vy * PLAYER_SPEED);
      // 主方向决定朝向与动画
      if (Math.abs(vx) > Math.abs(vy)) {
        this.facing = vx > 0 ? 3 : 2;
      } else {
        this.facing = vy > 0 ? 0 : 1;
      }
      this.play(`hero-${DIR_NAMES[this.facing]}`, true);
    } else {
      body.setVelocity(0, 0);
      this.anims.stop();
      this.setFrame(this.facing * 4 + 1);
    }
  }
}
