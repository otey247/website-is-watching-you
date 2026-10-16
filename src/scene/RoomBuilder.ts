import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  Points,
  RectAreaLight,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  type Material,
  type Texture,
} from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { BOOK_IDS, PLACEMENTS, ROOM, type BookId, type ObjectId } from '../core/layout';
import { Rng } from '../core/rng';
import {
  blobShadow,
  bookSpine,
  clockFace,
  fabricTexture,
  noteTexture,
  outsideTexture,
  rugTexture,
  wallAO,
  wallTexture,
  woodTextures,
} from './textures';

export const LAYER_FIGURE = 2;

export interface RoomParts {
  drawers: Record<'drawer_top' | 'drawer_bottom', Group>;
  doorPivot: Group;
  doorHandle: Group;
  clockHands: { hour: Object3D; minute: Object3D; second: Object3D };
  fanRotor: Group;
  curtains: { left: Mesh; right: Mesh; material: MeshStandardMaterial };
  lamp: { bulb: Mesh; shade: Mesh; shadeMat: MeshStandardMaterial; bulbMat: MeshStandardMaterial; light: PointLight };
  chair: Group;
  books: Record<BookId, Group>;
  bookCovers: Record<BookId, Object3D>;
  figurine: Group;
  cup: Group;
  note: Mesh;
  photo: { group: Group; plane: Mesh; glass: Mesh };
  screen: Mesh;
  mirror: Reflector;
  figure: Mesh;
  shadowCaster: Mesh;
  dust: Points;
  outside: Mesh;
  hallLight: PointLight;
}

export interface Room {
  scene: Scene;
  roots: Partial<Record<ObjectId, Object3D>>;
  pickables: Mesh[];
  occluders: Object3D[];
  surfaces: Mesh[];
  parts: RoomParts;
  lights: { sun: DirectionalLight; window: RectAreaLight; hemi: HemisphereLight; monitor: PointLight };
  sunDirection: Vector3;
  materials: Material[];
}

const SUN_POS = new Vector3(2.6, 4.8, -6.5);
const SUN_TARGET = new Vector3(0.6, 0, -0.2);

/**
 * Builds the room procedurally: realistic proportions, PBR materials with
 * generated wood/paint/fabric maps, baked AO on walls and baked contact
 * shadows under furniture, with a single shadow-casting sun.
 */
export function buildRoom(opts: { shadows: boolean; dust: boolean }): Room {
  const scene = new Scene();
  scene.background = new Color('#0b0b0c');
  const roots: Partial<Record<ObjectId, Object3D>> = {};
  const pickables: Mesh[] = [];
  const occluders: Object3D[] = [];
  const surfaces: Mesh[] = [];
  const materials: Material[] = [];
  const rng = new Rng(2024);

  const std = (p: ConstructorParameters<typeof MeshStandardMaterial>[0]) => {
    const m = new MeshStandardMaterial(p);
    materials.push(m);
    return m;
  };
  const phys = (p: ConstructorParameters<typeof MeshPhysicalMaterial>[0]) => {
    const m = new MeshPhysicalMaterial(p);
    materials.push(m);
    return m;
  };

  // ——— Materials ———
  const floorWood = woodTextures(11, [150, 108, 72], { w: 1024, h: 1024, planks: 6, grain: 1.2 });
  floorWood.map.repeat.set(2, 2);
  floorWood.rough.repeat.set(2, 2);
  floorWood.map.wrapS = floorWood.map.wrapT = floorWood.rough.wrapS = floorWood.rough.wrapT = 1000;
  const deskWood = woodTextures(21, [120, 78, 48], { planks: 1, grain: 0.9 });
  const lightWood = woodTextures(31, [176, 138, 98], { planks: 1, grain: 1.4 });
  const wall = wallTexture(5, [214, 206, 190]);
  const ao = wallAO();
  const shadowTex = blobShadow();
  const seatFabric = fabricTexture(3, [92, 64, 52]);
  const curtainFabric = fabricTexture(8, [200, 186, 160], 2.2);

  const floorMat = std({ map: floorWood.map, roughnessMap: floorWood.rough, roughness: 0.75, metalness: 0 });
  const wallMat = std({ map: wall.map, roughnessMap: wall.rough, roughness: 0.92, aoMap: ao, aoMapIntensity: 1 });
  const ceilingMat = std({ color: '#ece8df', roughness: 0.95 });
  const trimMat = std({ color: '#ede8dc', roughness: 0.55 });
  const deskMat = phys({ map: deskWood.map, roughnessMap: deskWood.rough, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.45 });
  const lightWoodMat = std({ map: lightWood.map, roughnessMap: lightWood.rough, roughness: 0.6 });
  const darkPlastic = std({ color: '#151516', roughness: 0.42, metalness: 0.05 });
  const brass = std({ color: '#b08a4a', roughness: 0.32, metalness: 1 });
  const steel = std({ color: '#8d9095', roughness: 0.35, metalness: 1 });
  const ceramic = phys({ color: '#e9e4da', roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 });
  const glass = phys({ color: '#ffffff', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.12, envMapIntensity: 1.5, depthWrite: false });

  // ——— Shell: floor, ceiling, walls with window and door openings ———
  const W = ROOM.maxX - ROOM.minX;
  const D = ROOM.maxZ - ROOM.minZ;
  const H = ROOM.height;
  const floor = new Mesh(new PlaneGeometry(W, D), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.userData.surface = 'floor';
  scene.add(floor);
  surfaces.push(floor);
  occluders.push(floor);

  const ceiling = new Mesh(new PlaneGeometry(W, D), ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = H;
  scene.add(ceiling);

  const addWallPanel = (w: number, h: number, pos: Vector3, rotY: number, name: string, uvRect?: [number, number, number, number]) => {
    const g = new PlaneGeometry(w, h);
    if (uvRect) {
      // Map this panel's UVs into the full wall's AO space.
      const uv = g.attributes.uv as BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uvRect[0] + uv.getX(i) * uvRect[2], uvRect[1] + uv.getY(i) * uvRect[3]);
    }
    const m = new Mesh(g, wallMat);
    m.position.copy(pos);
    m.rotation.y = rotY;
    m.receiveShadow = true;
    m.userData.surface = name;
    scene.add(m);
    surfaces.push(m);
    occluders.push(m);
    return m;
  };

  // North wall (z = minZ) with window opening x 0.55..1.85, y 0.9..2.2
  const winX0 = 0.55;
  const winX1 = 1.85;
  const winY0 = 0.9;
  const winY1 = 2.2;
  const nz = ROOM.minZ;
  const uvx = (x: number) => (x - ROOM.minX) / W;
  addWallPanel(winX0 - ROOM.minX, H, new Vector3((ROOM.minX + winX0) / 2, H / 2, nz), 0, 'wall_n', [0, 0, uvx(winX0), 1]);
  addWallPanel(ROOM.maxX - winX1, H, new Vector3((winX1 + ROOM.maxX) / 2, H / 2, nz), 0, 'wall_n', [uvx(winX1), 0, 1 - uvx(winX1), 1]);
  addWallPanel(winX1 - winX0, winY0, new Vector3((winX0 + winX1) / 2, winY0 / 2, nz), 0, 'wall_n', [uvx(winX0), 0, uvx(winX1) - uvx(winX0), winY0 / H]);
  addWallPanel(winX1 - winX0, H - winY1, new Vector3((winX0 + winX1) / 2, (winY1 + H) / 2, nz), 0, 'wall_n', [uvx(winX0), winY1 / H, uvx(winX1) - uvx(winX0), 1 - winY1 / H]);
  // South wall
  addWallPanel(W, H, new Vector3(0, H / 2, ROOM.maxZ), Math.PI, 'wall_s');
  // West wall
  addWallPanel(D, H, new Vector3(ROOM.minX, H / 2, 0), Math.PI / 2, 'wall_w');
  // East wall with door opening z -1.25..-0.35, y 0..2.05
  const dz0 = -1.25;
  const dz1 = -0.35;
  const dH = 2.05;
  const uvz = (z: number) => 1 - (z - ROOM.minZ) / D; // east wall faces -x, u runs along -z
  addWallPanel(dz0 - ROOM.minZ, H, new Vector3(ROOM.maxX, H / 2, (ROOM.minZ + dz0) / 2), -Math.PI / 2, 'wall_e', [uvz(dz0), 0, 1 - uvz(dz0), 1]);
  addWallPanel(ROOM.maxZ - dz1, H, new Vector3(ROOM.maxX, H / 2, (dz1 + ROOM.maxZ) / 2), -Math.PI / 2, 'wall_e', [0, 0, uvz(dz1), 1]);
  addWallPanel(dz1 - dz0, H - dH, new Vector3(ROOM.maxX, (dH + H) / 2, (dz0 + dz1) / 2), -Math.PI / 2, 'wall_e', [uvz(dz1), dH / H, uvz(dz0) - uvz(dz1), 1 - dH / H]);

  // Baseboards
  const base = (len: number, pos: Vector3, rotY: number) => {
    const b = new Mesh(new BoxGeometry(len, 0.09, 0.015), trimMat);
    b.position.copy(pos);
    b.rotation.y = rotY;
    b.receiveShadow = true;
    scene.add(b);
  };
  base(W, new Vector3(0, 0.045, ROOM.minZ + 0.008), 0);
  base(W, new Vector3(0, 0.045, ROOM.maxZ - 0.008), 0);
  base(D, new Vector3(ROOM.minX + 0.008, 0.045, 0), Math.PI / 2);
  base(dz0 - ROOM.minZ, new Vector3(ROOM.maxX - 0.008, 0.045, (ROOM.minZ + dz0) / 2), Math.PI / 2);
  base(ROOM.maxZ - dz1, new Vector3(ROOM.maxX - 0.008, 0.045, (dz1 + ROOM.maxZ) / 2), Math.PI / 2);

  // Rug
  const rug = new Mesh(new PlaneGeometry(2.2, 1.5), std({ map: rugTexture(), roughness: 1 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0.1, 0.003, 0.25);
  rug.receiveShadow = true;
  rug.userData.surface = 'floor';
  scene.add(rug);
  surfaces.push(rug);

  // Baked contact shadows
  const blob = (w: number, d: number, x: number, z: number, opacity = 0.7, parent: Object3D = scene) => {
    const m = new Mesh(new PlaneGeometry(w, d), new MeshBasicMaterial({ map: shadowTex, transparent: true, opacity, depthWrite: false, color: '#000' }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.005, z);
    m.renderOrder = 1;
    parent.add(m);
    return m;
  };

  // ——— Window ———
  const winGroup = new Group();
  const frameMat = std({ color: '#f1ede4', roughness: 0.5 });
  const fw = winX1 - winX0;
  const fh = winY1 - winY0;
  const fcx = (winX0 + winX1) / 2;
  const fcy = (winY0 + winY1) / 2;
  const frameBar = (w: number, h: number, x: number, y: number, d = 0.08) => {
    const b = new Mesh(new BoxGeometry(w, h, d), frameMat);
    b.position.set(x, y, nz);
    b.castShadow = true;
    winGroup.add(b);
  };
  frameBar(fw + 0.12, 0.06, fcx, winY0 - 0.03, 0.14); // sill
  frameBar(fw + 0.08, 0.05, fcx, winY1 + 0.02);
  frameBar(0.05, fh + 0.08, winX0 - 0.02, fcy);
  frameBar(0.05, fh + 0.08, winX1 + 0.02, fcy);
  frameBar(0.035, fh, fcx, fcy, 0.05);
  frameBar(fw, 0.035, fcx, fcy + 0.1, 0.05);
  const pane = new Mesh(new PlaneGeometry(fw, fh), glass);
  pane.position.set(fcx, fcy, nz - 0.01);
  winGroup.add(pane);
  scene.add(winGroup);
  const outside = new Mesh(new PlaneGeometry(9, 4.5), new MeshBasicMaterial({ map: outsideTexture(), color: '#ffffff' }));
  outside.position.set(fcx, 1.7, nz - 2.2);
  scene.add(outside);
  // Radiator under the window
  const radiator = new Group();
  const radMat = std({ color: '#e8e4da', roughness: 0.45, metalness: 0.2 });
  for (let i = 0; i < 12; i++) {
    const fin = new Mesh(new BoxGeometry(0.05, 0.5, 0.08), radMat);
    fin.position.set(fcx - 0.5 + i * 0.09, 0.42, nz + 0.08);
    fin.castShadow = true;
    radiator.add(fin);
  }
  scene.add(radiator);

  // Curtains
  const curtainMat = std({ map: curtainFabric.map, roughness: 0.95, side: DoubleSide });
  curtainMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    curtainMat.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float sway = sin(uTime * 0.6 + position.x * 3.0) * 0.008 * (1.0 - uv.y);
        transformed.z += sway + sin(position.x * 28.0) * 0.022;`,
      );
  };
  const makeCurtain = (side: -1 | 1) => {
    const g = new PlaneGeometry(0.78, 2.35, 48, 8);
    g.translate(side * 0.39, 0, 0); // anchor at window center edge
    const m = new Mesh(g, curtainMat);
    m.position.set(side < 0 ? winX0 - 0.15 : winX1 + 0.15, 1.33, nz + 0.13);
    m.castShadow = true;
    m.userData.objectId = 'curtains';
    pickables.push(m);
    scene.add(m);
    return m;
  };
  // Left panel hangs from the left edge growing right; right panel from the right edge growing left.
  const curtainL = makeCurtain(1);
  const curtainR = makeCurtain(-1);
  const rod = new Mesh(new CylinderGeometry(0.012, 0.012, fw + 0.7, 12), brass);
  rod.rotation.z = Math.PI / 2;
  rod.position.set(fcx, 2.5, nz + 0.13);
  scene.add(rod);
  roots.curtains = curtainL;

  // ——— Desk ———
  const desk = new Group();
  desk.position.set(-0.9, 0, -1.75);
  const top = new Mesh(new BoxGeometry(1.4, 0.04, 0.7), deskMat);
  top.position.y = 0.73;
  top.castShadow = top.receiveShadow = true;
  top.userData.surface = 'desk_top';
  desk.add(top);
  surfaces.push(top);
  const leg = (x: number, z: number) => {
    const l = new Mesh(new BoxGeometry(0.05, 0.71, 0.05), deskMat);
    l.position.set(x, 0.355, z);
    l.castShadow = true;
    desk.add(l);
  };
  leg(-0.66, -0.3);
  leg(-0.66, 0.3);
  // Pedestal (right side, x -0.63..-0.22 world → local 0.27..0.68)
  const pedestal = new Group();
  pedestal.position.set(0.475, 0, 0);
  const pedMat = deskMat;
  const sideL = new Mesh(new BoxGeometry(0.02, 0.71, 0.68), pedMat);
  sideL.position.set(-0.2, 0.355, 0);
  const sideR = sideL.clone();
  sideR.position.x = 0.2;
  const back = new Mesh(new BoxGeometry(0.42, 0.71, 0.02), pedMat);
  back.position.set(0, 0.355, -0.33);
  const plinth = new Mesh(new BoxGeometry(0.42, 0.08, 0.66), pedMat);
  plinth.position.set(0, 0.04, 0);
  const divider = new Mesh(new BoxGeometry(0.38, 0.015, 0.66), pedMat);
  divider.position.set(0, 0.47, 0);
  for (const m of [sideL, sideR, back, plinth, divider]) {
    m.castShadow = m.receiveShadow = true;
    pedestal.add(m);
  }
  desk.add(pedestal);
  scene.add(desk);
  roots.desk = desk;
  occluders.push(top, sideL, sideR, back);
  blob(1.7, 0.95, -0.9, -1.7, 0.55);

  const makeDrawer = (id: 'drawer_top' | 'drawer_bottom', y: number, h: number) => {
    const g = new Group();
    const inner = new Group();
    const front = new Mesh(new BoxGeometry(0.38, h, 0.022), deskMat);
    front.position.set(0, h / 2, 0.33);
    front.castShadow = true;
    const bottom = new Mesh(new BoxGeometry(0.34, 0.012, 0.6), lightWoodMat);
    bottom.position.set(0, 0.02, 0.03);
    const sl = new Mesh(new BoxGeometry(0.012, h * 0.75, 0.6), lightWoodMat);
    sl.position.set(-0.17, h * 0.4, 0.03);
    const sr = sl.clone();
    sr.position.x = 0.17;
    const bk = new Mesh(new BoxGeometry(0.34, h * 0.75, 0.012), lightWoodMat);
    bk.position.set(0, h * 0.4, -0.27);
    const handle = new Mesh(new BoxGeometry(0.12, 0.016, 0.02), brass);
    handle.position.set(0, h / 2, 0.352);
    for (const m of [front, bottom, sl, sr, bk, handle]) {
      m.userData.objectId = id;
      pickables.push(m);
      inner.add(m);
    }
    g.add(inner);
    g.position.set(0.475, y, 0);
    desk.add(g);
    roots[id] = g;
    return { g, inner, floorY: 0.026 };
  };
  const dTop = makeDrawer('drawer_top', 0.49, 0.21);
  const dBot = makeDrawer('drawer_bottom', 0.09, 0.36);

  // Drawer contents
  const polaroid = new Mesh(new BoxGeometry(0.09, 0.003, 0.11), std({ color: '#efece4', roughness: 0.6 }));
  polaroid.position.set(-0.07, 0.03, 0.12);
  polaroid.rotation.y = 0.3;
  const polaroidImg = new Mesh(new PlaneGeometry(0.075, 0.075), std({ color: '#5e6a55', roughness: 0.4 }));
  polaroidImg.rotation.x = -Math.PI / 2;
  polaroidImg.position.set(0, 0.002, -0.008);
  polaroid.add(polaroidImg);
  const pen = new Mesh(new CylinderGeometry(0.005, 0.005, 0.14, 8), std({ color: '#1f2a4a', roughness: 0.3 }));
  pen.rotation.z = Math.PI / 2;
  pen.rotation.y = 0.2;
  pen.position.set(0.06, 0.032, 0.0);
  const keyRing = new Mesh(new TorusGeometry(0.018, 0.003, 8, 24), steel);
  keyRing.rotation.x = Math.PI / 2;
  keyRing.position.set(0.08, 0.03, 0.18);
  dTop.inner.add(polaroid, pen, keyRing);
  const letters = new Mesh(new BoxGeometry(0.22, 0.03, 0.3), std({ color: '#e7dfcc', roughness: 0.85 }));
  letters.position.set(0, 0.04, 0.02);
  dBot.inner.add(letters);

  // Monitor, keyboard, mouse
  const monitor = new Group();
  monitor.position.set(-1.05, 0.75, -1.92);
  const bezel = new Mesh(new BoxGeometry(0.58, 0.38, 0.03), darkPlastic);
  bezel.position.set(0, 0.28, 0);
  bezel.castShadow = true;
  const neck = new Mesh(new BoxGeometry(0.05, 0.12, 0.03), darkPlastic);
  neck.position.set(0, 0.06, -0.03);
  const foot = new Mesh(new BoxGeometry(0.22, 0.012, 0.16), darkPlastic);
  foot.position.set(0, 0.006, -0.01);
  const screen = new Mesh(new PlaneGeometry(0.52, 0.325), new MeshBasicMaterial({ color: '#000' }));
  screen.position.set(0, 0.285, 0.0155);
  for (const m of [bezel, neck, foot, screen]) {
    m.userData.objectId = 'computer';
    pickables.push(m);
    monitor.add(m);
  }
  screen.name = 'screen';
  scene.add(monitor);
  roots.computer = monitor;
  occluders.push(bezel);
  const keyboard = new Mesh(new BoxGeometry(0.42, 0.018, 0.14), std({ color: '#2a2a2c', roughness: 0.6 }));
  keyboard.position.set(-1.05, 0.759, -1.6);
  keyboard.castShadow = true;
  keyboard.userData.objectId = 'computer';
  pickables.push(keyboard);
  const mouse = new Mesh(new SphereGeometry(0.03, 16, 12), darkPlastic);
  mouse.scale.set(1, 0.5, 1.6);
  mouse.position.set(-0.72, 0.762, -1.6);
  scene.add(keyboard, mouse);
  const monitorGlow = new PointLight('#a8c4ff', 0.0, 2.2, 2);
  monitorGlow.position.set(-1.05, 1.05, -1.7);
  scene.add(monitorGlow);

  // ——— Chair ———
  const chair = new Group();
  const seat = new Mesh(new BoxGeometry(0.44, 0.05, 0.42), deskMat);
  seat.position.y = 0.46;
  const cushion = new Mesh(new BoxGeometry(0.4, 0.04, 0.38), phys({ map: seatFabric.map, roughness: 0.95, sheen: 0.6, sheenRoughness: 0.8, sheenColor: new Color('#b38d7a') }));
  cushion.position.y = 0.5;
  chair.add(seat, cushion);
  for (const [x, z] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]] as const) {
    const l = new Mesh(new CylinderGeometry(0.018, 0.014, 0.44, 10), deskMat);
    l.position.set(x, 0.22, z);
    chair.add(l);
  }
  for (const x of [-0.19, 0.19]) {
    const post = new Mesh(new BoxGeometry(0.035, 0.48, 0.035), deskMat);
    post.position.set(x, 0.72, -0.19);
    chair.add(post);
  }
  const rail = new Mesh(new BoxGeometry(0.42, 0.08, 0.025), deskMat);
  rail.position.set(0, 0.92, -0.19);
  chair.add(rail);
  for (let i = -1; i <= 1; i++) {
    const slat = new Mesh(new BoxGeometry(0.035, 0.34, 0.015), deskMat);
    slat.position.set(i * 0.1, 0.71, -0.19);
    chair.add(slat);
  }
  chair.traverse((o) => {
    if ((o as Mesh).isMesh) {
      o.castShadow = true;
      o.userData.objectId = 'chair';
      pickables.push(o as Mesh);
    }
  });
  blob(0.75, 0.75, 0, 0, 0.6, chair);
  scene.add(chair);
  roots.chair = chair;
  occluders.push(seat, rail);

  // ——— Floor lamp ———
  const lampG = new Group();
  lampG.position.set(-2.1, 0, -1.65);
  const lampBase = new Mesh(new CylinderGeometry(0.14, 0.16, 0.03, 32), brass);
  lampBase.position.y = 0.015;
  const pole = new Mesh(new CylinderGeometry(0.012, 0.012, 1.45, 12), brass);
  pole.position.y = 0.74;
  const shadeMat = std({ color: '#efe3c8', roughness: 0.9, side: DoubleSide, emissive: new Color('#ffc983'), emissiveIntensity: 0 });
  const shade = new Mesh(new CylinderGeometry(0.16, 0.24, 0.3, 40, 1, true), shadeMat);
  shade.position.y = 1.5;
  const bulbMat = std({ color: '#fff7e8', emissive: new Color('#ffd9a0'), emissiveIntensity: 0 });
  const bulb = new Mesh(new SphereGeometry(0.035, 16, 12), bulbMat);
  bulb.position.y = 1.45;
  for (const m of [lampBase, pole, shade, bulb]) {
    m.castShadow = m !== bulb && m !== shade;
    m.userData.objectId = 'lamp';
    pickables.push(m);
    lampG.add(m);
  }
  const lampLight = new PointLight('#ffc98a', 0, 7, 2);
  lampLight.position.y = 1.45;
  lampG.add(lampLight);
  scene.add(lampG);
  roots.lamp = lampG;
  blob(0.5, 0.5, -2.1, -1.65, 0.55);

  // ——— Photograph ———
  const photoG = new Group();
  const pc = PLACEMENTS.photograph.center;
  photoG.position.set(pc[0], pc[1], pc[2]);
  photoG.rotation.y = Math.PI / 2;
  const frameOuter = new Mesh(new BoxGeometry(0.46, 0.36, 0.028), phys({ color: '#3b2a1e', roughness: 0.45, clearcoat: 0.4 }));
  const matte = new Mesh(new PlaneGeometry(0.41, 0.31), std({ color: '#efe9dc', roughness: 0.95 }));
  matte.position.z = 0.0145;
  const photoPlane = new Mesh(new PlaneGeometry(0.32, 0.24), new MeshBasicMaterial({ color: '#888' }));
  photoPlane.position.z = 0.0152;
  const photoGlass = new Mesh(new PlaneGeometry(0.41, 0.31), phys({ color: '#ffffff', roughness: 0.03, transparent: true, opacity: 0.1, envMapIntensity: 2.2, clearcoat: 1, depthWrite: false }));
  photoGlass.position.z = 0.0175;
  for (const m of [frameOuter, matte, photoPlane, photoGlass]) {
    m.userData.objectId = 'photograph';
    pickables.push(m);
    photoG.add(m);
  }
  frameOuter.castShadow = true;
  scene.add(photoG);
  roots.photograph = photoG;

  // ——— Bookcase ———
  const bc = new Group();
  bc.position.set(-2.32, 0, 1.35);
  const bcMat = lightWoodMat;
  const panel = (w: number, h: number, d: number, x: number, y: number, z: number, surface?: string) => {
    const m = new Mesh(new BoxGeometry(w, h, d), bcMat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    if (surface) {
      m.userData.surface = surface;
      surfaces.push(m);
    }
    bc.add(m);
    occluders.push(m);
    return m;
  };
  panel(0.34, 1.92, 0.025, 0, 0.96, -0.5);
  panel(0.34, 1.92, 0.025, 0, 0.96, 0.5);
  panel(0.015, 1.92, 1.0, -0.165, 0.96, 0);
  for (const y of [0.09, 0.49, 0.89, 1.29, 1.69, 1.905]) panel(0.34, 0.022, 0.98, 0, y - 0.011, 0, 'shelf');
  scene.add(bc);
  roots.bookcase = bc;
  blob(0.6, 1.3, -2.3, 1.35, 0.5);

  // Decorative static books (not interactive) to fill the shelves.
  const spineColors = ['#6b2f2f', '#2f4a6b', '#3d5a3a', '#7a6a3a', '#4a3b5a', '#8a5a3a', '#2a2a2a', '#5a6a6a'];
  const titles = ['Field Notes', 'Atlas', 'Common Birds', 'Letters', 'Tidewater', 'Recipes', 'The Tenant', 'Winter'];
  const staticBook = (y: number, z: number, h: number, t: number, ci: number, lean = 0) => {
    const tex = bookSpine(100 + ci * 7 + Math.round(z * 100), spineColors[ci % spineColors.length], titles[ci % titles.length]);
    const mats = [
      std({ color: '#efe6d2', roughness: 0.9 }),
      std({ map: tex, roughness: 0.7 }),
      std({ color: spineColors[ci % spineColors.length], roughness: 0.7 }),
      std({ color: spineColors[ci % spineColors.length], roughness: 0.7 }),
      std({ color: spineColors[ci % spineColors.length], roughness: 0.7 }),
      std({ color: spineColors[ci % spineColors.length], roughness: 0.7 }),
    ];
    const g = new BoxGeometry(0.17, h, t);
    const m = new Mesh(g, [mats[0], mats[1], mats[2], mats[3], mats[4], mats[5]]);
    m.position.set(-2.3, y + h / 2, z);
    m.rotation.x = lean;
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    occluders.push(m);
  };
  // shelf 3 (y 1.29) z 1.28..1.5
  [1.28, 1.32, 1.365, 1.41, 1.45].forEach((z, i) => staticBook(1.29, z, 0.21 + (i % 3) * 0.02, 0.038, i + 1));
  // shelf 2 (0.89) z 1.16..1.38
  [1.17, 1.21, 1.255, 1.3].forEach((z, i) => staticBook(0.89, z, 0.23 - (i % 2) * 0.02, 0.04, i + 3));
  // shelf 1 (0.49)
  [0.9, 0.945, 0.99, 1.62, 1.665, 1.71, 1.755].forEach((z, i) => staticBook(0.49, z, 0.25 - (i % 3) * 0.015, 0.042, i + 5));
  // bottom shelf: a storage box
  const box = new Mesh(new BoxGeometry(0.28, 0.3, 0.42), std({ color: '#b8ab92', roughness: 0.95 }));
  box.position.set(-2.3, 0.09 + 0.15, 1.1);
  box.castShadow = true;
  scene.add(box);
  // top shelf: a small vase
  const vase = new Mesh(new LatheGeometry([new Vector2(0, 0), new Vector2(0.04, 0), new Vector2(0.05, 0.05), new Vector2(0.03, 0.14), new Vector2(0.035, 0.18)], 24), ceramic);
  vase.position.set(-2.3, 1.69, 1.8);
  vase.castShadow = true;
  scene.add(vase);

  // Interactive books
  const books = {} as Record<BookId, Group>;
  const covers = {} as Record<BookId, Object3D>;
  const bookDims: [number, number][] = [
    [0.24, 0.045],
    [0.22, 0.04],
    [0.25, 0.05],
    [0.23, 0.042],
    [0.21, 0.038],
    [0.245, 0.046],
  ];
  const bookColors = ['#7a2a24', '#24476e', '#4e6a3a', '#6e5a2a', '#3a2e4e', '#2b2b2b'];
  const bookTitles = ['Dear Ruth', 'Night Garden', 'Interiors', 'A Quiet House', 'Patience', 'The Visitor'];
  BOOK_IDS.forEach((id, i) => {
    const [h, t] = bookDims[i];
    const g = new Group();
    const spine = bookSpine(500 + i, bookColors[i], bookTitles[i]);
    const coverMat = std({ color: bookColors[i], roughness: 0.65 });
    const pages = std({ color: '#efe6d2', roughness: 0.9 });
    // Book body: pages block + back cover; front cover hinged at spine (+x side).
    const block = new Mesh(new BoxGeometry(0.165, h - 0.006, t - 0.008), pages);
    block.position.set(-0.002, h / 2, 0);
    const spineMesh = new Mesh(new BoxGeometry(0.006, h, t), std({ map: spine, roughness: 0.6 }));
    spineMesh.position.set(0.085, h / 2, 0);
    const backCover = new Mesh(new BoxGeometry(0.17, h, 0.004), coverMat);
    backCover.position.set(0, h / 2, -t / 2 + 0.002);
    const hinge = new Group();
    hinge.position.set(0.085, 0, t / 2 - 0.002);
    const frontCover = new Mesh(new BoxGeometry(0.17, h, 0.004), coverMat);
    frontCover.position.set(-0.085, h / 2, 0);
    hinge.add(frontCover);
    for (const m of [block, spineMesh, backCover, frontCover]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.objectId = id;
      pickables.push(m);
    }
    g.add(block, spineMesh, backCover, hinge);
    scene.add(g);
    books[id] = g;
    covers[id] = hinge;
    roots[id] = g;
  });

  // Figurine: a small ceramic bird
  const bird = new Group();
  const birdMat = phys({ color: '#d9d2c4', roughness: 0.3, clearcoat: 0.8 });
  const body = new Mesh(new SphereGeometry(0.04, 24, 16), birdMat);
  body.scale.set(0.85, 0.8, 1.25);
  body.position.y = 0.05;
  const head = new Mesh(new SphereGeometry(0.024, 20, 14), birdMat);
  head.position.set(0, 0.088, 0.035);
  const beak = new Mesh(new CylinderGeometry(0, 0.007, 0.022, 10), std({ color: '#8a6a3a', roughness: 0.5 }));
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.086, 0.064);
  const eye = new Mesh(new SphereGeometry(0.004, 8, 6), darkPlastic);
  eye.position.set(0.016, 0.094, 0.048);
  const eye2 = eye.clone();
  eye2.position.x = -0.016;
  const tail = new Mesh(new BoxGeometry(0.03, 0.006, 0.05), birdMat);
  tail.position.set(0, 0.06, -0.06);
  tail.rotation.x = -0.4;
  const plinthB = new Mesh(new CylinderGeometry(0.035, 0.038, 0.012, 20), lightWoodMat);
  plinthB.position.y = 0.006;
  for (const m of [body, head, beak, eye, eye2, tail, plinthB]) {
    m.castShadow = true;
    m.userData.objectId = 'figurine';
    pickables.push(m);
    bird.add(m);
  }
  scene.add(bird);
  roots.figurine = bird;

  // ——— Small table with cup and note ———
  const table = new Group();
  table.position.set(1.35, 0, 1.35);
  const tTop = new Mesh(new CylinderGeometry(0.36, 0.36, 0.03, 48), deskMat);
  tTop.position.y = 0.605;
  tTop.castShadow = tTop.receiveShadow = true;
  tTop.userData.surface = 'table_top';
  surfaces.push(tTop);
  const tPole = new Mesh(new CylinderGeometry(0.03, 0.04, 0.58, 16), deskMat);
  tPole.position.y = 0.3;
  const tFoot = new Mesh(new CylinderGeometry(0.2, 0.22, 0.03, 32), deskMat);
  tFoot.position.y = 0.015;
  for (const m of [tPole, tFoot]) m.castShadow = true;
  table.add(tTop, tPole, tFoot);
  scene.add(table);
  roots.table = table;
  occluders.push(tTop, tPole);
  blob(0.95, 0.95, 1.35, 1.35, 0.55);

  const cup = new Group();
  const cupBody = new Mesh(
    new LatheGeometry([new Vector2(0, 0), new Vector2(0.036, 0), new Vector2(0.04, 0.01), new Vector2(0.042, 0.085), new Vector2(0.038, 0.085), new Vector2(0.036, 0.012), new Vector2(0, 0.012)], 32),
    ceramic,
  );
  const cupHandle = new Mesh(new TorusGeometry(0.022, 0.006, 10, 20, Math.PI), ceramic);
  cupHandle.rotation.z = -Math.PI / 2;
  cupHandle.position.set(0.042, 0.045, 0);
  const coffee = new Mesh(new CylinderGeometry(0.036, 0.036, 0.002, 24), std({ color: '#2a1a10', roughness: 0.15 }));
  coffee.position.y = 0.06;
  for (const m of [cupBody, cupHandle, coffee]) {
    m.castShadow = true;
    m.userData.objectId = 'cup';
    pickables.push(m);
    cup.add(m);
  }
  scene.add(cup);
  roots.cup = cup;

  const note = new Mesh(new PlaneGeometry(0.11, 0.14), std({ map: noteTexture(), roughness: 0.92 }));
  note.rotation.x = -Math.PI / 2;
  note.rotation.z = 0.35;
  note.position.set(1.47, 0.622, 1.44);
  note.receiveShadow = true;
  note.userData.objectId = 'note';
  pickables.push(note);
  scene.add(note);
  roots.note = note;

  // ——— Clock ———
  const clock = new Group();
  const cc = PLACEMENTS.clock.center;
  clock.position.set(cc[0], cc[1], cc[2]);
  clock.rotation.y = -Math.PI / 2;
  const rim = new Mesh(new CylinderGeometry(0.18, 0.18, 0.045, 48), std({ color: '#2a2622', roughness: 0.4, metalness: 0.3 }));
  rim.rotation.x = Math.PI / 2;
  const face = new Mesh(new CylinderGeometry(0.165, 0.165, 0.002, 48), std({ map: clockFace(), roughness: 0.6 }));
  face.rotation.x = Math.PI / 2;
  face.rotation.y = Math.PI / 2;
  face.position.z = 0.023;
  // Map the face texture onto the cylinder cap correctly.
  const clockGlass = new Mesh(new CylinderGeometry(0.168, 0.168, 0.002, 48), glass);
  clockGlass.rotation.x = Math.PI / 2;
  clockGlass.position.z = 0.03;
  const handMat = std({ color: '#141210', roughness: 0.4 });
  const mkHand = (len: number, w: number, z: number, mat: Material = handMat) => {
    const pivot = new Group();
    const m = new Mesh(new BoxGeometry(w, len, 0.003), mat);
    m.position.y = len / 2 - 0.015;
    pivot.add(m);
    pivot.position.z = z;
    m.userData.objectId = 'clock';
    pickables.push(m);
    clock.add(pivot);
    return pivot;
  };
  const hourHand = mkHand(0.09, 0.012, 0.026);
  const minuteHand = mkHand(0.13, 0.008, 0.027);
  const secondHand = mkHand(0.14, 0.003, 0.028, std({ color: '#8a2a1a', roughness: 0.4 }));
  for (const m of [rim, face, clockGlass]) {
    m.userData.objectId = 'clock';
    pickables.push(m);
    clock.add(m);
  }
  rim.castShadow = true;
  scene.add(clock);
  roots.clock = clock;

  // ——— Door and hallway ———
  const doorFrameMat = trimMat;
  const jamb = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new Mesh(new BoxGeometry(w, h, d), doorFrameMat);
    m.position.set(x, y, z);
    m.castShadow = true;
    scene.add(m);
  };
  jamb(0.12, dH + 0.06, 0.05, ROOM.maxX, (dH + 0.06) / 2, dz0 - 0.025);
  jamb(0.12, dH + 0.06, 0.05, ROOM.maxX, (dH + 0.06) / 2, dz1 + 0.025);
  jamb(0.12, 0.06, dz1 - dz0 + 0.1, ROOM.maxX, dH + 0.03, (dz0 + dz1) / 2);
  const doorPivot = new Group();
  doorPivot.position.set(ROOM.maxX - 0.02, 0, dz0);
  const slab = new Mesh(new BoxGeometry(0.04, dH - 0.01, dz1 - dz0 - 0.01), std({ color: '#ece6da', roughness: 0.55 }));
  slab.position.set(0, (dH - 0.01) / 2, (dz1 - dz0) / 2);
  slab.castShadow = slab.receiveShadow = true;
  // Panel detail
  for (const [py, ph] of [[1.45, 0.75], [0.55, 0.75]] as const) {
    const p = new Mesh(new BoxGeometry(0.012, ph, 0.6), std({ color: '#e4ddd0', roughness: 0.6 }));
    p.position.set(-0.024, py, (dz1 - dz0) / 2);
    doorPivot.add(p);
  }
  const doorHandle = new Group();
  doorHandle.position.set(-0.035, 1.0, dz1 - dz0 - 0.08);
  const knob = new Mesh(new BoxGeometry(0.02, 0.022, 0.11), brass);
  knob.position.set(-0.01, 0, -0.045);
  const rose = new Mesh(new CylinderGeometry(0.025, 0.025, 0.01, 20), brass);
  rose.rotation.z = Math.PI / 2;
  doorHandle.add(knob, rose);
  doorPivot.add(slab, doorHandle);
  for (const m of [slab, knob, rose]) {
    m.userData.objectId = 'door';
    pickables.push(m);
  }
  scene.add(doorPivot);
  roots.door = doorPivot;
  occluders.push(slab);

  const hallMat = std({ color: '#3a3833', roughness: 0.95 });
  const hall = new Group();
  const hw = 2.4;
  const hz0 = -1.7;
  const hz1 = 0.1;
  const hallFloor = new Mesh(new PlaneGeometry(hw, hz1 - hz0), std({ map: floorWood.map, color: '#555', roughness: 0.8 }));
  hallFloor.rotation.x = -Math.PI / 2;
  hallFloor.position.set(ROOM.maxX + hw / 2, 0, (hz0 + hz1) / 2);
  const hallCeil = new Mesh(new PlaneGeometry(hw, hz1 - hz0), hallMat);
  hallCeil.rotation.x = Math.PI / 2;
  hallCeil.position.set(ROOM.maxX + hw / 2, H, (hz0 + hz1) / 2);
  const hallN = new Mesh(new PlaneGeometry(hw, H), hallMat);
  hallN.position.set(ROOM.maxX + hw / 2, H / 2, hz0);
  const hallS = new Mesh(new PlaneGeometry(hw, H), hallMat);
  hallS.rotation.y = Math.PI;
  hallS.position.set(ROOM.maxX + hw / 2, H / 2, hz1);
  const hallEnd = new Mesh(new PlaneGeometry(hz1 - hz0, H), hallMat);
  hallEnd.rotation.y = -Math.PI / 2;
  hallEnd.position.set(ROOM.maxX + hw, H / 2, (hz0 + hz1) / 2);
  // The outer side of the room's east wall, seen from the hallway.
  const hallBackA = new Mesh(new PlaneGeometry(dz0 - hz0, H), hallMat);
  hallBackA.rotation.y = Math.PI / 2;
  hallBackA.position.set(ROOM.maxX + 0.001, H / 2, (hz0 + dz0) / 2);
  const hallBackB = new Mesh(new PlaneGeometry(hz1 - dz1, H), hallMat);
  hallBackB.rotation.y = Math.PI / 2;
  hallBackB.position.set(ROOM.maxX + 0.001, H / 2, (dz1 + hz1) / 2);
  hall.add(hallFloor, hallCeil, hallN, hallS, hallEnd, hallBackA, hallBackB);
  hall.traverse((o) => {
    if ((o as Mesh).isMesh) {
      o.receiveShadow = true;
      occluders.push(o);
    }
  });
  scene.add(hall);
  const hallLight = new PointLight('#9aa6c0', 0.35, 4, 2);
  hallLight.position.set(ROOM.maxX + hw - 0.3, 2.2, (hz0 + hz1) / 2);
  scene.add(hallLight);

  // ——— Mirror ———
  const mirrorG = new Group();
  const mc = PLACEMENTS.mirror.center;
  mirrorG.position.set(mc[0], mc[1], mc[2]);
  mirrorG.rotation.y = Math.PI;
  const mFrame = new Mesh(new BoxGeometry(0.72, 1.12, 0.035), phys({ color: '#2e241c', roughness: 0.4, clearcoat: 0.5 }));
  mFrame.castShadow = true;
  const mirror = new Reflector(new PlaneGeometry(0.62, 1.02), {
    textureWidth: 512,
    textureHeight: 832,
    clipBias: 0.003,
    color: new Color('#c9c9c4'),
    shader: MIRROR_SHADER,
  });
  mirror.position.z = 0.019;
  mFrame.userData.objectId = 'mirror';
  mirror.userData.objectId = 'mirror';
  pickables.push(mFrame, mirror as unknown as Mesh);
  mirrorG.add(mFrame, mirror);
  scene.add(mirrorG);
  roots.mirror = mirrorG;

  // ——— Ceiling fan ———
  const fan = new Group();
  fan.position.set(0, H, 0);
  const rodF = new Mesh(new CylinderGeometry(0.012, 0.012, 0.25, 10), brass);
  rodF.position.y = -0.125;
  const housing = new Mesh(new CylinderGeometry(0.09, 0.11, 0.1, 24), brass);
  housing.position.y = -0.29;
  const rotor = new Group();
  rotor.position.y = -0.3;
  for (let i = 0; i < 5; i++) {
    const arm = new Group();
    arm.rotation.y = (i / 5) * Math.PI * 2;
    const blade = new Mesh(new BoxGeometry(0.62, 0.008, 0.13), deskMat);
    blade.position.x = 0.42;
    blade.rotation.x = 0.12;
    blade.castShadow = false;
    arm.add(blade);
    rotor.add(arm);
  }
  fan.add(rodF, housing, rotor);
  scene.add(fan);
  roots.fan = fan;

  // Light switch plate near the door (decoration)
  const plate = new Mesh(new BoxGeometry(0.008, 0.11, 0.07), trimMat);
  plate.position.set(ROOM.maxX - 0.004, 1.2, dz1 + 0.18);
  scene.add(plate);

  // ——— Lights ———
  const hemi = new HemisphereLight('#dfe7f0', '#6b5544', 0.85);
  scene.add(hemi);
  const sun = new DirectionalLight('#fff0d8', 2.6);
  sun.position.copy(SUN_POS);
  sun.target.position.copy(SUN_TARGET);
  scene.add(sun, sun.target);
  if (opts.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -3.5;
    sc.right = 3.5;
    sc.top = 3.5;
    sc.bottom = -3.5;
    sc.near = 1;
    sc.far = 14;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 3;
  }
  const windowLight = new RectAreaLight('#e8eef5', 3.2, fw, fh);
  windowLight.position.set(fcx, fcy, nz + 0.05);
  windowLight.lookAt(fcx, fcy - 0.6, 0);
  scene.add(windowLight);

  // ——— The figure (only ever rendered into captures and the mirror) ———
  const figure = new Mesh(new CapsuleGeometry(0.2, 1.25, 6, 16), FIGURE_MATERIAL);
  figure.position.set(0.15, 0.85, 0.45);
  figure.layers.set(LAYER_FIGURE);
  scene.add(figure);

  // ——— Invisible shadow caster for shadow_pass ———
  const shadowCaster = new Mesh(new BoxGeometry(0.32, 1.55, 0.22), new MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  shadowCaster.castShadow = true;
  shadowCaster.visible = false;
  shadowCaster.position.set(-0.5, 1.0, -1.5);
  scene.add(shadowCaster);

  // ——— Dust in the light beam ———
  const dust = makeDust(opts.dust ? 520 : 160, rng, { x0: winX0, x1: winX1, y0: winY0, y1: winY1, z: nz }, new Vector3().subVectors(SUN_TARGET, SUN_POS).normalize());
  scene.add(dust);

  const parts: RoomParts = {
    drawers: { drawer_top: dTop.g, drawer_bottom: dBot.g },
    doorPivot,
    doorHandle,
    clockHands: { hour: hourHand, minute: minuteHand, second: secondHand },
    fanRotor: rotor,
    curtains: { left: curtainL, right: curtainR, material: curtainMat },
    lamp: { bulb, shade, shadeMat, bulbMat, light: lampLight },
    chair,
    books,
    bookCovers: covers,
    figurine: bird,
    cup,
    note,
    photo: { group: photoG, plane: photoPlane, glass: photoGlass },
    screen,
    mirror,
    figure,
    shadowCaster,
    dust,
    outside,
    hallLight,
  };

  return {
    scene,
    roots,
    pickables,
    occluders,
    surfaces,
    parts,
    lights: { sun, window: windowLight, hemi, monitor: monitorGlow },
    sunDirection: new Vector3().subVectors(SUN_TARGET, SUN_POS).normalize(),
    materials,
  };
}

export type { Texture };

/** Mirror shader: reflection with silvering age, subtle tint, and an anomaly distortion uniform. */
const MIRROR_SHADER = {
  name: 'AgedMirror',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uTime: { value: 0 },
    uDistort: { value: 0 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec2 vLocal;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vLocal = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uDistort;
    varying vec4 vUv;
    varying vec2 vLocal;
    #include <logdepthbuf_pars_fragment>
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }
    void main() {
      #include <logdepthbuf_fragment>
      vec4 uv = vUv;
      float wob = uDistort * (noise(vLocal * 8.0 + uTime * 0.7) - 0.5) * 0.04;
      uv.xy += vec2(wob, wob * 0.6) * uv.w;
      vec3 base = texture2DProj(tDiffuse, uv).rgb;
      // Silvering loss toward the edges and a few age spots.
      vec2 e = abs(vLocal - 0.5) * 2.0;
      float edge = smoothstep(0.82, 1.0, max(e.x, e.y));
      float spots = smoothstep(0.78, 0.92, noise(vLocal * 24.0)) * 0.35;
      vec3 c = base * color * (1.0 - edge * 0.35 - spots * 0.5);
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

const FIGURE_MATERIAL = new ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { uTime: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec3 vN; varying vec3 vV; varying float vY;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vV = normalize(-mv.xyz);
      vY = position.y;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    varying vec3 vN; varying vec3 vV; varying float vY;
    void main() {
      float core = pow(max(dot(vN, vV), 0.0), 1.5);
      float fade = smoothstep(-0.85, -0.2, vY) * (1.0 - smoothstep(0.55, 0.85, vY));
      float a = core * 0.62 * fade;
      gl_FragColor = vec4(vec3(0.02, 0.018, 0.016), a);
    }`,
});

function makeDust(count: number, rng: Rng, win: { x0: number; x1: number; y0: number; y1: number; z: number }, dir: Vector3): Points {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const wx = rng.range(win.x0, win.x1);
    const wy = rng.range(win.y0, win.y1);
    const sFloor = wy / -dir.y;
    const s = rng.range(0.05, sFloor);
    positions[i * 3] = wx + dir.x * s + rng.range(-0.08, 0.08);
    positions[i * 3 + 1] = wy + dir.y * s + rng.range(-0.05, 0.05);
    positions[i * 3 + 2] = win.z + dir.z * s;
    seeds[i] = rng.next();
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setAttribute('seed', new BufferAttribute(seeds, 1));
  const m = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uIntensity: { value: 1 }, uPixelRatio: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float seed;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vA;
      void main() {
        vec3 p = position;
        float t = uTime * (0.03 + seed * 0.04);
        p.x += sin(t * 6.2831 + seed * 40.0) * 0.06;
        p.y += sin(t * 3.1 + seed * 17.0) * 0.08 - fract(t * 0.2 + seed) * 0.05;
        p.z += cos(t * 4.0 + seed * 9.0) * 0.05;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (1.0 + seed * 2.2) * uPixelRatio * (2.4 / -mv.z);
        vA = 0.35 + 0.65 * sin(uTime * (0.5 + seed) + seed * 30.0) * 0.5 + 0.5 * 0.5;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        float a = smoothstep(0.5, 0.0, d) * vA * 0.32 * uIntensity;
        gl_FragColor = vec4(vec3(1.0, 0.95, 0.85) * a, a);
      }`,
  });
  const pts = new Points(g, m);
  pts.frustumCulled = false;
  return pts;
}
