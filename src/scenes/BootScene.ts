/**
 * 启动场景：生成全部像素素材与动画，预加载程序化音效，然后进入游戏场景。
 */
import * as Phaser from 'phaser';
import { createTextures, createWalkAnims, createPoliceAnims } from '../systems/TextureFactory';
import { buildSfx } from '../systems/SfxFactory';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    createTextures(this);
    createWalkAnims(this);
    createPoliceAnims(this);
    // 程序化合成的音效（WAV data URI）加入加载队列
    for (const [key, uri] of Object.entries(buildSfx())) {
      this.load.audio(key, uri);
    }
    this.load.once('complete', () => this.scene.start('Game'));
    this.load.start();
  }
}
