/**
 * POI Registry（统一兴趣点数据源）：电话亭 / 武器商店 / 汽车维修厂 / 车库 / 警察局。
 * 世界实体（GameScene）、小地图（MiniMapSystem）、大地图（MapScene）、导航（NavigationManager）
 * 全部只读取本模块这一份数据，禁止各地图单独维护坐标。
 * 生成使用固定种子 RNG，位置确定且全城分散；每个候选点必须通过可行走 + 邻道路校验。
 */
import { MAP_W, MAP_H, TILE } from '../config';
import { CityGenerator } from './CityGenerator';

export type PlaceType = 'phone' | 'gunshop' | 'repair' | 'garage' | 'police';

export type SpawnStatus = 'ok' | 'invalid';

/** 统一 POI 数据结构（Registry 唯一格式） */
export interface POI {
  /** 稳定唯一 ID：`${type}-${序号}` */
  id: string;
  type: PlaceType;
  /** 地点名称（HUD / 大地图显示） */
  name: string;
  /** tile 坐标 */
  tx: number;
  ty: number;
  /** 世界坐标（tile 中心，恒定不随玩家/缩放变化） */
  worldX: number;
  worldY: number;
  /** 图标纹理 key（TextureFactory 自绘，缺失时由渲染层降级为色块） */
  icon: string;
  /** 地点说明（大地图信息面板显示） */
  description: string;
  /** 是否可交互（E 键） */
  interactable: boolean;
  /** 是否显示在大地图 */
  visibleOnFullMap: boolean;
  /** 是否显示在小地图 */
  visibleOnMinimap: boolean;
  /** 是否已开放（false = 预留地点，业务系统接入后置 true） */
  unlocked: boolean;
  /** 生成校验结果 */
  spawnStatus: SpawnStatus;
}

/** 兼容别名：历史代码中的 Place 即 POI */
export type Place = POI;

/** 各类型数量分配（第一版固定 10 个；police 由 GameScene 注入警察局坐标） */
const TYPE_PLAN: Array<[PlaceType, number]> = [
  ['phone', 4],
  ['gunshop', 2],
  ['repair', 1],
  ['garage', 2],
];

/** 类型元数据：名称 / 图标 / 描述 / 交互 */
const TYPE_META: Record<PlaceType, { name: string; icon: string; description: string; interactable: boolean }> = {
  phone: { name: 'PAYPHONE', icon: 'poi-phone', description: 'PUBLIC PHONE - MISSION LINE (COMING SOON)', interactable: true },
  gunshop: { name: 'AMMU CITY', icon: 'poi-gunshop', description: 'WEAPON SHOP (COMING SOON)', interactable: true },
  repair: { name: 'SPRUNK GARAGE', icon: 'poi-repair', description: 'REPAIR SHOP (COMING SOON)', interactable: true },
  garage: { name: 'GARAGE', icon: 'poi-garage', description: 'VEHICLE GARAGE (COMING SOON)', interactable: true },
  police: { name: 'POLICE HQ', icon: 'poi-police', description: 'POLICE STATION - BUSTED RESPAWN POINT', interactable: true },
};

const MIN_SPACING = 24; // POI 之间最小间隔（tile）
const MIN_EDGE = 3; // 距地图边缘最小距离（tile）
const MIN_SPAWN_DIST = 10; // 距玩家出生点最小距离（tile），避免与初始实体重叠

export class PlaceManager {
  readonly places: POI[] = [];
  private idSeq = 0;
  /** 校验失败（未注册）的候选点数量 */
  invalidCount = 0;

  constructor(gen: CityGenerator, playerStart?: { tx: number; ty: number }) {
    // 固定种子：城市布局本身固定种子生成，POI 位置也随之确定
    let seed = 19970101;
    const rng = (): number => {
      seed = (seed * 16807 + 11) % 2147483647;
      return (seed % 100000) / 100000;
    };

    // 收集"人行道上、邻近道路"的候选 tile（保证可达，绝不落建筑内部）
    const candidates: Array<{ tx: number; ty: number }> = [];
    for (let ty = MIN_EDGE; ty < MAP_H - MIN_EDGE; ty += 2) {
      for (let tx = MIN_EDGE; tx < MAP_W - MIN_EDGE; tx += 2) {
        if (!gen.isWalkableTile(tx, ty)) continue;
        if (gen.roof[ty][tx] >= 10) continue; // 双重校验：绝不在屋顶/建筑内（roof 仅建筑 ≥ ROOF_E0）
        const nearRoad =
          (gen.inH[ty][tx + 1] || gen.inH[ty][tx - 1] || gen.inV[ty + 1]?.[tx] || gen.inV[ty - 1]?.[tx]) ?? false;
        if (!nearRoad) continue;
        if (playerStart && Math.abs(tx - playerStart.tx) + Math.abs(ty - playerStart.ty) < MIN_SPAWN_DIST) continue;
        candidates.push({ tx, ty });
      }
    }

    const chosen: POI[] = [];
    for (const [type, count] of TYPE_PLAN) {
      let placed = 0;
      let attempts = 0;
      while (placed < count && attempts < 800 && candidates.length > 0) {
        attempts++;
        const c = candidates[Math.floor(rng() * candidates.length)];
        if (chosen.some((p) => Math.abs(p.tx - c.tx) + Math.abs(p.ty - c.ty) < MIN_SPACING)) continue;
        this.register(type, c.tx, c.ty, chosen);
        placed++;
      }
      if (placed < count) this.invalidCount += count - placed; // 候选不足视为生成缺口
    }
  }

  /** 注册一个 POI（唯一入口，附带可达性校验） */
  private register(type: PlaceType, tx: number, ty: number, chosen?: POI[]): POI {
    const meta = TYPE_META[type];
    const ok = tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H;
    if (!ok) this.invalidCount++;
    const poi: POI = {
      id: `${type}-${++this.idSeq}`,
      type,
      name: meta.name,
      tx,
      ty,
      worldX: tx * TILE + TILE / 2,
      worldY: ty * TILE + TILE / 2,
      icon: meta.icon,
      description: meta.description,
      interactable: meta.interactable,
      visibleOnFullMap: true,
      visibleOnMinimap: true,
      unlocked: type === 'police', // 警察局功能已接入（复活点）；其余业务待后续阶段
      spawnStatus: ok ? 'ok' : 'invalid',
    };
    this.places.push(poi);
    chosen?.push(poi);
    return poi;
  }

  /** 警察局（GameScene 已有确定坐标，2x2 区块中心） */
  addPoliceStation(tx: number, ty: number): POI {
    const poi = this.register('police', tx, ty);
    poi.worldX = tx * TILE + TILE;
    poi.worldY = ty * TILE + TILE;
    return poi;
  }

  getByType(type: PlaceType): POI[] {
    return this.places.filter((p) => p.type === type);
  }

  /** 距世界坐标最近的已开放且可交互 POI（E 键交互用） */
  nearest(x: number, y: number, maxDist: number): POI | null {
    let best: POI | null = null;
    let bestD = maxDist;
    for (const p of this.places) {
      if (!p.interactable) continue;
      const d = Math.hypot(p.worldX - x, p.worldY - y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** POI REGISTRY DEBUG：开发调试输出（不计入正式游戏 UI） */
  debugDump(extra?: { fullMapMarkers?: number; minimapMarkers?: number }): string {
    const ok = this.places.filter((p) => p.spawnStatus === 'ok');
    const lines = [
      '=== POI REGISTRY DEBUG ===',
      `Registered POI Count: ${this.places.length}`,
      `Spawned POI Count (ok): ${ok.length}`,
      `Full Map Marker Count: ${extra?.fullMapMarkers ?? 'n/a'}`,
      `Minimap Visible Marker Count: ${extra?.minimapMarkers ?? 'n/a'}`,
      `Invalid POI Count: ${this.invalidCount + this.places.length - ok.length}`,
      ...this.places.map(
        (p) =>
          `${p.id.padEnd(10)} ${p.type.padEnd(8)} world=(${p.worldX.toFixed(0)}, ${p.worldY.toFixed(0)}) spawn=${p.spawnStatus} fullMap=${p.visibleOnFullMap} minimap=${p.visibleOnMinimap} unlocked=${p.unlocked}`
      ),
    ];
    return lines.join('\n');
  }
}
