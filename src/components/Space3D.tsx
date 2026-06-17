import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// Прямоугольник на плоскости XZ (стена или зона)
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

export function Space3D() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // ── Сцена / камера / рендерер ──────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070a);

    const camera = new THREE.PerspectiveCamera(
      55,
      mount.clientWidth / mount.clientHeight,
      0.1,
      1000,
    );

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 6.0;
    renderer.shadowMap.enabled = true; // стены отбрасывают тень → за стену не видно
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    // ── Карта окружения для отражений (делает металл «металлом») ──
    // Без отражений metalness-материал выглядит как бетон. Делаем
    // тёмный градиент-«студию»: вверху блик, внизу темно.
    const envCanvas = document.createElement('canvas');
    envCanvas.width = 16;
    envCanvas.height = 64;
    const ctx = envCanvas.getContext('2d')!;
    // Равномерная заливка — отражения одинаковые со всех сторон (без перекоса света).
    ctx.fillStyle = '#525d6a';
    ctx.fillRect(0, 0, 16, 64);
    const envTex = new THREE.CanvasTexture(envCanvas);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromEquirectangular(envTex);
    scene.environment = envRT.texture;
    envTex.dispose();
    pmrem.dispose();

    // ── Свет ───────────────────────────────────────────────
    // Общий свет слабый — иначе тени не читаются и видно за стену.
    const ambient = new THREE.AmbientLight(0x2b3a4d, 0.35);
    scene.add(ambient);
    const NORMAL_VISION = 16.65; // на 7,5% меньше прежних 18
    const DARK_VISION = NORMAL_VISION / 5; // в тёмных зонах в 5 раз меньше
    // Вся яркость — в «фонаре» игрока, он же отбрасывает тени от стен.
    const lantern = new THREE.PointLight(0xffffff, 60, NORMAL_VISION, 1);
    lantern.castShadow = true;
    lantern.shadow.mapSize.set(1024, 1024);
    lantern.shadow.camera.near = 0.5;
    lantern.shadow.camera.far = NORMAL_VISION;
    lantern.shadow.bias = -0.002;
    scene.add(lantern);

    // Личное свечение игрока — БЕЗ теней, маленький радиус.
    // Стены его не загораживают → вплотную к стене всё равно видно вокруг себя.
    const glow = new THREE.PointLight(0xffffff, 18, 5.5, 1);
    scene.add(glow);

    // ── Материал «железа» (всё, кроме игрока) ──────────────
    const ironMat = new THREE.MeshStandardMaterial({
      color: 0xb6bcc4,
      metalness: 1.0,
      roughness: 0.28,
      envMapIntensity: 0.55, // тише отражения, чтобы за стеной не подсвечивалось
    });

    // ── Пол (железная плита) ───────────────────────────────
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), ironMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // ── Стены + коллайдеры ─────────────────────────────────
    const colliders: Rect[] = [];
    const WALL_H = 4;
    const TH = 0.5; // толщина тонкой стены

    // тонкая стена: центр (x,z) и размеры по x,z
    function addWall(x: number, z: number, sx: number, sz: number) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, WALL_H, sz), ironMat);
      wall.position.set(x, WALL_H / 2, z);
      wall.castShadow = true; // загораживает свет → за стеной темно
      wall.receiveShadow = true;
      scene.add(wall);
      colliders.push({ minX: x - sx / 2, maxX: x + sx / 2, minZ: z - sz / 2, maxZ: z + sz / 2 });
    }

    // === КАРТА = ТЕКСТОВАЯ СХЕМА ===
    // '-' и '|' — стены (чёрные линии рисунка), пробел — проход.
    // Чётные строки несут горизонтальные стены, нечётные — вертикальные.
    // Рисуй прямо здесь — что нарисовано, то и станет стенами.
    const MAP = [
      '+-+-+-+-+-+-+-+-+-+-+-+-+',
      '|     |     |     |     |',
      '+ +-+ + +-+ + +-+ + +-+ +',
      '| |   | |   | |   | |   |',
      '+ + +-+ + +-+ + +-+ + + +',
      '| | |   | |   | |   | | |',
      '+ + + +-+ + +-+ + +-+ + +',
      '|                       |',
      '+ + + +-+ + +-+ + +-+ + +',
      '| | |   | |   | |   | | |',
      '+ + +-+ + +-+ + +-+ + + +',
      '| |   | |   | |   | |   |',
      '+ +-+ + +-+ + +-+ + +-+ +',
      '|     |     |     |     |',
      '+-+-+-+-+-+-+-+-+-+-+-+-+',
    ];
    const CW = 3.8; // ширина клетки в мире
    const cols = (MAP[0].length - 1) / 2;
    const rows = (MAP.length - 1) / 2;
    // координата символа схемы (lx,ly) → мир (полушаги, центр карты в нуле)
    const wx = (lx: number) => (lx / 2 - cols / 2) * CW;
    const wz = (ly: number) => (ly / 2 - rows / 2) * CW;
    for (let ly = 0; ly < MAP.length; ly++) {
      const line = MAP[ly];
      for (let lx = 0; lx < line.length; lx++) {
        const ch = line[lx];
        if (ch === '-') addWall(wx(lx), wz(ly), CW + TH, TH);      // горизонтальная стена
        else if (ch === '|') addWall(wx(lx), wz(ly), TH, CW + TH); // вертикальная стена
        // '+' пропускаем — стыки закрываются за счёт +TH
      }
    }

    // ── Тёмные зоны ────────────────────────────────────────
    const darkZones: Rect[] = []; // тёмных зон пока нет — карта изменилась
    const inDarkZone = (x: number, z: number) =>
      darkZones.some((d) => x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ);

    // Визуально помечаем тёмные зоны — чёрные плиты на полу, видно издалека.
    const zoneMarks: THREE.Mesh[] = [];
    for (const d of darkZones) {
      const w = d.maxX - d.minX;
      const h = d.maxZ - d.minZ;
      const mark = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }),
      );
      mark.rotation.x = -Math.PI / 2;
      mark.position.set(d.minX + w / 2, 0.03, d.minZ + h / 2); // чуть выше пола
      scene.add(mark);
      zoneMarks.push(mark);
    }

    // ── Игрок: белый человечек с руками и ногами ───────────
    const player = new THREE.Group();
    const whiteMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.4, // светится, чтобы быть видимым в темноте
      roughness: 0.9,
      metalness: 0,
    });

    // туловище
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.6, 6, 12), whiteMat);
    torso.position.y = 1.3;
    // голова
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.33, 16, 16), whiteMat);
    head.position.y = 2.05;
    // нос — куда смотрит
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.35, 12),
      new THREE.MeshStandardMaterial({ color: 0x4c84c9, emissive: 0x4c84c9, emissiveIntensity: 0.6 }),
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 2.05, 0.33);
    player.add(torso, head, nose);

    // конечность: группа с пивотом в плече/бедре, меш свисает вниз
    function makeLimb(px: number, py: number, len: number, rad: number) {
      const g = new THREE.Group();
      g.position.set(px, py, 0);
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(rad, len, 4, 8), whiteMat);
      mesh.position.y = -(len / 2 + rad); // свисает от пивота
      g.add(mesh);
      player.add(g);
      return g;
    }
    const leftArm = makeLimb(-0.42, 1.6, 0.5, 0.11);
    const rightArm = makeLimb(0.42, 1.6, 0.5, 0.11);
    const leftLeg = makeLimb(-0.18, 0.85, 0.55, 0.14);
    const rightLeg = makeLimb(0.18, 0.85, 0.55, 0.14);

    player.position.set(0, 0, 0); // старт — центральный коридор лабиринта
    scene.add(player);

    // ── Клавиатура ─────────────────────────────────────────
    const keys: Record<string, boolean> = {};
    let mapView = false; // режим осмотра всей карты (клавиша M)
    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.code] = true;
      if (e.code === 'KeyM') mapView = !mapView;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => { keys[e.code] = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // ── Коллизия ───────────────────────────────────────────
    const PLAYER_R = 0.6;
    function resolveCollision(pos: THREE.Vector3) {
      for (const b of colliders) {
        const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
        const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
        const dx = pos.x - cx, dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > PLAYER_R * PLAYER_R) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2), push = PLAYER_R - d;
          pos.x += (dx / d) * push;
          pos.z += (dz / d) * push;
        } else {
          const l = pos.x - b.minX, r = b.maxX - pos.x, t = pos.z - b.minZ, bo = b.maxZ - pos.z;
          const m = Math.min(l, r, t, bo);
          if (m === l) pos.x = b.minX - PLAYER_R;
          else if (m === r) pos.x = b.maxX + PLAYER_R;
          else if (m === t) pos.z = b.minZ - PLAYER_R;
          else pos.z = b.maxZ + PLAYER_R;
        }
      }
    }

    // ── Цикл ───────────────────────────────────────────────
    const clock = new THREE.Clock();
    let frameId = 0;
    let faceAngle = 0;
    let vision = NORMAL_VISION;
    let walkPhase = 0;
    let walkAmt = 0; // 0 — стоит, 1 — идёт (для плавного старта/стопа)

    function animate() {
      frameId = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);

      const speed = 5;
      let mx = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0);
      let mz = (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0) - (keys['KeyW'] || keys['ArrowUp'] ? 1 : 0);
      const len = Math.hypot(mx, mz);
      const moving = len > 0;

      if (moving) {
        mx /= len; mz /= len;
        player.position.x += mx * speed * dt;
        player.position.z += mz * speed * dt;
        faceAngle = Math.atan2(mx, mz);
      }
      player.rotation.y = faceAngle;
      resolveCollision(player.position);

      // ── анимация ходьбы ──
      walkAmt += ((moving ? 1 : 0) - walkAmt) * Math.min(1, dt * 10);
      if (moving) walkPhase += dt * 9;
      const s = Math.sin(walkPhase);
      const armAmp = 0.7 * walkAmt;
      const legAmp = 0.8 * walkAmt;
      // противоход: левая рука с правой ногой
      leftArm.rotation.x = s * armAmp;
      rightArm.rotation.x = -s * armAmp;
      leftLeg.rotation.x = -s * legAmp;
      rightLeg.rotation.x = s * legAmp;
      // лёгкое покачивание корпуса при ходьбе
      player.position.y = Math.abs(Math.sin(walkPhase)) * 0.06 * walkAmt;

      if (mapView) {
        // ── Режим карты: вся темнота убрана, видно карту целиком ──
        ambient.intensity = 1.4;
        lantern.distance = 200;
        glow.distance = 200;
        lantern.position.set(player.position.x, 30, player.position.z);
        glow.position.set(player.position.x, 30, player.position.z);
        zoneMarks.forEach((m) => (m.visible = false));
        // камера высоко над центром — видно всю карту
        camera.position.set(0, 52, 0.001);
        camera.lookAt(0, 0, 0);
      } else {
        // ── Обычный режим: фонарь + тени + тёмные зоны ──
        ambient.intensity = 0.35;
        zoneMarks.forEach((m) => (m.visible = true));

        const target = inDarkZone(player.position.x, player.position.z) ? DARK_VISION : NORMAL_VISION;
        vision += (target - vision) * Math.min(1, dt * 6);
        lantern.distance = vision;
        lantern.shadow.camera.far = vision;
        lantern.shadow.camera.updateProjectionMatrix();
        // фонарь ниже верха стен (WALL_H=4) → стены дают длинные тени, за ними темно
        lantern.position.set(player.position.x, 3.2, player.position.z);
        // личное свечение всегда рядом с игроком (без теней) — видно вокруг себя у стены
        glow.position.set(player.position.x, 2, player.position.z);
        glow.distance = Math.min(5.5, vision); // в тёмной зоне не больше обзора

        // камера сверху, под небольшим углом
        camera.position.set(player.position.x, 22, player.position.z + 11);
        camera.lookAt(player.position.x, 0, player.position.z);
      }

      renderer.render(scene, camera);
    }
    animate();

    // ── Ресайз ─────────────────────────────────────────────
    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener('resize', onResize);

    // ── Очистка ────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', onResize);
      envRT.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', overflow: 'hidden', background: '#05070a' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      <div
        style={{
          position: 'absolute', top: 12, left: 12,
          background: 'rgba(0,0,0,0.6)', color: '#fff',
          padding: '8px 12px', borderRadius: 8, fontSize: 13,
          pointerEvents: 'none', lineHeight: 1.5,
        }}
      >
        Вид сверху · <b>WASD</b> / стрелки — движение · <b>M</b> — вся карта<br />
        В тёмных зонах обзор в 5 раз меньше · железные стены с коллизией
      </div>
    </div>
  );
}
