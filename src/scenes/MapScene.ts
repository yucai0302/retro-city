/**
 * 完整城市地图（M 键打开）：
 * - 展示完整 3200x3200 城市（预渲染 4px/tile 底图）；
 * - 滚轮缩放 / 拖动平移；显示玩家位置、全部主要地点与商店；
 * - 点击地图任意位置创建自定义导航目标（A* 沿道路规划）；
 * - ESC / M 关闭并恢复游戏控制（GameScene 在打开时被暂停）。
 */
import * as Phaser from 'phaser';
import { TILE } from '../config';
import type { GameScene } from './GameScene';
import type { Place } from '../systems/PlaceManager';

/** 底图显示尺寸：4 px/tile * 100 tile = 400 */
const MAP_DISPLAY = 400;

const ICON_COLORS: Record<string, number> = {
  phone: 0xffd76a,
  gunshop: 0xff5a4a,
  repair: 0x5ad4e6,
  garage: 0xff9a3a,
  police: 0x5a8ada,
};

const LEGEND: Array<[string, string]> = [
  ['phone', 'PHONE'],
  ['gunshop', 'GUN SHOP'],
  ['repair', 'REPAIR'],
  ['garage', 'GARAGE'],
  ['police', 'POLICE'],
  ['nav', 'NAV TARGET'],
  ['player', 'YOU'],
];

export class MapScene extends Phaser.Scene {
  private gs!: GameScene;
  private created = 0;
  private cam!: Phaser.Cameras.Scene2D.Camera;
  private markers!: Phaser.GameObjects.Graphics;
  private titleText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private keyEsc!: Phaser.Input.Keyboard.Key;
  private keyM!: Phaser.Input.Keyboard.Key;
  private keyX!: Phaser.Input.Keyboard.Key;
  private minZoom = 1;
  private dragging = false;
  private dragMoved = 0;
  private lastPointer = { x: 0, y: 0 };

  constructor() {
    super('Map');
  }

  create(): void {
    this.gs = (this.registry.get('worldCtx') as { game: GameScene }).game;
    this.created = this.time.now;

    this.cam = this.cameras.main;
    this.cam.setBackgroundColor('#0a0c10');

    this.add.image(0, 0, 'fullmap-base').setOrigin(0, 0);

    // 图层：POI 色块图标 + 名称文本 + 动态标记（底图 4px/tile → 世界坐标 ÷8）
    for (const place of this.gs.places.places as Place[]) {
      const x = place.x / 8;
      const y = place.y / 8;
      this.add
        .rectangle(x, y, 12, 12, ICON_COLORS[place.type] ?? 0xffffff)
        .setStrokeStyle(2, 0x101216);
      const name = { phone: 'PHONE', gunshop: 'GUNS', repair: 'REPAIR', garage: 'GARAGE', police: 'POLICE' }[
        place.type
      ];
      this.add
        .text(x, y - 10, name ?? '', {
          fontFamily: '"Courier New", monospace',
          fontSize: '10px',
          fontStyle: 'bold',
          color: '#f5f2e8',
          stroke: '#101216',
          strokeThickness: 3,
        })
        .setOrigin(0.5, 1);
    }

    this.markers = this.add.graphics();

    // 标题与操作提示
    this.titleText = this.add
      .text(16, 10, 'CITY MAP', {
        fontFamily: '"Courier New", monospace',
        fontSize: '24px',
        fontStyle: 'bold',
        color: '#f5f2e8',
        stroke: '#101216',
        strokeThickness: 4,
      })
      .setScrollFactor(0);
    this.hintText = this.add
      .text(16, 38, 'CLICK = SET NAV TARGET · WHEEL = ZOOM · DRAG = PAN\nM / ESC = CLOSE · X = CANCEL NAV', {
        fontFamily: '"Courier New", monospace',
        fontSize: '12px',
        color: '#b9c2cf',
        stroke: '#101216',
        strokeThickness: 3,
        lineSpacing: 4,
      })
      .setScrollFactor(0);

    // 图例（右下角）
    const lx = this.scale.width - 16;
    let ly = this.scale.height - 16 - LEGEND.length * 18;
    for (const [type, label] of LEGEND) {
      const color = type === 'nav' ? 0xe65ad4 : type === 'player' ? 0xffffff : ICON_COLORS[type];
      this.add.rectangle(lx - 118, ly + 7, 10, 10, color).setScrollFactor(0).setStrokeStyle(1, 0x101216);
      this.add
        .text(lx - 102, ly, label, {
          fontFamily: '"Courier New", monospace',
          fontSize: '12px',
          color: '#d9dee6',
          stroke: '#101216',
          strokeThickness: 3,
        })
        .setScrollFactor(0);
      ly += 18;
    }

    // 摄像机：初始缩放适配屏幕，居中到玩家位置
    this.minZoom = Math.max(0.6, Math.min(this.scale.width / MAP_DISPLAY, (this.scale.height - 140) / MAP_DISPLAY));
    this.cam.setBounds(-40, -40, MAP_DISPLAY + 80, MAP_DISPLAY + 80);
    this.cam.setZoom(this.minZoom);
    const p = this.gs.player;
    this.cam.centerOn(p.x / (TILE / 4), p.y / (TILE / 4));

    // 输入：滚轮缩放 + 拖动平移 + 点击设目标
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      const z = Phaser.Math.Clamp(this.cam.zoom - dy * 0.0015 * this.cam.zoom, this.minZoom * 0.8, 6);
      this.cam.setZoom(z);
    });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.dragging = true;
      this.dragMoved = 0;
      this.lastPointer = { x: p.x, y: p.y };
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.dragging) return;
      const dx = p.x - this.lastPointer.x;
      const dy = p.y - this.lastPointer.y;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      this.cam.scrollX -= dx / this.cam.zoom;
      this.cam.scrollY -= dy / this.cam.zoom;
      this.lastPointer = { x: p.x, y: p.y };
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      this.dragging = false;
      if (this.dragMoved > 8) return; // 拖动结束不算点击
      const world = this.cam.getWorldPoint(p.x, p.y);
      if (world.x < 0 || world.y < 0 || world.x > MAP_DISPLAY || world.y > MAP_DISPLAY) return;
      // 底图 4px/tile → 游戏世界坐标
      const wx = (world.x * TILE) / 4;
      const wy = (world.y * TILE) / 4;
      const g = this.gs;
      const active = g.vehicles.active;
      const px = active ? active.x : g.player.x;
      const py = active ? active.y : g.player.y;
      const mode = active ? 'road' : 'walk';
      const ok = g.navigation.setTarget(wx, wy, px, py, mode);
      if (ok) this.drawMarkers();
    });

    // 按键：ESC / M 关闭，X 取消导航（M 与打开键共用，创建后 300ms 内忽略防误关）
    const kb = this.input.keyboard!;
    kb.addCapture([Phaser.Input.Keyboard.KeyCodes.ESC, Phaser.Input.Keyboard.KeyCodes.X]);
    this.keyEsc = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.keyM = kb.addKey('M');
    this.keyX = kb.addKey('X');
    this.keyX.on('down', () => {
      this.gs.navigation.clear();
      this.drawMarkers();
    });
  }

  private close(): void {
    this.scene.stop();
    this.scene.resume('Game');
  }

  /** 重绘动态标记：玩家箭头 + 导航目标 */
  private drawMarkers(): void {
    const g = this.markers;
    g.clear();
    const k = 4 / TILE; // 世界 px → 底图 px

    // 导航目标（品红菱形 + 路径折线）
    const nav = this.gs.navigation;
    if (nav.active && nav.target) {
      g.lineStyle(2, 0xe65ad4, 0.95);
      g.beginPath();
      let first = true;
      for (const p of nav.path) {
        const x = p.x * k;
        const y = p.y * k;
        if (first) {
          g.moveTo(x, y);
          first = false;
        } else {
          g.lineTo(x, y);
        }
      }
      g.strokePath();
      const t = { x: nav.target.x * k, y: nav.target.y * k };
      g.fillStyle(0xe65ad4, 1);
      g.beginPath();
      g.moveTo(t.x, t.y - 8);
      g.lineTo(t.x + 8, t.y);
      g.lineTo(t.x, t.y + 8);
      g.lineTo(t.x - 8, t.y);
      g.closePath();
      g.fillPath();
    }

    // 玩家箭头（白色）
    const active = this.gs.vehicles.active;
    const px = (active ? active.x : this.gs.player.x) * k;
    const py = (active ? active.y : this.gs.player.y) * k;
    const heading = active
      ? Math.atan2(-Math.cos(active.rotation), Math.sin(active.rotation))
      : this.gs.player.facingAngle;
    const rot = (x: number, y: number): { x: number; y: number } => ({
      x: x * Math.cos(heading) - y * Math.sin(heading),
      y: x * Math.sin(heading) + y * Math.cos(heading),
    });
    const p0 = rot(10, 0);
    const p1 = rot(-6, 6);
    const p2 = rot(-6, -6);
    g.fillStyle(0xffffff, 1);
    g.beginPath();
    g.moveTo(px + p0.x, py + p0.y);
    g.lineTo(px + p1.x, py + p1.y);
    g.lineTo(px + p2.x, py + p2.y);
    g.closePath();
    g.fillPath();
  }

  update(): void {
    // 关闭按键：ESC / M（M 与打开键共用，创建后 300ms 内忽略，避免同一次按下立即关闭）
    if (Phaser.Input.Keyboard.JustDown(this.keyEsc)) this.close();
    if (this.time.now - this.created > 300 && Phaser.Input.Keyboard.JustDown(this.keyM)) this.close();
    // 玩家位置随游戏暂停而静止，仅重绘动态标记（便宜）
    this.drawMarkers();
  }
}
