/**
 * HUD 场景：与游戏逻辑分离的界面层（游戏名 / 时钟 / 驾驶信息 / 交互提示 / 通缉星级）。
 * 通缉显示为经典 GTA 风格：右上方 WANTED 标签 + 五颗星，追捕/逃脱有横幅提示。
 * Phase 4.1：CASH / SCORE 经济显示、金钱浮动提示、最近交易记录、
 * 右下角实时小地图、导航状态（剩余距离）与屏外目标方向箭头。
 */
import * as Phaser from 'phaser';
import { MiniMapSystem } from '../systems/MiniMapSystem';
import type { GameScene } from './GameScene';

const STAR_ACTIVE = '#ffd76a';
const STAR_DIM = '#3a3f47';

export class HudScene extends Phaser.Scene {
  private nameText!: Phaser.GameObjects.Text;
  private clockText!: Phaser.GameObjects.Text;
  private helpText!: Phaser.GameObjects.Text;
  private driveText!: Phaser.GameObjects.Text;
  private cashText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private floatText!: Phaser.GameObjects.Text;
  private txText!: Phaser.GameObjects.Text;
  private promptText!: Phaser.GameObjects.Text;
  private wantedLabel!: Phaser.GameObjects.Text;
  private stars: Phaser.GameObjects.Text[] = [];
  private bannerText!: Phaser.GameObjects.Text;
  private volText!: Phaser.GameObjects.Text;
  private bannerTween?: Phaser.Tweens.Tween;
  private floatTween?: Phaser.Tweens.Tween;
  private prevWanted = 0;
  private lastFloatId = 0;

  // Phase 4.1：小地图 + 导航状态 + 屏外目标方向箭头
  private minimap?: MiniMapSystem;
  private navText!: Phaser.GameObjects.Text;
  private arrowGfx!: Phaser.GameObjects.Graphics;
  private gs?: GameScene; // 游戏主场景引用（worldCtx 注入）

  // Phase 3.1：抓捕进度条 + BUSTED 结算界面
  private arrestLabel!: Phaser.GameObjects.Text;
  private arrestBarBg!: Phaser.GameObjects.Rectangle;
  private arrestBarFill!: Phaser.GameObjects.Rectangle;
  private escapeText!: Phaser.GameObjects.Text;
  private escapeTween?: Phaser.Tweens.Tween;
  private bustedLayer!: Phaser.GameObjects.Container;
  private bustedDim!: Phaser.GameObjects.Rectangle;
  private bustedTitle!: Phaser.GameObjects.Text;
  private bustedSub!: Phaser.GameObjects.Text;
  private bustedInfo!: Phaser.GameObjects.Text;
  private respawnBtn!: Phaser.GameObjects.Text;

  constructor() {
    super('Hud');
  }

  create(): void {
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: '"Courier New", "Microsoft YaHei", monospace',
      color: '#f5f2e8',
      stroke: '#101216',
      strokeThickness: 4,
    };

    this.nameText = this.add
      .text(14, 10, 'RETRO CITY', { ...style, fontSize: '24px', fontStyle: 'bold' })
      .setLetterSpacing(4);

    this.clockText = this.add
      .text(0, 14, this.registry.get('clock') ?? '', { ...style, fontSize: '18px', fontStyle: 'bold' })
      .setOrigin(1, 0);

    this.driveText = this.add.text(14, 40, this.registry.get('drive') ?? '', {
      ...style,
      fontSize: '16px',
      fontStyle: 'bold',
      color: '#ffd76a',
    });

    // 现金（Phase 3.1 金钱基础状态）+ 积分 / 交易记录（Phase 4.1 经济系统）
    this.cashText = this.add.text(14, 62, '', { ...style, fontSize: '16px', fontStyle: 'bold', color: '#7ad46a' });
    this.scoreText = this.add.text(14, 84, '', { ...style, fontSize: '14px', fontStyle: 'bold', color: '#ffd76a' });
    this.txText = this.add.text(14, 106, '', { ...style, fontSize: '12px', color: '#9aa3ad', lineSpacing: 3 });
    // 金钱浮动提示（现金行右侧，上浮渐隐）
    this.floatText = this.add.text(170, 62, '', { ...style, fontSize: '15px', fontStyle: 'bold', color: '#7ad46a' });

    // 导航状态（小地图上方）+ 屏外目标方向箭头
    this.navText = this.add
      .text(0, 0, '', { ...style, fontSize: '13px', fontStyle: 'bold', color: '#e65ad4' })
      .setOrigin(1, 1);
    this.arrowGfx = this.add.graphics();

    // Phase 4.1：右下角实时小地图（worldCtx 由 GameScene.create 注入）
    const ctx = this.registry.get('worldCtx') as { game?: GameScene } | undefined;
    if (ctx?.game) {
      this.gs = ctx.game;
      this.minimap = new MiniMapSystem(this, ctx.game);
    }

    this.helpText = this.add.text(14, 0, this.registry.get('help') ?? '', {
      ...style,
      fontSize: '14px',
      color: '#b9c2cf',
    });

    this.promptText = this.add
      .text(0, 0, this.registry.get('prompt') ?? '', { ...style, fontSize: '16px', fontStyle: 'bold', color: '#ffffff' })
      .setOrigin(0.5, 1);

    // 通缉星级：右上方 WANTED 标签 + 五颗星
    this.wantedLabel = this.add
      .text(0, 42, 'WANTED', { ...style, fontSize: '13px', fontStyle: 'bold', color: '#ff6a5a' })
      .setOrigin(1, 0)
      .setAlpha(0.9);
    for (let i = 0; i < 5; i++) {
      const star = this.add
        .text(0, 60, '★', { ...style, fontSize: '24px', fontStyle: 'bold', color: STAR_DIM })
        .setOrigin(0, 0);
      this.stars.push(star);
    }

    // 追捕/逃脱横幅
    this.bannerText = this.add
      .text(0, 94, '', { ...style, fontSize: '20px', fontStyle: 'bold', color: '#ffffff' })
      .setOrigin(1, 0);

    // 音量指示（右下角）
    this.volText = this.add
      .text(0, 0, '', { ...style, fontSize: '13px', color: '#b9c2cf' })
      .setOrigin(1, 0);

    // Phase 3.1：抓捕进度条（屏幕下方中央，复古像素风）
    this.arrestLabel = this.add
      .text(0, 0, 'POLICE ARRESTING', { ...style, fontSize: '15px', fontStyle: 'bold', color: '#ff5a4a' })
      .setOrigin(0.5, 1)
      .setVisible(false);
    this.arrestBarBg = this.add.rectangle(0, 0, 224, 14, 0x101216, 0.75).setStrokeStyle(2, 0xb9c2cf).setVisible(false);
    this.arrestBarFill = this.add.rectangle(0, 0, 0, 10, 0xff5a4a).setVisible(false);
    this.escapeText = this.add
      .text(0, 0, 'ESCAPE NOW!', { ...style, fontSize: '15px', fontStyle: 'bold', color: '#ffd76a' })
      .setOrigin(0.5, 0)
      .setVisible(false);

    // Phase 3.1：BUSTED 结算界面（默认隐藏）
    this.bustedDim = this.add.rectangle(0, 0, 1, 1, 0x000000, 0.62).setOrigin(0, 0).setVisible(false);
    this.bustedTitle = this.add
      .text(0, 0, 'BUSTED!', { ...style, fontSize: '54px', fontStyle: 'bold', color: '#ff3b2f' })
      .setOrigin(0.5, 0.5)
      .setVisible(false);
    this.bustedSub = this.add
      .text(0, 0, 'YOU HAVE BEEN ARRESTED', { ...style, fontSize: '16px', color: '#f5f2e8' })
      .setOrigin(0.5, 0.5)
      .setVisible(false);
    this.bustedInfo = this.add
      .text(0, 0, '', { ...style, fontSize: '15px', color: '#d9dee6', align: 'center', lineSpacing: 6 })
      .setOrigin(0.5, 0.5)
      .setVisible(false);
    this.respawnBtn = this.add
      .text(0, 0, '▶ RESPAWN ◀', { ...style, fontSize: '20px', fontStyle: 'bold', color: '#ffd76a' })
      .setOrigin(0.5, 0.5)
      .setVisible(false)
      .setInteractive({ useHandCursor: true });
    this.respawnBtn.on('pointerover', () => this.respawnBtn.setColor('#ffffff'));
    this.respawnBtn.on('pointerout', () => this.respawnBtn.setColor('#ffd76a'));
    this.respawnBtn.on('pointerup', () => {
      if (this.bustedLayer?.visible) this.registry.set('respawnReq', true);
    });
    this.bustedLayer = this.add.container(0, 0, [
      this.bustedDim,
      this.bustedTitle,
      this.bustedSub,
      this.bustedInfo,
      this.respawnBtn,
    ]).setVisible(false);

    this.registry.events.on('changedata', this.onDataChanged, this);
    this.scale.on('resize', this.layout, this);
    this.layout();

    // 初始星级（热重载时 registry 可能已有值）
    const initWanted = Number(this.registry.get('wanted') ?? 0);
    this.applyStars(initWanted, false);
    this.prevWanted = initWanted;
    this.cashText.setText(`$ ${Number(this.registry.get('cash') ?? 0)}`);
    this.scoreText.setText(`SCORE ${String(Number(this.registry.get('score') ?? 0)).padStart(6, '0')}`);

    // 切回游戏场景继续接收键盘输入
    this.input.keyboard!.disableGlobalCapture();
  }

  private onDataChanged(_parent: Phaser.Scenes.ScenePlugin, key: string, value: unknown): void {
    const v = String(value ?? '');
    if (key === 'clock') this.clockText.setText(v);
    else if (key === 'drive') this.driveText.setText(v);
    else if (key === 'cash') this.cashText.setText(`$ ${Number(value ?? 0)}`);
    else if (key === 'score')
      this.scoreText.setText(`SCORE ${String(Number(value ?? 0)).padStart(6, '0')}`);
    else if (key === 'float') this.applyFloat(value as { id: number; amount: number; label: string });
    else if (key === 'tx') this.txText.setText((value as string[] | undefined ?? []).join('\n'));
    else if (key === 'help') this.helpText.setText(v);
    else if (key === 'prompt') this.promptText.setText(v);
    else if (key === 'vol') this.volText.setText(`♪ ${v} · N 静音 · [ ] 音量`);
    else if (key === 'arrest')
      this.applyArrest(
        (value as { active: boolean; progress: number; phase?: string }) ?? { active: false, progress: 0 }
      );
    else if (key === 'busted') this.applyBusted(value as { show: boolean; level: number; fine: number; seized: boolean; vehicleName: string; cash: number });
    else if (key === 'wanted') {
      const lv = Number(value ?? 0);
      this.applyStars(lv, lv > this.prevWanted ? 'up' : lv < this.prevWanted ? 'down' : false);
      this.prevWanted = lv;
    } else if (key === 'banner') {
      const b = (value ?? { text: '', color: '#ffffff' }) as { text: string; color: string };
      this.bannerText.setText(b.text);
      this.bannerText.setColor(b.color);
      this.bannerText.setScale(1);
      this.bannerTween?.remove();
      this.bannerTween = undefined;
      if (b.text === 'POLICE CHASE') {
        // 追捕横幅持续闪烁
        this.bannerTween = this.tweens.add({
          targets: this.bannerText,
          alpha: { from: 1, to: 0.25 },
          duration: 260,
          yoyo: true,
          repeat: -1,
        });
      } else if (b.text === 'ESCAPED') {
        // 逃脱横幅弹出
        this.bannerText.setScale(1.4);
        this.bannerTween = this.tweens.add({ targets: this.bannerText, scale: 1, duration: 320, ease: 'Back.easeOut' });
      } else if (b.text) {
        this.bannerText.setAlpha(0.9);
      } else {
        this.bannerText.setAlpha(1);
      }
    }
  }

  /** 金钱浮动提示：+$xx 绿色上浮 / -$xx 红色下沉（复古像素风） */
  private applyFloat(f: { id: number; amount: number; label: string } | undefined): void {
    if (!f || f.id === this.lastFloatId) return;
    this.lastFloatId = f.id;
    const positive = f.amount >= 0;
    this.floatText.setText(`${positive ? '+' : '-'}$${Math.abs(f.amount)} ${f.label}`);
    this.floatText.setColor(positive ? '#7ad46a' : '#ff5a4a');
    this.floatText.setAlpha(1);
    this.floatText.y = 62;
    this.floatTween?.remove();
    this.floatTween = this.tweens.add({
      targets: this.floatText,
      y: positive ? 46 : 78,
      alpha: 0,
      duration: 1600,
      ease: 'Sine.easeOut',
      onComplete: () => this.floatText.setText(''),
    });
  }

  /** 每帧：小地图重绘（节流）+ 导航状态文本 + 屏外目标方向箭头 */
  update(_time: number, delta: number): void {
    this.minimap?.update(delta);
    const g = this.gs;
    if (!g) return;

    // 导航状态文本（小地图上方）
    const nav = g.navigation;
    const w = this.scale.width;
    const h = this.scale.height;
    if (nav.active) {
      const distM = Math.round(nav.distRemaining / 32); // 1 tile ≈ 1m
      this.navText.setText(nav.arrived ? '▶ DESTINATION REACHED' : `NAV ▸ ${distM}M · X CANCEL`);
      this.navText.setVisible(true);
    } else {
      this.navText.setVisible(false);
    }
    this.navText.setPosition(w - 12 - 4, h - 12 - 176);

    // 屏外目标方向箭头：目标在主摄像机视野外时，屏幕边缘显示指向箭头
    this.arrowGfx.clear();
    if (nav.active && nav.target && !nav.arrived) {
      const view = g.cameras.main.worldView;
      const t = nav.target;
      if (!view.contains(t.x, t.y)) {
        const angle = Math.atan2(t.y - view.centerY, t.x - view.centerX);
        // 箭头锚定在屏幕中央向目标方向偏移的椭圆边界上
        const rx = w * 0.38;
        const ry = h * 0.36;
        const ax = w / 2 + Math.cos(angle) * rx;
        const ay = h / 2 + Math.sin(angle) * ry;
        const rot = (x: number, y: number): { x: number; y: number } => ({
          x: x * Math.cos(angle) - y * Math.sin(angle),
          y: x * Math.sin(angle) + y * Math.cos(angle),
        });
        const p0 = rot(12, 0);
        const p1 = rot(-7, 8);
        const p2 = rot(-7, -8);
        this.arrowGfx.fillStyle(0xe65ad4, 0.9);
        this.arrowGfx.beginPath();
        this.arrowGfx.moveTo(ax + p0.x, ay + p0.y);
        this.arrowGfx.lineTo(ax + p1.x, ay + p1.y);
        this.arrowGfx.lineTo(ax + p2.x, ay + p2.y);
        this.arrowGfx.closePath();
        this.arrowGfx.fillPath();
      }
    }
  }

  /** 更新五颗星：当前等级高亮，未激活暗色；升降级带动画反馈 */
  private applyStars(level: number, anim: 'up' | 'down' | false): void {
    for (let i = 0; i < this.stars.length; i++) {
      const star = this.stars[i];
      const active = i < level;
      star.setColor(active ? STAR_ACTIVE : STAR_DIM);
      if (anim === 'up' && active && i === level - 1) {
        // 新点亮的星：弹跳 + 白闪
        star.setScale(2);
        this.tweens.add({ targets: star, scale: 1, duration: 340, ease: 'Back.easeOut' });
        this.tweens.add({
          targets: star,
          alpha: { from: 0.1, to: 1 },
          duration: 120,
          yoyo: true,
          repeat: 2,
          onComplete: () => star.setAlpha(1),
        });
      } else if (anim === 'down' && !active && i === level) {
        // 刚熄灭的星：快速淡出
        star.setScale(1.3);
        this.tweens.add({ targets: star, scale: 1, duration: 220 });
      }
    }
  }

  /** 抓捕提示：POLICE APPROACHING（警察接近中）/ POLICE ARRESTING + 进度条 + ESCAPE NOW! */
  private applyArrest(a: { active: boolean; progress: number; phase?: string }): void {
    const w = this.scale.width;
    const h = this.scale.height;
    const show = a.phase === 'approach' || (a.active && a.progress > 0);
    this.arrestLabel.setVisible(show);
    const arresting = a.active && a.progress > 0;
    this.arrestBarBg.setVisible(arresting);
    this.arrestBarFill.setVisible(arresting);
    this.escapeText.setVisible(arresting);
    this.arrestLabel.setText(arresting ? 'POLICE ARRESTING' : 'POLICE APPROACHING');
    if (!show) {
      this.escapeTween?.remove();
      this.escapeTween = undefined;
      return;
    }
    this.arrestLabel.setPosition(w / 2, h - 104);
    this.arrestBarBg.setPosition(w / 2, h - 94);
    const fillW = Math.max(4, Math.round((a.progress / 100) * 220));
    this.arrestBarFill.setSize(fillW, 10);
    this.arrestBarFill.setPosition(w / 2 - 110 + fillW / 2, h - 94);
    this.escapeText.setPosition(w / 2, h - 84);
    if (arresting && !this.escapeTween) {
      this.escapeTween = this.tweens.add({
        targets: this.escapeText,
        alpha: { from: 1, to: 0.25 },
        duration: 300,
        yoyo: true,
        repeat: -1,
      });
    } else if (!arresting && this.escapeTween) {
      this.escapeTween.remove();
      this.escapeTween = undefined;
    }
  }

  /** BUSTED 结算界面：暗色遮罩 + 大标题 + 结算明细 + RESPAWN 按钮 */
  private applyBusted(b: {
    show: boolean;
    level: number;
    fine: number;
    seized: boolean;
    vehicleName: string;
    cash: number;
  }): void {
    const w = this.scale.width;
    const h = this.scale.height;
    // 容器与子元素一起切换（子元素创建时被单独隐藏，仅切容器不会显示）
    this.bustedLayer.setVisible(b.show);
    this.bustedDim.setVisible(b.show);
    this.bustedTitle.setVisible(b.show);
    this.bustedSub.setVisible(b.show);
    this.bustedInfo.setVisible(b.show);
    this.respawnBtn.setVisible(b.show);
    if (!b.show) return;
    this.bustedDim.setSize(w, h);
    const stars = '★'.repeat(Math.max(0, Math.min(5, b.level))) || '—';
    this.bustedInfo.setText(
      [
        `WANTED LEVEL  ${stars}`,
        `FINE          -$${b.fine}`,
        `VEHICLE       ${b.seized ? `${b.vehicleName} (SEIZED)` : 'NONE'}`,
        `CASH          $${b.cash}`,
      ].join('\n')
    );
    const cy = h / 2;
    this.bustedTitle.setPosition(w / 2, cy - 90);
    this.bustedSub.setPosition(w / 2, cy - 44);
    this.bustedInfo.setPosition(w / 2, cy + 24);
    this.respawnBtn.setPosition(w / 2, cy + 108);
    // 标题弹入动画
    this.bustedTitle.setScale(0.4);
    this.tweens.add({ targets: this.bustedTitle, scale: 1, duration: 360, ease: 'Back.easeOut' });
  }

  private layout(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    this.clockText.setPosition(w - 14, 14);
    this.helpText.setPosition(14, h - 30);
    this.promptText.setPosition(w / 2, h - 60);
    this.wantedLabel.setPosition(w - 14, 42);
    for (let i = 0; i < this.stars.length; i++) {
      this.stars[i].setPosition(w - 14 - (5 - i) * 26, 60);
    }
    this.bannerText.setPosition(w - 14, 94);
    // 音量指示移至左下角（右下角让位给小地图）
    this.volText.setOrigin(0, 0);
    this.volText.setPosition(14, h - 52);
    this.minimap?.layout();
    // 抓捕进度条
    this.arrestLabel.setPosition(w / 2, h - 104);
    this.arrestBarBg.setPosition(w / 2, h - 94);
    this.escapeText.setPosition(w / 2, h - 84);
    // BUSTED 界面
    this.bustedDim.setSize(w, h);
    const cy = h / 2;
    this.bustedTitle.setPosition(w / 2, cy - 90);
    this.bustedSub.setPosition(w / 2, cy - 44);
    this.bustedInfo.setPosition(w / 2, cy + 24);
    this.respawnBtn.setPosition(w / 2, cy + 108);
  }
}
