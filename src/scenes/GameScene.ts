/**
 * 游戏主场景：地图层、碰撞体、玩家、NPC、车辆、警察 AI、通缉系统、摄像机与游戏时钟。
 * 控制状态机：ON_FOOT（人物响应输入） / IN_VEHICLE（车辆响应输入），二者互斥。
 */
import * as Phaser from 'phaser';
import { TILE, WORLD_W, WORLD_H } from '../config';
import { CityGenerator } from '../systems/CityGenerator';
import { Player } from '../entities/Player';
import { NPCManager } from '../systems/NPCManager';
import { VehicleManager } from '../systems/VehicleManager';
import { Vehicle } from '../entities/Vehicle';
import { PoliceManager, PlayerSnap } from '../systems/PoliceManager';
import { WantedSystem } from '../systems/WantedSystem';
import { PoliceInterceptionSystem } from '../systems/PoliceInterceptionSystem';
import { ArrestSystem } from '../systems/ArrestSystem';
import { BustSystem } from '../systems/BustSystem';
import { EconomyManager } from '../systems/EconomyManager';
import { CashPickupManager } from '../systems/CashPickupManager';
import { NavigationManager } from '../systems/NavigationManager';
import { PlaceManager, type POI, type PlaceType } from '../systems/PlaceManager';
import { buildMapCanvas } from '../systems/MiniMapSystem';
import { ECONOMY } from '../data/economyConfig';

type ControlState = 'ON_FOOT' | 'IN_VEHICLE';
/** 全局游戏阶段：PLAY 正常游戏 / BUSTED 被捕结算（冻结玩家与警察） */
type GamePhase = 'PLAY' | 'BUSTED';

const ENTER_DIST = 64; // 上车交互半径
const EXIT_SPEED_SOFT = 130; // 提示减速下车的速度阈值
const POI_INTERACT_DIST = 48; // POI 交互半径（步行）
/** 无图标纹理时的 POI 降级色块（与 HUD/地图调色板一致） */
const POI_FALLBACK_COLOR: Record<PlaceType, number> = {
  phone: 0x5ab46a,
  gunshop: 0xc23b3b,
  repair: 0xe08a3a,
  garage: 0x5a8ada,
  police: 0x5a7a9a,
};

export class GameScene extends Phaser.Scene {
  player!: Player;
  private npcs!: NPCManager;
  vehicles!: VehicleManager;
  gen!: CityGenerator;
  private ctrlState: ControlState = 'ON_FOOT';
  private gamePhase: GamePhase = 'PLAY';

  // 第三阶段：警察 AI 与动态通缉
  police!: PoliceManager;
  wanted!: WantedSystem;
  // Phase 3.1：拦截 / 抓捕 / 被捕
  arrest!: ArrestSystem;
  private bust!: BustSystem;
  // Phase 4.1：经济 / 导航 / 地点 / 现金拾取
  economy!: EconomyManager;
  places!: PlaceManager;
  navigation!: NavigationManager;
  cashDrops!: CashPickupManager;
  station: { tx: number; ty: number } = { tx: 0, ty: 0 };
  private lastArrestPct = -1;
  private lastArrestPhase = 'none';

  private lastEntered: Vehicle | null = null; // 最近一次进入的车（重复上下同一辆不重复记罪）
  private prevChase = false;
  private escapedTimer = 0;
  private vol = 0.8;
  private keyVolDown!: Phaser.Input.Keyboard.Key;
  private keyVolUp!: Phaser.Input.Keyboard.Key;
  private keyRespawn!: Phaser.Input.Keyboard.Key;

  private eKey!: Phaser.Input.Keyboard.Key;
  private driveKeys!: Record<'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'SPACE', Phaser.Input.Keyboard.Key>;

  private clockMin = 8 * 60; // 游戏内分钟（1 现实秒 = 1 游戏分钟）
  private clockAcc = 0;
  private lastPrompt = '';
  private lastDrive = '';
  private lastHelp = '';
  private lastBanner = '';
  private keyMap!: Phaser.Input.Keyboard.Key; // M：完整地图
  private keyMute!: Phaser.Input.Keyboard.Key; // N：静音
  private keyNavCancel!: Phaser.Input.Keyboard.Key; // X：取消导航

  constructor() {
    super('Game');
  }

  create(): void {
    this.gen = new CityGenerator();

    // 小地图 / 完整地图底图（预渲染，键已存在时跳过以便热重载）
    if (!this.textures.exists('minimap-base')) {
      this.textures.addCanvas('minimap-base', buildMapCanvas(this.gen, 1));
      this.textures.addCanvas('fullmap-base', buildMapCanvas(this.gen, 4));
    }

    // Phase 4.1：经济系统（含存档恢复）+ 城市兴趣点（统一 Registry，排除出生点附近）
    this.economy = new EconomyManager(this);
    this.places = new PlaceManager(this.gen, this.gen.playerStart);

    // 地图三层：地面 / 投影 / 屋顶
    this.buildLayer(this.gen.ground, 0);
    this.buildLayer(this.gen.shadow, 1);
    this.buildLayer(this.gen.roof, 2);

    // 静态碰撞体：建筑 + 树木
    const solids = this.physics.add.staticGroup();
    for (const b of this.gen.buildings) {
      const w = (b.x1 - b.x0 + 1) * TILE;
      const h = (b.y1 - b.y0 + 1) * TILE;
      const rect = this.add.rectangle(b.x0 * TILE + w / 2, b.y0 * TILE + h / 2, w, h);
      rect.setVisible(false);
      solids.add(rect);
    }
    for (const t of this.gen.trees) {
      const img = this.add.image(t.tx * TILE + TILE / 2, t.ty * TILE + TILE / 2, t.tex);
      img.setDepth(3);
      img.setFlipX(Math.random() < 0.5);
      solids.add(img);
      const body = img.body as Phaser.Physics.Arcade.StaticBody;
      body.setSize(14, 10);
      body.setOffset(17, 44);
    }

    // 玩家与 NPC
    this.player = new Player(
      this,
      this.gen.playerStart.tx * TILE + TILE / 2,
      this.gen.playerStart.ty * TILE + TILE / 2
    );
    this.npcs = new NPCManager(this, this.gen);

    this.physics.add.collider(this.player, solids);
    this.physics.add.collider(this.npcs.group, solids);
    this.physics.add.collider(this.player, this.npcs.group);

    // 车辆系统（驾车撞 NPC 通过回调上报犯罪）
    this.vehicles = new VehicleManager(
      this,
      this.gen,
      solids,
      this.npcs.group,
      (impact) => this.onCrash(impact),
      (v, npc) => this.onHitNpc(v, npc)
    );
    this.physics.add.collider(this.player, this.vehicles.group);

    // 第三阶段：通缉系统 + 警察 AI（警车生成/寻路/视野/目击全部由 PoliceManager 管理）
    this.wanted = new WantedSystem({
      witness: (x, y) => this.police.anyWitness(x, y),
      dispatch: (x, y) => this.police.dispatchTo(x, y),
    });
    this.police = new PoliceManager(this, this.gen, solids, this.vehicles, this.npcs.group, this.wanted);
    this.physics.add.collider(this.player, this.police.group);

    // Phase 3.1：拦截（前置阻挡）+ 统一抓捕进度 + 被捕结算
    this.police.interception = new PoliceInterceptionSystem();
    this.arrest = new ArrestSystem();
    this.bust = new BustSystem(this);
    this.arrest.on('busted', () => {
      if (this.gamePhase !== 'PLAY') return;
      this.gamePhase = 'BUSTED';
      this.lastEntered = null;
      if (this.ctrlState === 'ON_FOOT') {
        (this.player.body as Phaser.Physics.Arcade.Body).setVelocity(0, 0);
        this.player.anims?.stop();
      }
      this.bust.begin(this.wanted.level);
    });

    // Phase 4.1：现金拾取 + 导航系统
    this.cashDrops = new CashPickupManager(this, this.economy);
    this.navigation = new NavigationManager(this.gen);

    // 犯罪积分：仅当犯罪被警察目击计入通缉时发放（冷却内重复事件不领取）
    this.wanted.on('crime-counted', (c: { type: string }) => {
      this.economy.addScore(ECONOMY.scorePerCrime[c.type] ?? 0, `crime_${c.type}`);
    });

    // 通缉事件 → HUD / 音效
    this.registry.set('wanted', 0);
    this.registry.set('banner', { text: '', color: '#ffffff' });
    this.registry.set('arrest', { active: false, progress: 0 });
    this.registry.set('busted', { show: false, level: 0, fine: 0, seized: false, vehicleName: 'NONE', cash: this.economy.getCash() });
    this.wanted.on('level-up', (lv: number) => {
      this.registry.set('wanted', lv);
      this.sound.play('sfx-levelup', { volume: 0.7 });
    });
    this.wanted.on('level-down', (lv: number) => {
      this.registry.set('wanted', lv);
      this.sound.play('sfx-leveldown', { volume: 0.6 });
    });
    this.wanted.on('reset', () => {
      this.registry.set('wanted', 0);
    });
    this.wanted.on('escaped', () => {
      this.sound.play('sfx-escaped', { volume: 0.8 });
      this.setBanner('ESCAPED', '#5ad46a');
      this.escapedTimer = 2600;
    });
    this.police.on('chase-start', () => {
      this.sound.play('sfx-spotted', { volume: 0.7 });
      this.setBanner('POLICE CHASE', '#ff5a4a');
    });

    // 警察局：重生点标记（蓝色区块 + POLICE 字样）
    this.station = this.findStationTile();
    this.places.addPoliceStation(this.station.tx, this.station.ty);
    const sx = this.station.tx * TILE + TILE;
    const sy = this.station.ty * TILE + TILE;
    const marker = this.add.rectangle(sx, sy, TILE * 2, TILE * 2, 0x2a4a8a, 0.35);
    marker.setStrokeStyle(2, 0x5a8ada);
    marker.setDepth(3);
    this.add
      .text(sx, sy - 26, 'POLICE', {
        fontFamily: '"Courier New", monospace',
        fontSize: '12px',
        fontStyle: 'bold',
        color: '#7ab0ff',
        stroke: '#101216',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(3);

    // POI 世界实体：每个注册 POI 在世界中放置图标标记（真实存在的地点，非仅地图贴纸）
    for (const poi of this.places.places) {
      const texOk = this.textures.exists(poi.icon);
      const pad = this.add.rectangle(poi.worldX, poi.worldY, 20, 20, 0x101216, 0.55);
      pad.setStrokeStyle(1, 0x565c66, 0.8);
      pad.setDepth(3);
      if (texOk) {
        const img = this.add.image(poi.worldX, poi.worldY, poi.icon);
        img.setScale(0.7);
        img.setDepth(3);
      } else {
        // 降级：无图标纹理时用类型色块，不允许 POI 在世界中不可见
        const fallback = POI_FALLBACK_COLOR[poi.type] ?? 0xffffff;
        const box = this.add.rectangle(poi.worldX, poi.worldY, 14, 14, fallback);
        box.setStrokeStyle(2, 0x101216);
        box.setDepth(3);
      }
    }

    // 开发调试钩子：控制台执行 __POI_DEBUG__() 输出 POI REGISTRY DEBUG（不出现在正式 UI）
    (window as unknown as { __POI_DEBUG__: () => string }).__POI_DEBUG__ = () => this.places.debugDump();
    if (import.meta.env.DEV) {
      console.log(this.places.debugDump());
    }

    // 世界与摄像机
    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);
    const cam = this.cameras.main;
    cam.setBounds(0, 0, WORLD_W, WORLD_H);
    cam.startFollow(this.player, false, 0.12, 0.12);
    cam.setZoom(1);
    cam.setBackgroundColor('#101216');

    // 阻止方向键 / 空格 / E / M / N / X 滚动或触发页面行为
    const kb = this.input.keyboard!;
    kb.addCapture([
      Phaser.Input.Keyboard.KeyCodes.UP,
      Phaser.Input.Keyboard.KeyCodes.DOWN,
      Phaser.Input.Keyboard.KeyCodes.LEFT,
      Phaser.Input.Keyboard.KeyCodes.RIGHT,
      Phaser.Input.Keyboard.KeyCodes.SPACE,
      Phaser.Input.Keyboard.KeyCodes.E,
      Phaser.Input.Keyboard.KeyCodes.M,
      Phaser.Input.Keyboard.KeyCodes.N,
      Phaser.Input.Keyboard.KeyCodes.X,
    ]);
    this.eKey = kb.addKey('E');
    this.driveKeys = kb.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE') as Record<
      'W' | 'A' | 'S' | 'D' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'SPACE',
      Phaser.Input.Keyboard.Key
    >;

    // 按键：M 完整地图（原静音键移至 N），[ ] 调节音量，X 取消导航
    const kc = Phaser.Input.Keyboard.KeyCodes;
    this.keyMap = kb.addKey('M');
    this.keyMute = kb.addKey('N');
    this.keyNavCancel = kb.addKey('X');
    this.keyVolDown = kb.addKey(kc.OPEN_BRACKET);
    this.keyVolUp = kb.addKey(kc.CLOSED_BRACKET);
    this.keyRespawn = kb.addKey(kc.ENTER);
    this.sound.volume = this.vol;
    this.registry.set('vol', `${Math.round(this.vol * 100)}%`);

    this.registry.set('clock', this.clockText());
    this.registry.set('prompt', '');
    this.registry.set('drive', '');
    this.registry.set('help', 'WASD / 方向键 移动 · E 上车 · M 地图');
    // HUD 与完整地图场景共享的世界上下文（系统引用）
    this.registry.set('worldCtx', { game: this });
    this.scene.launch('Hud');
  }

  private buildLayer(data: number[][], depth: number): void {
    const map = this.make.tilemap({ data, tileWidth: TILE, tileHeight: TILE });
    const tileset = map.addTilesetImage('city-tiles', 'city-tiles', TILE, TILE, 0, 0)!;
    const layer = map.createLayer(0, tileset!, 0, 0)!;
    layer.setDepth(depth);
  }

  private clockText(): string {
    const day = Math.floor(this.clockMin / 1440) + 1;
    const hh = String(Math.floor((this.clockMin % 1440) / 60)).padStart(2, '0');
    const mm = String(this.clockMin % 60).padStart(2, '0');
    return `DAY ${day}  ${hh}:${mm}`;
  }

  // ---------- 状态切换 ----------

  private enterVehicle(v: Vehicle): void {
    // 偷车是犯罪：换新车（不是刚刚离开的那辆）且被警察目击时计入通缉
    if (this.lastEntered !== v) {
      this.wanted.reportCrime('steal_vehicle', this.player.x, this.player.y, this.time.now);
      this.lastEntered = v;
    }
    this.ctrlState = 'IN_VEHICLE';
    this.vehicles.active = v;
    v.driven = true;
    v.setParked(false);
    this.player.setVisible(false);
    (this.player.body as Phaser.Physics.Arcade.Body).enable = false;
    this.cameras.main.startFollow(v, false, 0.1, 0.1);
    this.setPrompt('');
    this.setDrive(v);
    this.setHelp('WASD 驾驶 · SPACE 手刹 · E 下车 · M 地图');
  }

  private tryExit(): void {
    const v = this.vehicles.active!;
    const spot = this.findExitSpot(v);
    if (!spot) {
      this.setPrompt('NO SAFE PLACE TO EXIT');
      return;
    }
    v.driven = false;
    v.setParked(true); // 完全静止且不可推动
    this.vehicles.active = null;

    this.player.setPosition(spot.x, spot.y);
    const pb = this.player.body as Phaser.Physics.Arcade.Body;
    pb.enable = true;
    pb.setVelocity(0, 0);
    this.player.setVisible(true);

    this.cameras.main.startFollow(this.player, false, 0.12, 0.12);
    this.ctrlState = 'ON_FOOT';
    this.setDrive(null);
    this.setPrompt('');
    this.setHelp('WASD / 方向键 移动 · E 上车 · M 地图');
  }

  /** 在车身四周找安全下车点：不在建筑内、不与车辆重叠、在_world 边界内 */
  private findExitSpot(v: Vehicle): { x: number; y: number } | null {
    const fx = Math.sin(v.rotation);
    const fy = -Math.cos(v.rotation);
    const rx = Math.cos(v.rotation);
    const ry = Math.sin(v.rotation);
    const s = v.spec;
    const off = 18;
    const candidates: Array<[number, number]> = [
      [s.bodyW / 2 + off, 0],
      [-(s.bodyW / 2 + off), 0],
      [0, s.bodyL / 2 + off],
      [0, -(s.bodyL / 2 + off)],
      [s.bodyW / 2 + off, s.bodyL / 2 + 8],
      [-(s.bodyW / 2 + off), s.bodyL / 2 + 8],
      [s.bodyW / 2 + off, -(s.bodyL / 2 + 8)],
      [-(s.bodyW / 2 + off), -(s.bodyL / 2 + 8)],
    ];
    for (const [lx, ly] of candidates) {
      const wx = v.x + rx * lx + fx * ly;
      const wy = v.y + ry * lx + fy * ly;
      if (wx < 8 || wy < 8 || wx > WORLD_W - 8 || wy > WORLD_H - 8) continue;
      if (this.insideBuilding(wx, wy, 8)) continue;
      if (this.nearOtherVehicle(v, wx, wy, 34)) continue;
      return { x: wx, y: wy };
    }
    return null;
  }

  private insideBuilding(px: number, py: number, pad: number): boolean {
    for (const b of this.gen.buildings) {
      const x0 = b.x0 * TILE - pad;
      const x1 = (b.x1 + 1) * TILE + pad;
      const y0 = b.y0 * TILE - pad;
      const y1 = (b.y1 + 1) * TILE + pad;
      if (px > x0 && px < x1 && py > y0 && py < y1) return true;
    }
    return false;
  }

  private nearOtherVehicle(self: Vehicle, px: number, py: number, dist: number): boolean {
    for (const o of this.vehicles.vehicles) {
      if (o === self) continue;
      const dx = o.x - px;
      const dy = o.y - py;
      if (dx * dx + dy * dy < dist * dist) return true;
    }
    return false;
  }

  // ---------- HUD registry（值变化才写入，避免事件风暴） ----------

  private setPrompt(t: string): void {
    if (t !== this.lastPrompt) {
      this.lastPrompt = t;
      this.registry.set('prompt', t);
    }
  }

  private setDrive(v: Vehicle | null): void {
    const t = v ? `${v.spec.name}  ${String(Math.round(v.speed * 0.55)).padStart(3, '0')} KM/H` : '';
    if (t !== this.lastDrive) {
      this.lastDrive = t;
      this.registry.set('drive', t);
    }
  }

  private setHelp(t: string): void {
    if (t !== this.lastHelp) {
      this.lastHelp = t;
      this.registry.set('help', t);
    }
  }

  private setBanner(text: string, color: string): void {
    const key = text ? `${text}|${color}` : '';
    if (key === this.lastBanner) return;
    this.lastBanner = key;
    this.registry.set('banner', { text, color });
  }

  /**
   * 玩家驾车撞击 NPC：统一走 WantedSystem 犯罪上报（仅玩家车辆且需有实际撞击速度，静止重叠不算）。
   * 高速撞击视为"击败"NPC：可按配置概率掉落现金（每个 NPC 只掉一次）；犯罪上报与掉落是独立事件。
   */
  private onHitNpc(v: Vehicle, npc: Phaser.Physics.Arcade.Sprite): void {
    if (this.ctrlState !== 'IN_VEHICLE' || !this.wanted) return;
    const v0 = this.vehicles.active;
    // 只统计玩家驾驶的那辆车撞到 NPC；其他车辆（停放车/警车）碰 NPC 不归因给玩家
    if (!v0 || v !== v0 || v.speed <= 45) return;
    this.wanted.reportCrime('hit_npc', v.x, v.y, this.time.now);
    // 击败：停止 NPC AI 并尝试现金掉落（CashPickupManager 内部处理概率 / 单次 / 收益上限）
    if (this.npcs.defeat(npc)) {
      this.cashDrops.tryDropFromNpc(npc);
    }
  }

  private onCrash(impact: number): void {
    if (this.ctrlState === 'IN_VEHICLE') {
      this.cameras.main.shake(90, Math.min(0.008, impact * 0.00004));
    }
  }

  // ---------- Phase 3.1：警察局 / 被捕恢复 ----------

  /** 在玩家出生点右下方找一个 2x2 可行走区块作为警察局重生点 */
  private findStationTile(): { tx: number; ty: number } {
    const ps = this.gen.playerStart;
    for (let r = 1; r < 18; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = ps.tx + dx + 7;
          const ty = ps.ty + dy + 9;
          if (
            this.gen.isWalkableTile(tx, ty) &&
            this.gen.isWalkableTile(tx + 1, ty) &&
            this.gen.isWalkableTile(tx, ty + 1) &&
            this.gen.isWalkableTile(tx + 1, ty + 1)
          ) {
            return { tx, ty };
          }
        }
      }
    }
    return ps;
  }

  /** RESPawn：传送至警察局、恢复步行控制（通缉/警察/抓捕已由 BustSystem 清零） */
  respawnAtStation(): void {
    const x = this.station.tx * TILE + TILE;
    const y = this.station.ty * TILE + TILE;
    if (this.vehicles.active) {
      this.vehicles.active.driven = false;
      this.vehicles.active.setParked(true);
      this.vehicles.active = null;
    }
    this.player.setPosition(x, y);
    const pb = this.player.body as Phaser.Physics.Arcade.Body;
    pb.enable = true;
    pb.reset(x, y);
    this.player.setVisible(true);

    this.ctrlState = 'ON_FOOT';
    this.gamePhase = 'PLAY';
    this.setDrive(null);
    this.setPrompt('');
    this.setHelp('WASD / 方向键 移动 · E 上车 · M 地图');
    this.setBanner('', '#ffffff');
    this.cameras.main.startFollow(this.player, false, 0.12, 0.12);
  }

  /** 推进游戏时钟（1 现实秒 = 1 游戏分钟），BUSTED 期间也继续走 */
  private advanceClock(delta: number): void {
    this.clockAcc += delta;
    while (this.clockAcc >= 1000) {
      this.clockAcc -= 1000;
      this.clockMin++;
    }
    this.registry.set('clock', this.clockText());
  }

  update(time: number, delta: number): void {
    const eJust = Phaser.Input.Keyboard.JustDown(this.eKey);

    // BUSTED 阶段：冻结玩家输入、车辆驾驶、警察 AI 与犯罪事件；时钟与 NPC 继续走
    if (this.gamePhase === 'BUSTED') {
      this.npcs.update(delta);
      this.advanceClock(delta);
      const clicked = this.registry.get('respawnReq') === true;
      if (clicked || Phaser.Input.Keyboard.JustDown(this.keyRespawn)) {
        this.registry.set('respawnReq', false);
        this.bust.respawn();
      }
      return;
    }

    // 音效开关（N 静音）与音量
    if (Phaser.Input.Keyboard.JustDown(this.keyMute)) {
      this.sound.mute = !this.sound.mute;
    }
    // M 打开完整城市地图（暂停游戏场景，MapScene 关闭时恢复）
    if (Phaser.Input.Keyboard.JustDown(this.keyMap) && !this.scene.isActive('Map')) {
      this.navigation.clear();
      this.scene.pause();
      this.scene.launch('Map');
      return;
    }
    // X 取消当前导航
    if (Phaser.Input.Keyboard.JustDown(this.keyNavCancel) && this.navigation.active) {
      this.navigation.clear();
      this.setBanner('NAV CANCELLED', '#b9c2cf');
      this.escapedTimer = 1400;
    }
    let volChanged = false;
    if (Phaser.Input.Keyboard.JustDown(this.keyVolDown)) {
      this.vol = Math.max(0, Math.round((this.vol - 0.1) * 10) / 10);
      volChanged = true;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyVolUp)) {
      this.vol = Math.min(1, Math.round((this.vol + 0.1) * 10) / 10);
      volChanged = true;
    }
    if (volChanged) {
      this.sound.volume = this.vol;
      this.registry.set('vol', `${Math.round(this.vol * 100)}%`);
    }

    if (this.ctrlState === 'ON_FOOT') {
      this.player.update();
      const nearPoi = this.places.nearest(this.player.x, this.player.y, POI_INTERACT_DIST);
      const near = this.vehicles.findNearest(this.player.x, this.player.y, ENTER_DIST);
      // POI 交互优先于上车（电话亭在人行道，车辆在路边，范围极少重叠）
      if (nearPoi) {
        this.setPrompt(`${nearPoi.name} · PRESS E TO INTERACT`);
        if (eJust) this.interactPoi(nearPoi);
      } else if (near) {
        this.setPrompt('PRESS E TO ENTER VEHICLE');
        if (eJust) this.enterVehicle(near);
      } else {
        this.setPrompt('');
      }
    } else {
      const k = this.driveKeys;
      const input = {
        throttle: k.W.isDown || k.UP.isDown,
        brake: k.S.isDown || k.DOWN.isDown,
        steer: (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0),
        handbrake: k.SPACE.isDown,
      };
      this.vehicles.update(delta, input);
      const v = this.vehicles.active!;
      this.setDrive(v);
      if (v.speed > EXIT_SPEED_SOFT) {
        this.setPrompt('SLOW DOWN TO EXIT');
      } else {
        this.setPrompt('PRESS E TO EXIT VEHICLE');
      }
      if (eJust) {
        this.tryExit();
      }
    }

    // 摄像机：高速逐渐拉远，减速恢复，平滑过渡
    const cam = this.cameras.main;
    let targetZoom = 1;
    if (this.ctrlState === 'IN_VEHICLE' && this.vehicles.active) {
      targetZoom = 1 - 0.16 * Math.min(1, this.vehicles.active.speed / this.vehicles.active.spec.maxSpeed);
    }
    cam.setZoom(cam.zoom + (targetZoom - cam.zoom) * Math.min(1, delta * 0.004));

    // NPC 随机行走（与控制状态无关，始终更新）
    this.npcs.update(delta);

    // 游戏时钟：1 现实秒 = 1 游戏分钟
    this.advanceClock(delta);

    // 第三阶段：警察 AI 与通缉系统主循环（统一玩家快照）
    const inVehicle = this.ctrlState === 'IN_VEHICLE';
    const pv = inVehicle ? this.vehicles.active : null;
    const pb = (pv ? pv.body : this.player.body) as Phaser.Physics.Arcade.Body;
    const snap: PlayerSnap = {
      x: pv ? pv.x : this.player.x,
      y: pv ? pv.y : this.player.y,
      inVehicle,
      speed: pv ? pv.speed : Math.hypot(pb.velocity.x, pb.velocity.y),
      vx: pb.velocity.x,
      vy: pb.velocity.y,
      level: this.wanted.level,
    };
    this.police.update(delta, time, snap);
    this.wanted.update(delta, this.police.anySeen, this.police.chaseActive);

    // Phase 4.1：导航系统 + 现金拾取 + 经济存档节流
    this.navigation.update(delta, snap.x, snap.y, inVehicle);
    this.cashDrops.update(delta, snap.x, snap.y);
    this.economy.update(delta);

    // Phase 3.1：抓捕进度判定（步行 = 警察实体坐标；驾驶 = 控制范围内警车）
    const cops = (inVehicle ? this.police.polices : this.police.officers).map((c) => ({
      x: c.x,
      y: c.y,
      speed: (c as Vehicle).speed ?? 0,
    }));
    this.arrest.update(delta, {
      inVehicle,
      playerX: snap.x,
      playerY: snap.y,
      playerSpeed: snap.speed,
      level: snap.level,
      chaseActive: this.police.chaseActive,
      cops,
    });
    const ap = Math.round(this.arrest.progress);
    const phase = this.arrest.active ? 'arresting' : this.police.officers.length > 0 ? 'approach' : 'none';
    if (ap !== this.lastArrestPct || phase !== this.lastArrestPhase) {
      this.lastArrestPct = ap;
      this.lastArrestPhase = phase;
      this.registry.set('arrest', { active: this.arrest.active, progress: ap, phase });
    }

    // 追捕结束但未逃脱：显示规避提示
    if (this.prevChase && !this.police.chaseActive && this.wanted.level > 0) {
      this.setBanner('EVADING', '#b9c2cf');
    }
    this.prevChase = this.police.chaseActive;
    if (this.escapedTimer > 0) {
      this.escapedTimer -= delta;
      if (this.escapedTimer <= 0) this.setBanner('', '#ffffff');
    }
  }
}
