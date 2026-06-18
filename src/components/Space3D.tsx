import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

// Прямоугольник на плоскости XZ (стена или зона)
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

// Батарейка: меш + состояние (доставлена в генератор / несётся игроком /
// заблокирована от мгновенного повторного подбора сразу после выброса)
type Battery = { group: THREE.Group; delivered: boolean; carried: boolean; locked: boolean };
const TOTAL_BATTERIES = 3;
const SAVE_KEY = 'spaidcan_save'; // ключ сохранённого прогресса в localStorage

export function Space3D({ onLogout }: { onLogout?: () => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  // Счётчик доставленных батареек, флаг победы, несёт ли игрок батарейку сейчас
  const [collected, setCollected] = useState(0);
  const [won, setWon] = useState(false);
  // started — false на главном экране (меню), true после нажатия «Играть»
  const [started, setStarted] = useState(false);
  // paused — игра на паузе (экран Escape); exited — экран выхода из игры
  const [paused, setPaused] = useState(false);
  const [exited, setExited] = useState(false);
  const pausedRef = useRef(false);            // читается из игрового цикла
  const startedRef = useRef(false);           // в меню игрок не управляется
  const getStateRef = useRef<(() => unknown) | undefined>(undefined); // снимок состояния для сохранения
  const audioRef = useRef<HTMLAudioElement | null>(null); // «лифтовая» музыка меню
  const [muted, setMuted] = useState(false);
  // runId меняется при «Играть заново» → useEffect пересоздаёт всю сцену
  const [runId, setRunId] = useState(0);

  const saveProgress = () => {
    try { const s = getStateRef.current?.(); if (s) localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* нет localStorage */ }
  };
  const resume = () => { pausedRef.current = false; setPaused(false); };
  const goToMenu = () => { saveProgress(); resume(); setStarted(false); }; // в главное меню (прогресс сохранён)
  const exitGame = () => { saveProgress(); resume(); setStarted(false); setExited(true); }; // выйти из игры
  const restart = () => {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* нет localStorage */ }
    resume(); setCollected(0); setWon(false); setRunId((r) => r + 1);
  };
  // Функция выброса батарейки — назначается внутри игрового цикла,
  // вызывается с клавиши Q.
  const dropFnRef = useRef<(() => void) | undefined>(undefined);

  // держим startedRef в синхроне со state (читается из игрового цикла)
  useEffect(() => { startedRef.current = started; }, [started]);

  // «лифтовая» музыка играет только на главном экране (меню)
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onMenu = !started && !exited && !muted;
    if (!onMenu) { a.pause(); return; }
    a.volume = 0.45;
    const tryPlay = () => { a.play().catch(() => { /* автоплей до жеста заблокирован */ }); };
    tryPlay();
    // если браузер заблокировал автоплей — запустить по первому действию пользователя
    window.addEventListener('pointerdown', tryPlay);
    window.addEventListener('keydown', tryPlay);
    return () => {
      window.removeEventListener('pointerdown', tryPlay);
      window.removeEventListener('keydown', tryPlay);
    };
  }, [started, exited, muted]);

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

    // ── Железная текстура для стен ─────────────────────────
    // Клёпаные стальные плиты: шов-сетка делит поверхность на панели,
    // по углам — заклёпки, плюс зерно/потёртости/ржавчина. Рельеф уходит
    // в bump-карту, чтобы свет фонаря ловил швы и заклёпки → читается железо.
    // Все швы стоят на краях (0/128/256), поэтому текстура тайлится бесшовно.
    function makeIronTextures() {
      const S = 256;
      const col = document.createElement('canvas'); col.width = col.height = S;
      const bmp = document.createElement('canvas'); bmp.width = bmp.height = S;
      const cx = col.getContext('2d')!;
      const bx = bmp.getContext('2d')!;

      // База
      cx.fillStyle = '#454b52'; cx.fillRect(0, 0, S, S);
      bx.fillStyle = '#9a9a9a'; bx.fillRect(0, 0, S, S); // средне-серый = плоскость панели

      // Зерно металла
      const img = cx.getImageData(0, 0, S, S);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() - 0.5) * 38;
        img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
      }
      cx.putImageData(img, 0, 0);

      // Горизонтальные следы проката
      for (let i = 0; i < 60; i++) {
        cx.strokeStyle = `rgba(20,22,26,${0.12 + Math.random() * 0.22})`;
        cx.lineWidth = Math.random() * 1.6;
        const yy = Math.random() * S;
        cx.beginPath(); cx.moveTo(0, yy); cx.lineTo(S, yy + (Math.random() - 0.5) * 12); cx.stroke();
      }

      // Пятна ржавчины
      for (let i = 0; i < 7; i++) {
        const rx = Math.random() * S, ry = Math.random() * S, rr = 12 + Math.random() * 30;
        const g = cx.createRadialGradient(rx, ry, 0, rx, ry, rr);
        g.addColorStop(0, 'rgba(120,68,38,0.40)');
        g.addColorStop(1, 'rgba(120,68,38,0)');
        cx.fillStyle = g; cx.beginPath(); cx.arc(rx, ry, rr, 0, Math.PI * 2); cx.fill();
      }

      // Швы между панелями (сетка 2×2 → линии на 0/128/256)
      const seam = (draw: (ctx: CanvasRenderingContext2D) => void) => { draw(cx); draw(bx); };
      const drawSeams = (ctx: CanvasRenderingContext2D, color: string, w: number) => {
        ctx.strokeStyle = color; ctx.lineWidth = w;
        for (const p of [0, 128, 256]) {
          ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, S); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(S, p); ctx.stroke();
        }
      };
      seam((ctx) => drawSeams(ctx, ctx === bx ? '#2c2c2c' : 'rgba(12,14,17,0.85)', 6)); // тёмная канавка = углубление

      // Заклёпки по углам панелей
      const rivet = (px: number, py: number) => {
        // цвет: тёмное кольцо + светлый блик
        const rg = cx.createRadialGradient(px - 1.5, py - 1.5, 0.5, px, py, 5);
        rg.addColorStop(0, '#9aa0a7'); rg.addColorStop(0.6, '#5b6068'); rg.addColorStop(1, '#23262b');
        cx.fillStyle = rg; cx.beginPath(); cx.arc(px, py, 5, 0, Math.PI * 2); cx.fill();
        // bump: выпуклость (светлое = выше)
        const bg = bx.createRadialGradient(px, py, 0.5, px, py, 5);
        bg.addColorStop(0, '#ffffff'); bg.addColorStop(0.7, '#c8c8c8'); bg.addColorStop(1, '#7a7a7a');
        bx.fillStyle = bg; bx.beginPath(); bx.arc(px, py, 5, 0, Math.PI * 2); bx.fill();
      };
      for (const px of [0, 64, 128, 192, 256]) for (const py of [0, 64, 128, 192, 256]) rivet(px, py);

      const map = new THREE.CanvasTexture(col);
      const bump = new THREE.CanvasTexture(bmp);
      for (const t of [map, bump]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2.5, 1); }
      return { map, bump };
    }
    const ironTex = makeIronTextures();
    const wallMat = new THREE.MeshStandardMaterial({
      map: ironTex.map,
      bumpMap: ironTex.bump,
      bumpScale: 1.2, // рельеф швов/заклёпок ловит свет
      color: 0x7c828a,
      metalness: 1.0,
      roughness: 0.5, // матовее пола → железо, не зеркало
      envMapIntensity: 0.45,
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
      const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, WALL_H, sz), wallMat);
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
      "        +-+-+-+                 +-+-+-+                      ",
      "                                |     |                      ",
      "    +-+-+     +-+-+-+       +-+-+     +-+-+         +-+-+-+  ",
      "    |               |       |             |         |     |  ",
      "+-+-+   +-+-+-+     +-+-+   +             +   +-+-+-+     +-+",
      "|       |     |         |   |             |                 |",
      "+       +     +-+-+-+-+ +   +             +   +             +",
      "|       |             | |   |             |   |             |",
      "+       +     +-+-+-+-+ +   +             +   + +-+-+-+-+-+-+",
      "|                                             |             |",
      "+       +     +-+-+-+-+ +   +             +   +-+-+-+-+-+-+-+",
      "|       |             | |   |             |   |             |",
      "+       +     +-+-+-+-+ +   +             +   +             +",
      "|       |     |         |   |             |                 |",
      "+ +-+   +-+-+-+     +-+-+   +             +   +-+-+-+     +-+",
      "    |               |       |             |         |     |  ",
      "    +-+-+     +-+-+-+       +-+-+     +-+-+         +-+-+-+  ",
      "        |     |                 |     |                      ",
      "        +-+-+-+                 +-+-+-+                      ",
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

    // ── Внешняя стена: запечатываем карту по краю сетки ────
    // Схема дырявая по периметру (особенно верх/низ между комнатами) — без этой
    // рамки игрок выходит из лабиринта в открытый мир. Стена идёт ровно по
    // крайним линиям схемы (row0/rowMax, col0/colMax) и закрывает все щели.
    {
      const bxMin = wx(0), bxMax = wx(cols * 2);
      const bzMin = wz(0), bzMax = wz(rows * 2);
      const bcx = (bxMin + bxMax) / 2, bcz = (bzMin + bzMax) / 2;
      const bW = bxMax - bxMin, bH = bzMax - bzMin;
      addWall(bcx, bzMin, bW + TH, TH); // верхняя
      addWall(bcx, bzMax, bW + TH, TH); // нижняя
      addWall(bxMin, bcz, TH, bH + TH); // левая
      addWall(bxMax, bcz, TH, bH + TH); // правая
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

    // ── Генератор на стене северной комнаты ────────────────
    // Светящийся энергошар (как на скрине, но КРАСНЫЙ, без мелких линий —
    // только сфера-свечение). Вмонтирован заподлицо в верхнюю стену северной
    // комнаты (сплошная стена севернее зала, грань z=-16.85), не мигает.
    const GEN_X = 9.5, GEN_Z = -17.9, GEN_Y = 2.0; // вдавлен в стену: наружу торчит только красный круг
    const generator = new THREE.Group();
    // красные оболочки свечения (аддитивные, без записи глубины — мягкий ореол)
    const genShell = (color: number, r: number, op: number) => {
      const m = new THREE.Mesh(
        // полусфера: свечение только спереди (+Z, в зал), сзади открыто → нет отблеска за стеной
        new THREE.SphereGeometry(r, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: op,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      m.rotation.x = Math.PI / 2; // купол свечения развёрнут в зал
      return m;
    };
    generator.add(
      genShell(0xff0000, 0.9, 0.6),
      genShell(0xcc0000, 1.4, 0.34),
      genShell(0x700000, 2.0, 0.18),
    );
    // ── Оболочка из чёрного металла — только сзади и по бокам ──
    // Полусфера-кожух закрывает зад и боковины (уходят в стену → их не видно),
    // спереди открыта, поэтому красное свечение бьёт только в зал.
    const blackMetal = new THREE.MeshStandardMaterial({
      color: 0x0b0b0d, metalness: 1.0, roughness: 0.35, envMapIntensity: 0.5,
      side: THREE.DoubleSide,
    });
    const casing = new THREE.Mesh(
      new THREE.SphereGeometry(1.35, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2),
      blackMetal,
    );
    casing.rotation.x = -Math.PI / 2; // открытой стороной в зал (+Z), металл — в стену
    casing.castShadow = true; casing.receiveShadow = true;
    generator.add(casing);
    // красный свет в окружение (поярче и подальше)
    const genLight = new THREE.PointLight(0xff0a05, 13, 16, 2);
    genLight.position.set(0, 0, 1.7);   // вынесен в зал, перед стеной
    genLight.castShadow = true;          // стена перекрывает свет → за карту не светит
    genLight.shadow.mapSize.set(512, 512);
    genLight.shadow.camera.near = 0.3;
    genLight.shadow.camera.far = 16;
    generator.add(genLight);
    generator.position.set(GEN_X, GEN_Y, GEN_Z);
    scene.add(generator);

    // Плоский красный «глазок» на грани стены. MeshBasicMaterial не зависит от
    // света → круг всегда один и тот же насыщенный красный и вблизи, и издалека
    // (аддитивное свечение вблизи выцветает на освещённой фонарём стене, диск — нет).
    const eyeDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.85, 40),
      new THREE.MeshBasicMaterial({ color: 0xff0000 }),
    );
    eyeDisc.position.set(GEN_X, GEN_Y, -16.84); // на южной грани стены, лицом в зал
    scene.add(eyeDisc);

    // красное световое пятно на полу под генератором (отблеск его свечения)
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 128;
    const gc = glowCanvas.getContext('2d')!;
    const grd = gc.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,20,10,0.9)');
    grd.addColorStop(0.5, 'rgba(210,0,0,0.4)');
    grd.addColorStop(1, 'rgba(110,0,0,0)');
    gc.fillStyle = grd; gc.fillRect(0, 0, 128, 128);
    const floorGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(glowCanvas),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    floorGlow.rotation.x = -Math.PI / 2;
    floorGlow.position.set(GEN_X, 0.03, GEN_Z + 3); // на полу, перед генератором (в зал)
    scene.add(floorGlow);

    // коллизия — игрок не проходит сквозь генератор
    const GEN_R = 1.2;
    const genRect: Rect = { minX: GEN_X - GEN_R, maxX: GEN_X + GEN_R, minZ: GEN_Z - GEN_R, maxZ: GEN_Z + GEN_R };
    colliders.push(genRect);

    // ── Батарейки ──────────────────────────────────────────
    // Спавнятся ОДИН раз в начале (3 шт.) по краям главного коридора (z=0),
    // который тянется от левого до правого края карты. Светятся зелёным,
    // чтобы их было видно в темноте. Игрок подбирает одну за раз, несёт к
    // генератору; при касании коллизий батарейка исчезает (доставлена).
    function makeBattery(x: number, z: number): Battery {
      const g = new THREE.Group();
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0x2bd24f, emissive: 0x16a030, emissiveIntensity: 0.9,
        metalness: 0.6, roughness: 0.3,
      });
      const capMat = new THREE.MeshStandardMaterial({
        color: 0xdddddd, emissive: 0x777777, emissiveIntensity: 0.3,
        metalness: 0.9, roughness: 0.4,
      });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.8, 16), bodyMat);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.12, 12), capMat);
      cap.position.y = 0.46;
      // «+» полоска сверху, чтобы читалось как батарейка
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(0.285, 0.285, 0.1, 16),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xaaaaaa, emissiveIntensity: 0.4 }),
      );
      band.position.y = 0.28;
      g.add(body, band, cap);
      // личное свечение — батарейку видно в темноте издалека
      const bl = new THREE.PointLight(0x33ff66, 5, 5, 2);
      bl.position.y = 0.35;
      g.add(bl);
      g.position.set(x, 0.55, z);
      scene.add(g);
      return { group: g, delivered: false, carried: false, locked: false };
    }
    // позиции у КРАЁВ карты, но каждый запуск случайные (не всегда одно место).
    // Три проходимые зоны, каждая прижата к своему краю карты; внутри зоны
    // координата выбирается случайно:
    //  • левый край  — высокая комната у западной стены (её стена = край карты)
    //  • правый край — конец главного коридора у восточной стены
    //  • верхний край — северный коридор, ведущий к генератору
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const BATTERY_SPAWNS: [number, number][] = [
      [rand(-53, -51), rand(-6, 6)],  // у западного края
      [rand(51, 54), rand(5, 7)],     // у юго-восточного края
      [rand(51, 54), rand(-7, -5)],   // у северо-восточного края
    ];
    const batteries: Battery[] = BATTERY_SPAWNS.map(([x, z]) => makeBattery(x, z));

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
    player.add(torso, head);

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

    player.position.set(9.5, 0, 0); // старт — ровно в центре центрального квадратного зала
    player.scale.setScalar(2);      // игрок в 2 раза больше (хитбокс — PLAYER_R ниже)
    scene.add(player);

    // ── Клавиатура ─────────────────────────────────────────
    const keys: Record<string, boolean> = {};
    let mapView = false; // режим осмотра всей карты (клавиша M)
    const onKeyDown = (e: KeyboardEvent) => {
      if (!startedRef.current) return; // на меню клавиши игнорируются
      keys[e.code] = true;
      if (e.code === 'Escape' && !finished) { // пауза / снятие паузы
        pausedRef.current = !pausedRef.current;
        setPaused(pausedRef.current);
        return;
      }
      if (e.code === 'KeyM') mapView = !mapView;
      if (e.code === 'KeyQ') dropFnRef.current?.(); // выбросить батарейку
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => { keys[e.code] = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // ── Коллизия ───────────────────────────────────────────
    const PLAYER_R = 1.2;   // хитбокс в 2 раза больше прежних 0.6
    const PICKUP_R = 2.0;   // радиус подбора — с большим игроком берём дальше
    // Выталкивает круг радиуса `radius` из всех стен. Используется и для игрока,
    // и для выброшенной батарейки (чтобы она не застряла в стене).
    function resolveCircle(pos: THREE.Vector3, radius: number) {
      for (const b of colliders) {
        const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
        const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
        const dx = pos.x - cx, dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > radius * radius) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2), push = radius - d;
          pos.x += (dx / d) * push;
          pos.z += (dz / d) * push;
        } else {
          const l = pos.x - b.minX, r = b.maxX - pos.x, t = pos.z - b.minZ, bo = b.maxZ - pos.z;
          const m = Math.min(l, r, t, bo);
          if (m === l) pos.x = b.minX - radius;
          else if (m === r) pos.x = b.maxX + radius;
          else if (m === t) pos.z = b.minZ - radius;
          else pos.z = b.maxZ + radius;
        }
      }
    }
    const resolveCollision = (pos: THREE.Vector3) => resolveCircle(pos, PLAYER_R);

    // ── Цикл ───────────────────────────────────────────────
    const clock = new THREE.Clock();
    let frameId = 0;
    let faceAngle = 0;
    let vision = NORMAL_VISION;
    let walkPhase = 0;
    let walkAmt = 0; // 0 — стоит, 1 — идёт (для плавного старта/стопа)

    // ── Состояние батареек ──
    let carrying: Battery | null = null; // батарейка в руках (или null)
    let collectedCount = 0;              // сколько доставлено в генератор

    // Выбросить батарейку: кладём её обратно на пол под игроком.
    const drop = () => {
      if (!carrying) return;
      carrying.carried = false;
      carrying.locked = true; // не подбирать сразу же — пока игрок не отойдёт
      // бросаем чуть вперёд, чтобы батарейка не касалась игрока
      const fx = Math.sin(faceAngle), fz = Math.cos(faceAngle);
      const p = new THREE.Vector3(
        player.position.x + fx * 2.4,
        0.55,
        player.position.z + fz * 2.4,
      );
      resolveCircle(p, 0.4); // если бросили в стену — вытолкнуть наружу
      carrying.group.position.copy(p);
      carrying = null;
    };
    dropFnRef.current = drop;
    let finished = false; // победа достигнута (Escape больше не ставит на паузу)
    pausedRef.current = false;

    // ── Загрузка сохранённого прогресса ────────────────────
    // Если есть сохранение — восстанавливаем счётчик, позицию игрока и батарейки
    // (доставленные/выброшенные/несомую), иначе остаётся случайный спавн.
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const sv = JSON.parse(raw) as {
          collected?: number; carryingIndex?: number | null;
          player?: { x: number; z: number; face: number };
          batteries?: { x: number; z: number; delivered: boolean; carried: boolean }[];
        };
        collectedCount = sv.collected ?? 0;
        setCollected(collectedCount);
        if (sv.player) { player.position.set(sv.player.x, 0, sv.player.z); faceAngle = sv.player.face ?? 0; }
        if (Array.isArray(sv.batteries)) {
          sv.batteries.forEach((sb, i) => {
            const b = batteries[i];
            if (!b) return;
            b.delivered = !!sb.delivered;
            b.carried = !!sb.carried;
            if (b.delivered) scene.remove(b.group);
            else b.group.position.set(sb.x, sb.carried ? 2.0 : 0.55, sb.z);
          });
          const ci = sv.carryingIndex;
          if (ci != null && batteries[ci] && !batteries[ci].delivered) {
            carrying = batteries[ci];
            carrying.carried = true;
          }
        }
      }
    } catch { /* нет localStorage или битое сохранение */ }

    // снимок текущего состояния для сохранения (вызывается из кнопок паузы)
    getStateRef.current = () => ({
      collected: collectedCount,
      carryingIndex: carrying ? batteries.indexOf(carrying) : null,
      player: { x: player.position.x, z: player.position.z, face: faceAngle },
      batteries: batteries.map((b) => ({
        x: b.group.position.x, z: b.group.position.z, delivered: b.delivered, carried: b.carried,
      })),
    });

    function animate() {
      frameId = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (pausedRef.current) { renderer.render(scene, camera); return; } // на паузе — заморозка

      const speed = carrying ? 5 * 0.67 : 5; // с батарейкой на 33% медленнее
      let mx = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0);
      let mz = (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0) - (keys['KeyW'] || keys['ArrowUp'] ? 1 : 0);
      if (!startedRef.current) { mx = 0; mz = 0; } // на меню игрок стоит (сцена = фон)
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

      // ── Батарейки: подбор / переноска / доставка ──
      if (carrying) {
        // несём батарейку чуть впереди игрока (в направлении взгляда)
        const fx = Math.sin(faceAngle), fz = Math.cos(faceAngle);
        carrying.group.position.set(
          player.position.x + fx * 1.4,
          2.0,
          player.position.z + fz * 1.4,
        );
        carrying.group.rotation.y = faceAngle;
        // доставка: коллизия батарейки касается коллизии генератора → исчезает
        const bx = carrying.group.position.x, bz = carrying.group.position.z, hb = 0.5;
        if (
          bx + hb > genRect.minX && bx - hb < genRect.maxX &&
          bz + hb > genRect.minZ && bz - hb < genRect.maxZ
        ) {
          scene.remove(carrying.group);
          carrying.delivered = true;
          carrying = null;
          collectedCount++;
          setCollected(collectedCount);
          if (collectedCount >= TOTAL_BATTERIES) {
            finished = true;
            setWon(true);
            try { localStorage.removeItem(SAVE_KEY); } catch { /* нет localStorage */ }
          }
        }
      } else {
        // подбор: если рядом лежит батарейка и руки свободны — берём.
        // Только что выброшенная батарейка заблокирована, пока игрок не отойдёт.
        for (const b of batteries) {
          if (b.delivered || b.carried) continue;
          const dx = b.group.position.x - player.position.x;
          const dz = b.group.position.z - player.position.z;
          const near = dx * dx + dz * dz < PICKUP_R * PICKUP_R;
          if (b.locked) { if (!near) b.locked = false; continue; }
          if (near) {
            b.carried = true;
            carrying = b;
            break;
          }
        }
      }
      // лежащие на полу батарейки медленно крутятся (заметнее)
      for (const b of batteries) {
        if (!b.delivered && !b.carried) b.group.rotation.y += dt * 1.5;
      }

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
      getStateRef.current = undefined;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', onResize);
      envRT.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [runId]);

  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', overflow: 'hidden', background: '#05070a' }}>
      {/* Живая 3D-сцена игры — рендерится всегда; на меню служит фоном */}
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />

      {/* «Лифтовая» музыка меню (зациклена) */}
      <audio ref={audioRef} src="/menu-music.mp3" loop preload="auto" />


      {/* HUD — только в игре */}
      {started && (
        <>
          {/* Счётчик собранных батареек — левый верхний угол */}
          <div
            style={{
              position: 'absolute', top: 12, left: 12,
              color: '#33ff66', fontSize: 30, fontWeight: 'bold',
              fontFamily: 'monospace', textShadow: '0 0 8px #000, 0 0 4px #000',
              pointerEvents: 'none',
            }}
          >
            🔋 {collected}/{TOTAL_BATTERIES}
          </div>

          {/* Подсказка управления — левый нижний угол */}
          <div
            style={{
              position: 'absolute', bottom: 12, left: 12,
              background: 'rgba(0,0,0,0.6)', color: '#fff',
              padding: '8px 12px', borderRadius: 8, fontSize: 13,
              pointerEvents: 'none', lineHeight: 1.5,
            }}
          >
            <b>WASD</b> / стрелки — движение · <b>M</b> — вся карта · <b>Q</b> — выбросить · <b>Esc</b> — пауза<br />
            Подбери батарейку (подойди к ней) и отнеси к красному генератору
          </div>
        </>
      )}

      {/* Победа — надпись на весь экран + кнопка возврата */}
      {won && (
        <div
          style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', gap: 28,
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.65)', color: '#fff',
          }}
        >
          <div
            style={{
              fontSize: 'min(15vw, 150px)', fontWeight: 'bold',
              fontFamily: 'monospace', letterSpacing: 6,
              textShadow: '0 0 24px #33ff66, 0 0 48px #33ff66',
            }}
          >
            YOU WIN
          </div>
          <button
            onClick={restart}
            style={{
              padding: '14px 32px', fontSize: 20, fontWeight: 'bold',
              fontFamily: 'monospace', background: '#2bd24f', color: '#05140a',
              border: 'none', borderRadius: 12, cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            }}
          >
            ↺ Играть заново
          </button>
        </div>
      )}

      {/* Пауза (Escape) — три кнопки */}
      {paused && !won && (
        <div
          style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', gap: 18,
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.72)', color: '#fff', fontFamily: 'monospace',
          }}
        >
          <div style={{ fontSize: 'min(9vw, 64px)', fontWeight: 'bold', letterSpacing: 6, marginBottom: 12 }}>
            ПАУЗА
          </div>
          <button
            onClick={resume}
            style={{
              width: 280, padding: '14px 0', fontSize: 20, fontWeight: 'bold', fontFamily: 'monospace',
              background: '#2bd24f', color: '#05140a', border: 'none', borderRadius: 12, cursor: 'pointer',
            }}
          >
            ▶ Вернуться
          </button>
          <button
            onClick={goToMenu}
            style={{
              width: 280, padding: '14px 0', fontSize: 20, fontWeight: 'bold', fontFamily: 'monospace',
              background: 'rgba(255,255,255,0.14)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.35)', borderRadius: 12, cursor: 'pointer',
            }}
          >
            ⌂ Главное меню
          </button>
          <button
            onClick={exitGame}
            style={{
              width: 280, padding: '14px 0', fontSize: 20, fontWeight: 'bold', fontFamily: 'monospace',
              background: '#c0392b', color: '#fff', border: 'none', borderRadius: 12, cursor: 'pointer',
            }}
          >
            ✖ Выйти из игры
          </button>
        </div>
      )}

      {/* Главный экран (меню) — затемнённый слой поверх живой сцены игры */}
      {!started && !exited && (
        <div
          style={{
            position: 'absolute', inset: 0, color: '#fff', fontFamily: 'monospace',
            // тусклый фон: сквозь полупрозрачную тёмную пелену видно сцену игры
            background: 'rgba(5,7,10,0.74)',
          }}
        >
          {/* Название игры */}
          <div
            style={{
              position: 'absolute', top: '14%', left: 0, right: 0, textAlign: 'center',
              fontSize: 'min(9vw, 84px)', fontWeight: 'bold', letterSpacing: 6,
              textShadow: '0 0 24px #ff2a1a, 0 0 48px #7a0000',
            }}
          >
            SPAID CAN ...
          </div>

          {/* Кнопка звука музыки — правый верхний угол */}
          <button
            onClick={() => setMuted((m) => !m)}
            title={muted ? 'Включить музыку' : 'Выключить музыку'}
            style={{
              position: 'absolute', top: 18, right: 18,
              width: 48, height: 48, fontSize: 22,
              background: 'rgba(255,255,255,0.12)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.35)', borderRadius: 10, cursor: 'pointer',
            }}
          >
            {muted ? '🔇' : '🔊'}
          </button>

          {/* Кнопка «Играть» — слева */}
          <button
            onClick={() => setStarted(true)}
            style={{
              position: 'absolute', top: '50%', left: '8%', transform: 'translateY(-50%)',
              padding: '20px 56px', fontSize: 28, fontWeight: 'bold', fontFamily: 'monospace',
              background: '#2bd24f', color: '#05140a', border: 'none', borderRadius: 14,
              cursor: 'pointer', boxShadow: '0 6px 22px rgba(0,0,0,0.6)',
            }}
          >
            ▶ Играть
          </button>

          {/* Кнопка «Настройки» — прямо под «Играть» */}
          <button
            onClick={() => { /* пока ничего */ }}
            style={{
              position: 'absolute', top: 'calc(50% + 58px)', left: '8%',
              padding: '14px 36px', fontSize: 18, fontWeight: 'bold', fontFamily: 'monospace',
              background: 'rgba(255,255,255,0.12)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.35)', borderRadius: 12, cursor: 'pointer',
            }}
          >
            ⚙ Настройки
          </button>

          {/* Кнопка «Выйти» — маленькая, в левом верхнем углу */}
          <button
            onClick={() => onLogout?.()}
            style={{
              position: 'absolute', top: 12, left: 12,
              padding: '6px 14px', fontSize: 13, fontWeight: 'bold', fontFamily: 'monospace',
              background: 'rgba(192,57,43,0.85)', color: '#fff',
              border: 'none', borderRadius: 8, cursor: 'pointer',
            }}
          >
            Выйти
          </button>

          {/* Настоящая морда паука (фото) — правая часть экрана, круглый кроп */}
          <img
            src="/spider-face.jpg"
            alt="Морда паука"
            style={{
              position: 'absolute', top: '50%', right: '6%', transform: 'translateY(-50%)',
              width: 'min(17vw, 210px)', height: 'min(17vw, 210px)', // круг в 2 раза меньше
              objectFit: 'cover', objectPosition: 'center', borderRadius: '50%',
              filter: 'grayscale(1) sepia(1) saturate(6) hue-rotate(-35deg) brightness(1.05)', // шерсть в красный
              border: '3px solid rgba(255,40,25,0.5)',
              boxShadow: '0 0 44px rgba(255,30,20,0.6)',
              pointerEvents: 'none',
            }}
          />
        </div>
      )}

      {/* Экран выхода из игры */}
      {exited && (
        <div
          style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', gap: 28, alignItems: 'center', justifyContent: 'center',
            background: '#05070a', color: '#fff', fontFamily: 'monospace',
          }}
        >
          <div style={{ fontSize: 'min(7vw, 56px)', fontWeight: 'bold', letterSpacing: 4, opacity: 0.85 }}>
            Игра закрыта
          </div>
          <div style={{ fontSize: 16, opacity: 0.6 }}>Прогресс сохранён</div>
          <button
            onClick={() => setExited(false)}
            style={{
              padding: '14px 36px', fontSize: 18, fontWeight: 'bold', fontFamily: 'monospace',
              background: 'rgba(255,255,255,0.12)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.35)', borderRadius: 12, cursor: 'pointer',
            }}
          >
            На главный экран
          </button>
        </div>
      )}
    </div>
  );
}
