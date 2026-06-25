import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { supabase } from '../lib/supabase';

// Прямоугольник на плоскости XZ (стена или зона)
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

// Батарейка: меш + состояние (доставлена в генератор / несётся игроком /
// заблокирована от мгновенного повторного подбора сразу после выброса)
type Battery = {
  group: THREE.Group;
  delivered: boolean;
  carried: boolean;
  locked: boolean;
  pickupAbilityGiven: boolean;
  insertAbilityGiven: boolean;
};
// Переключатель: меш + флаг активации + функция смены вида (красный↔зелёный)
type Switch = { group: THREE.Group; x: number; z: number; active: boolean; setActive: (b: boolean) => void };
// Мясо: лежит на карте, восстанавливает сытость при подборе
type Meat = { group: THREE.Group; eaten: boolean };
const SAVE_KEY = 'spaidcan_save_v2'; // ключ прогресса (v2 — сбрасываем старые сейвы, застрявшие на ур.6)
const LEVELS = 7;                 // всего уровней

// Конфиг уровня: чем дальше — тем больше батареек и рандома. Переключатели
// появляются после 3-го уровня, выступы-карманы (альковы) — после 4-го.
function levelConfig(level: number) {
  const lv = Math.min(LEVELS, Math.max(1, level));
  const finalLevel = lv === LEVELS;
  return {
    batteries: finalLevel ? 4 : 2 + lv,             // L1=3 … L6=8, L7=4
    randomness: Math.min(1, 0.12 + (lv - 1) * 0.18), // разброс спавна растёт
    switches: finalLevel ? 0 : (lv >= 3 ? lv - 2 : 0), // L7 без переключателей
    alcoves: 0, // закрытые карманы/комнаты отключены
  };
}

// ── Способности паука по уровням (накопительно) ──────────
// Перед каждым уровнем показываем заголовок «SPAID CAN <список>». На 1-м уровне
// паук умеет ТОЛЬКО двигаться, дальше каждый уровень добавляет одну способность —
// и каждая бьёт по конкретной тактике игрока (см. поле ru / counter).
const SPIDER_ABILITIES = [
  { key: 'move',  en: 'MOVE',       ru: 'двигаться' },
  { key: 'hear',  en: 'HEAR',       ru: 'СЛЫШАТЬ — идёт на шум твоих шагов (стой на месте, чтобы не услышал)' },
  { key: 'see',   en: 'SEE',        ru: 'ВИДЕТЬ — рвётся к тебе на прямой видимости (прячься за стены)' },
  { key: 'smell', en: 'SMELL',      ru: 'НЮХАТЬ — идёт по следу запаха рядом, но стены его блокируют' },
  { key: 'web',   en: 'SHOOT WEBS', ru: 'СТРЕЛЯТЬ ПАУТИНОЙ — замедляет тебя (разрывай линию видимости)' },
  { key: 'clone', en: 'CLONE',      ru: 'КЛОНИРОВАТЬСЯ — появляются ещё пауки (не загоняй себя в угол)' },
  { key: 'climb', en: 'CLIMB WALLS', ru: 'ПЕРЕЛЕЗАТЬ ЧЕРЕЗ СТЕНЫ — на последнем уровне стены его уже не держат' },
  { key: 'hunger', en: 'STARVE YOU', ru: 'МОРИТ ГОЛОДОМ — сытость тает со временем, ищи мясо (при полной не берёшь)' },
] as const;
type AbilityKey = (typeof SPIDER_ABILITIES)[number]['key'];
const ABIL_META: Record<string, { en: string; ru: string }> =
  Object.fromEntries(SPIDER_ABILITIES.map((a) => [a.key, { en: a.en, ru: a.ru }]));

// ── Адаптивность: какую способность дать в ответ на тактику игрока ──
// Считаем, как игрок ВЁЛ СЕБЯ на уровне, и на следующем добавляем способность,
// которая максимально руинит его доминирующую тактику → заставляет менять стиль.
//   still — много стоит/крадётся (молчит)        → SMELL (нюх найдёт и без шума, сквозь стены)
//   hide  — двигается, но прячется за стенами     → HEAR  (слышит шаги сквозь стены)
//   open  — часто на виду (бегает в открытую)     → SEE   (ловит на прямой видимости)
//   flee  — убегает, держит большую дистанцию     → WEB   (паутина замедляет беглеца)
//   loop  — петляет, водит кругами                → CLONE (клоны перекрывают пути)
type TacticKey = 'still' | 'hide' | 'open' | 'flee' | 'loop';
const TACTIC_COUNTER: Record<TacticKey, AbilityKey> = {
  still: 'smell', hide: 'hear', open: 'see', flee: 'web', loop: 'clone',
};
const DEFAULT_ABIL_ORDER: AbilityKey[] = ['hear', 'see', 'smell', 'web', 'hunger', 'clone'];
// Выбрать НОВУЮ способность: контра самой частой тактике, которой ещё нет у паука.
function pickCounterAbility(tactics: Record<TacticKey, number>, owned: string[]): AbilityKey | null {
  const ranked = (Object.keys(tactics) as TacticKey[])
    .filter((t) => tactics[t] > 0)
    .sort((a, b) => tactics[b] - tactics[a]);
  for (const t of ranked) {
    const c = TACTIC_COUNTER[t];
    if (!owned.includes(c)) return c;
  }
  return DEFAULT_ABIL_ORDER.find((a) => !owned.includes(a)) ?? null; // запас: по умолчанию
}

// Профиль одной ноги паука в фазе ph: продольный мах (-1..1) и подъём ступни (0..1).
// Как в природе: ОПОРА (бóльшая часть цикла) — ступня на полу, нога медленно
// загребает назад (двигает тело вперёд); ПЕРЕНОС — ступня поднята, нога быстро
// возвращается вперёд. Асимметрия «медленно назад / быстро вперёд» и есть «паучья».
function spiderLegPose(ph: number) {
  const DUTY = 0.6; // доля цикла со ступнёй на полу
  const u = (((ph % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI); // 0..1
  if (u < DUTY) {
    const s = u / DUTY;                              // опора 0..1
    return { swing: 1 - 2 * s, lift: 0 };           // вперёд → назад, ступня на полу
  }
  const w = (u - DUTY) / (1 - DUTY);                 // перенос 0..1
  const e = 0.5 - 0.5 * Math.cos(Math.PI * w);       // плавный ease назад → вперёд
  return { swing: -1 + 2 * e, lift: Math.sin(Math.PI * w) }; // подъём 0→1→0 в переносе
}

// Начальный уровень читаем из сохранения (чтобы сцена сразу строила нужный уровень)
function initialLevel(): number {
  try {
    const r = localStorage.getItem(SAVE_KEY);
    if (r) { const s = JSON.parse(r); if (s && typeof s.level === 'number') return Math.min(LEVELS, Math.max(1, s.level)); }
  } catch { /* нет localStorage */ }
  return 1;
}

export function Space3D({ onLogout }: { onLogout?: () => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  // Счётчик доставленных батареек, флаг победы, несёт ли игрок батарейку сейчас
  const [collected, setCollected] = useState(0);
  const [won, setWon] = useState(false);
  const [finalEnding, setFinalEnding] = useState(false);
  // Система уровней: текущий уровень, экран «уровень пройден», счётчики для HUD
  const [level, setLevel] = useState(initialLevel);
  const [levelCleared, setLevelCleared] = useState(false);
  const [dead, setDead] = useState(false); // паук коснулся игрока → смерть
  // Заставка перед уровнем («SPAID CAN …»), список способностей паука, эффект паутины
  const [showIntro, setShowIntro] = useState(false);
  const introRef = useRef(false);
  const [webbed, setWebbed] = useState(false); // игрок опутан паутиной (замедлен)
  const [satiety, setSatiety] = useState(3);   // сытость 0..3 (голод убывает со временем)
  const [starved, setStarved] = useState(false); // умер от голода
  const [spiderAbil, setSpiderAbil] = useState<{ en: string; ru: string }[]>([]); // способности на тек. уровне
  const [geminiSearch, setGeminiSearch] = useState(false); // Gemini ведёт паука в фазе поиска
  // Адаптивность: накопленные способности паука (контра тактикам игрока) и метрики
  // тактик за текущий уровень. Живут между уровнями через ref (не сбрасываются ререндером).
  const ownedAbilRef = useRef<string[]>(['move']);
  const tacticRef = useRef<Record<TacticKey, number>>({ still: 0, hide: 0, open: 0, flee: 0, loop: 0 });
  const [batteryCount, setBatteryCount] = useState(() => levelConfig(initialLevel()).batteries);
  const [switchCount, setSwitchCount] = useState(0);
  const [switchesOn, setSwitchesOn] = useState(0);
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
  // Громкость музыки (0..1), сохраняется между запусками; панель настроек
  const VOL_KEY = 'spaidcan_volume';
  const [volume, setVolume] = useState(() => {
    try { const v = parseFloat(localStorage.getItem(VOL_KEY) ?? ''); if (!isNaN(v)) return Math.min(1, Math.max(0, v)); } catch { /* нет localStorage */ }
    return 0.45;
  });
  const [showSettings, setShowSettings] = useState(false);
  // применяем громкость к аудио сразу и запоминаем
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    try { localStorage.setItem(VOL_KEY, String(volume)); } catch { /* нет localStorage */ }
  }, [volume]);
  // Вид от первого лица (true) ↔ от третьего (false). Кнопка переключает туда-обратно.
  const [firstPerson, setFirstPerson] = useState(false);
  const firstPersonRef = useRef(false); // читается из игрового цикла
  useEffect(() => {
    firstPersonRef.current = firstPerson;
    if (!firstPerson && document.pointerLockElement) document.exitPointerLock?.();
  }, [firstPerson]);
  // runId меняется при «Играть заново» → useEffect пересоздаёт всю сцену
  const [runId, setRunId] = useState(0);

  const saveProgress = () => {
    try { const s = getStateRef.current?.(); if (s) localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* нет localStorage */ }
  };
  const saveLevelOnly = (targetLevel: number) => {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ level: targetLevel })); } catch { /* нет localStorage */ }
  };
  const pause = () => { pausedRef.current = true; setPaused(true); };
  const resume = () => { pausedRef.current = false; setPaused(false); };
  const goToMenu = () => { saveProgress(); resume(); setStarted(false); }; // в главное меню (прогресс сохранён)
  const exitGame = () => { saveProgress(); resume(); setStarted(false); setExited(true); }; // выйти из игры
  const restart = () => {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* нет localStorage */ }
    resume(); setCollected(0); setWon(false); setLevelCleared(false); setDead(false);
    setFinalEnding(false);
    setSwitchesOn(0); setLevel(1); setBatteryCount(levelConfig(1).batteries); setSwitchCount(0);
    setWebbed(false); setShowIntro(true); setStarved(false); setSatiety(3);
    ownedAbilRef.current = ['move']; // адаптивный набор — с чистого листа
    setRunId((r) => r + 1);
  };
  // Переход на следующий уровень (после экрана «уровень пройден»).
  // АДАПТИВНОСТЬ: смотрим, как игрок вёл себя на пройденном уровне, и добавляем
  // пауку способность, которая максимально руинит его доминирующую тактику.
  const nextLevel = () => {
    const nl = Math.min(LEVELS, level + 1);
    const add = pickCounterAbility(tacticRef.current, ownedAbilRef.current);
    if (add) ownedAbilRef.current = [...ownedAbilRef.current, add];
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ level: nl })); } catch { /* нет localStorage */ }
    resume(); setLevelCleared(false); setCollected(0); setSwitchesOn(0); setWon(false); setDead(false);
    setFinalEnding(false);
    setLevel(nl); setRunId((r) => r + 1);
    setWebbed(false); setShowIntro(true); setStarved(false); setSatiety(3); // заставка нового уровня
  };
  // Функция выброса батарейки — назначается внутри игрового цикла,
  // вызывается с клавиши Q.
  const dropFnRef = useRef<(() => void) | undefined>(undefined);
  const switchFnRef = useRef<(() => void) | undefined>(undefined);
  const mobileInputRef = useRef({ mx: 0, mz: 0 });
  const joystickRef = useRef<HTMLDivElement>(null);
  const [showTouchControls, setShowTouchControls] = useState(false);
  const [stick, setStick] = useState({ x: 0, y: 0, active: false });

  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse), (max-width: 760px)');
    const sync = () => setShowTouchControls(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const updateJoystick = (clientX: number, clientY: number) => {
    const el = joystickRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const max = Math.min(r.width, r.height) * 0.34;
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    const scale = len > max ? max / len : 1;
    const sx = dx * scale;
    const sy = dy * scale;
    mobileInputRef.current = { mx: sx / max, mz: sy / max };
    setStick({ x: sx, y: sy, active: true });
  };

  const clearJoystick = () => {
    mobileInputRef.current = { mx: 0, mz: 0 };
    setStick({ x: 0, y: 0, active: false });
  };

  // держим startedRef в синхроне со state (читается из игрового цикла)
  useEffect(() => { startedRef.current = started; }, [started]);
  // заставка перед уровнем замораживает геймплей (читается из игрового цикла)
  useEffect(() => { introRef.current = showIntro; }, [showIntro]);

  // После скримера (смерти от паука) — выброс обратно в меню
  useEffect(() => {
    if (!dead) return;
    const t = setTimeout(() => {
      saveLevelOnly(level);
      setDead(false); setStarted(false);
      setCollected(0); setSwitchesOn(0); setLevel(level);
      setBatteryCount(levelConfig(level).batteries); setSwitchCount(0);
      setRunId((r) => r + 1); // пересоздать сцену с чистого листа
    }, 2400);
    return () => clearTimeout(t);
  }, [dead, level]);

  // Смерть от голода — через пару секунд выброс обратно в меню (как при скримере)
  useEffect(() => {
    if (!starved) return;
    const t = setTimeout(() => {
      saveLevelOnly(level);
      setStarved(false); setStarted(false);
      setCollected(0); setSwitchesOn(0); setLevel(level);
      setBatteryCount(levelConfig(level).batteries); setSwitchCount(0);
      setRunId((r) => r + 1); // пересоздать сцену с чистого листа
    }, 2400);
    return () => clearTimeout(t);
  }, [starved, level]);

  // «лифтовая» музыка играет только на главном экране (меню)
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onMenu = !started && !exited && !muted;
    if (!onMenu) { a.pause(); return; }
    a.volume = volume;
    const tryPlay = () => { a.play().catch(() => { /* автоплей до жеста заблокирован */ }); };
    tryPlay();
    // если браузер заблокировал автоплей — запустить по первому действию пользователя
    window.addEventListener('pointerdown', tryPlay);
    window.addEventListener('keydown', tryPlay);
    return () => {
      window.removeEventListener('pointerdown', tryPlay);
      window.removeEventListener('keydown', tryPlay);
    };
  }, [started, exited, muted, volume]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // ── Конфиг текущего уровня ─────────────────────────────
    const levelNum = level;
    const onlyMoveSpider = levelNum === LEVELS;
    let hungerActive = false; // включается только если паук получил способность hunger
    const cfg = levelConfig(levelNum);
    const batteryGoal = cfg.batteries;   // сколько батареек нужно доставить
    const switchGoal = cfg.switches;     // сколько переключателей нужно дёрнуть
    // после 1-го уровня карта чуть-чуть растёт с каждым уровнем
    const mapScale = 1 + (levelNum - 1) * 0.20; // +20% за уровень: L1=1.0 … L6=2.0
    const START_X = 9.5 * mapScale, START_Z = 0; // спавн игрока = центр центрального зала
    // центральный квадрат (в нём НЕ спавним батарейки/переключатели), масштабируется
    const CENTRAL = { minX: -5 * mapScale, maxX: 29 * mapScale, minZ: -10 * mapScale, maxZ: 10 * mapScale };
    const inCentral = (x: number, z: number) => x >= CENTRAL.minX && x <= CENTRAL.maxX && z >= CENTRAL.minZ && z <= CENTRAL.maxZ;
    // сброс HUD под новый уровень (загрузка сохранения ниже может уточнить счётчики)
    setBatteryCount(batteryGoal); setSwitchCount(switchGoal);
    setCollected(0); setSwitchesOn(0); setDead(false);

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
    // Растёт вместе с картой (+комнаты-пристройки за периметром помещаются).
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(300 * mapScale, 300 * mapScale), ironMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // ── Стены + коллайдеры ─────────────────────────────────
    const colliders: Rect[] = [];
    const wallRects: Rect[] = [];
    const wallMeshes: THREE.Mesh[] = []; // для raycaster паука (выравнивание по поверхности)
    const WALL_H = 4;
    const TH = 0.5; // толщина тонкой стены
    const centralDoorZones: { x: number; z: number; halfX: number; halfZ: number }[] = [];

    // тонкая стена: центр (x,z) и размеры по x,z
    function addWall(x: number, z: number, sx: number, sz: number) {
      const rect = { minX: x - sx / 2, maxX: x + sx / 2, minZ: z - sz / 2, maxZ: z + sz / 2 };
      const blocksCentralDoor = centralDoorZones.some((d) =>
        rect.maxX > d.x - d.halfX &&
        rect.minX < d.x + d.halfX &&
        rect.maxZ > d.z - d.halfZ &&
        rect.minZ < d.z + d.halfZ
      );
      if (blocksCentralDoor) return;

      const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, WALL_H, sz), wallMat);
      wall.position.set(x, WALL_H / 2, z);
      wall.castShadow = true; // загораживает свет → за стеной темно
      wall.receiveShadow = true;
      scene.add(wall);
      wallMeshes.push(wall);
      colliders.push(rect);
      wallRects.push(rect);
    }

    // Стена-линия с проёмами (двери). orient 'h' — вдоль X при фиксированном z;
    // 'v' — вдоль Z при фиксированном x. gaps — отрезки [от,до] по подвижной оси,
    // в которых стену НЕ строим (дверной проём).
    function wallWithGaps(orient: 'h' | 'v', fixed: number, from: number, to: number, gaps: [number, number][]) {
      const lo = Math.min(from, to), hi = Math.max(from, to);
      const sorted = gaps.slice().sort((a, b) => a[0] - b[0]);
      let cur = lo;
      const segs: [number, number][] = [];
      for (const [gs, ge] of sorted) {
        const s = Math.max(lo, Math.min(gs, hi)), e = Math.max(lo, Math.min(ge, hi));
        if (s > cur) segs.push([cur, s]);
        cur = Math.max(cur, e);
      }
      if (cur < hi) segs.push([cur, hi]);
      for (const [s, e] of segs) {
        const len = e - s;
        if (len <= 0.05) continue;
        const mid = (s + e) / 2;
        if (orient === 'h') addWall(mid, fixed, len + TH, TH);
        else addWall(fixed, mid, TH, len + TH);
      }
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
      "|       |     |             |             |                 |",
      "+       +     +-+-+-+-+ +   +             +   +             +",
      "|       |             | |   |             |   |             |",
      "+       +     +-+-+-+-+ +   +             +   + +-+-+-+-+-+-+",
      "|                       |                     |             |",
      "+       +     +-+-+-+-+ +   +             +   +-+-+-+-+-+-+-+",
      "|       |             | |   |             |   |             |",
      "+       +     +-+-+-+-+ +   +             +   +             +",
      "|       |     |             |             |                 |",
      "+ +-+   +-+-+-+     +-+-+   +             +   +-+-+-+     +-+",
      "    |               |       |             |         |     |  ",
      "    +-+-+     +-+-+-+       +-+-+     +-+-+         +-+-+-+  ",
      "        |     |                 |     |                      ",
      "        +-+-+-+                 +-+-+-+                      ",
    ];
    const CW = 3.8 * mapScale; // ширина клетки в мире (растёт с уровнем)
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

    // ── Новые комнаты-пристройки + внешняя стена с дверями ──
    // Схема дырявая по периметру. Раньше периметр просто запечатывали сплошной
    // рамкой. Теперь: находим, где коридор упирается в КРАЙ карты, пробиваем там
    // дверь во внешней стене и пристраиваем СНАРУЖИ закрытую комнату (3 новые
    // стены + стена карты с дверным проёмом). Игрок попадает в новые комнаты,
    // но в открытое пространство НЕ выходит — комнаты замкнуты со всех сторон.
    const bxMin = wx(0), bxMax = wx(cols * 2);
    const bzMin = wz(0), bzMax = wz(rows * 2);
    // расстояние до ближайшей стены КАРТЫ (периметра ещё нет — только стены схемы)
    const edgeClear = (x: number, z: number) => {
      let m = Infinity;
      for (const b of colliders) {
        const cx = Math.max(b.minX, Math.min(x, b.maxX));
        const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
        const d = Math.hypot(x - cx, z - cz);
        if (d < m) m = d;
      }
      return m;
    };
    // непрерывные «открытия» вдоль левого/правого края (там, где коридор у края)
    const edgeRuns = (side: 'L' | 'R'): [number, number][] => {
      const ex = side === 'L' ? bxMin : bxMax;
      const inX = ex + (side === 'L' ? 1 : -1) * 1.3; // точка чуть внутри карты
      const runs: [number, number][] = [];
      let start: number | null = null, last = 0;
      for (let z = bzMin + CW; z <= bzMax - CW; z += 1.0) {
        const open = edgeClear(inX, z) >= 1.3 && edgeClear(ex, z) >= 0.4;
        if (open) { if (start === null) start = z; last = z; }
        else if (start !== null) { runs.push([start, last]); start = null; }
      }
      if (start !== null) runs.push([start, last]);
      return runs;
    };
    const doorGapsL: [number, number][] = [];
    const doorGapsR: [number, number][] = [];
    /*
    const addAnnex = (side: 'L' | 'R', run: [number, number]) => {
      const ex = side === 'L' ? bxMin : bxMax;
      const dir = side === 'L' ? -1 : 1;                  // наружу от карты
      const zc = (run[0] + run[1]) / 2;
      const doorHalf = Math.min((run[1] - run[0]) / 2 + 0.4, CW * 0.7);
      const RD = 8 * mapScale;                            // глубина комнаты наружу
      const RH = Math.max(7 * mapScale, doorHalf * 2 + 4 * mapScale); // ширина по z
      const farX = ex + dir * RD;
      const midX = (ex + farX) / 2;
      addWall(farX, zc, TH, RH + TH);                     // дальняя стена комнаты
      addWall(midX, zc - RH / 2, RD + TH, TH);            // боковая
      addWall(midX, zc + RH / 2, RD + TH, TH);            // боковая
      (side === 'L' ? doorGapsL : doorGapsR).push([zc - doorHalf, zc + doorHalf]);
    };
    */
    for (const side of ['L', 'R'] as const) {
      const runs = edgeRuns(side)
        .filter((r) => r[1] - r[0] >= 1.5 * mapScale)
        .sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
      void runs;
    }
    // внешняя стена: верх/низ сплошные, лево/право — с дверными проёмами в комнаты
    {
      const bcx = (bxMin + bxMax) / 2, bW = bxMax - bxMin;
      addWall(bcx, bzMin, bW + TH, TH);                   // верхняя (сплошная)
      addWall(bcx, bzMax, bW + TH, TH);                   // нижняя (сплошная)
      wallWithGaps('v', bxMin, bzMin, bzMax, doorGapsL);  // левая с дверями
      wallWithGaps('v', bxMax, bzMin, bzMax, doorGapsR);  // правая с дверями
    }

    // ── Тёмные зоны ────────────────────────────────────────
    if (onlyMoveSpider) {
      const sideRoomZ0 = -16 * mapScale;
      const sideRoomZ1 = 16 * mapScale;
      const sideGap = 3.2 * mapScale;
      const sideRooms: { x0: number; x1: number; cx: number }[] = [];
      for (const r of sideRooms) {
        wallWithGaps('v', r.cx, sideRoomZ0, sideRoomZ1, [[-sideGap, sideGap]]);
        wallWithGaps('h', START_Z, r.x0, r.x1, [[r.cx - sideGap, r.cx + sideGap]]);
      }

      const stub = 4.2 * mapScale;
      const cornerX = 14 * mapScale;
      const cornerZ = 8.5 * mapScale;
      addWall(START_X - cornerX, START_Z - cornerZ, stub, TH);
      addWall(START_X + cornerX, START_Z - cornerZ, stub, TH);
      addWall(START_X - cornerX, START_Z + cornerZ, stub, TH);
      addWall(START_X + cornerX, START_Z + cornerZ, stub, TH);
    }

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
    const GEN_X = 9.5 * mapScale, GEN_Z = -17.9 * mapScale, GEN_Y = 2.0; // вдавлен в стену (масштаб карты)
    const genSlots: { rect: Rect; used: boolean; reusable: boolean; fill: () => void }[] = [];
    const generator = new THREE.Group();
    // Сдвиг свечения вперёд: основание ореола ставим на южную (внутреннюю) грань
    // северной стены, чтобы НИ ОДНА полусфера не торчала за стену в открытое
    // пространство (иначе сзади виден красный отблеск).
    const SHELL_FWD = 0.8 * mapScale + 0.3;
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
      m.position.z = SHELL_FWD;   // весь ореол — перед стеной, в зале
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
    genLight.position.set(0, 0, SHELL_FWD + 0.5);   // всегда в зале перед стеной (масштаб карты)
    genLight.castShadow = true;          // стена перекрывает свет → за карту не светит
    genLight.shadow.mapSize.set(512, 512);
    genLight.shadow.camera.near = 0.3;
    genLight.shadow.camera.far = 16;
    generator.add(genLight);
    generator.position.set(GEN_X, GEN_Y, GEN_Z);
    if (!onlyMoveSpider) scene.add(generator);

    // Плоский красный «глазок» на грани стены. MeshBasicMaterial не зависит от
    // света → круг всегда один и тот же насыщенный красный и вблизи, и издалека
    // (аддитивное свечение вблизи выцветает на освещённой фонарём стене, диск — нет).
    const eyeDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.85, 40),
      new THREE.MeshBasicMaterial({ color: 0xff0000 }),
    );
    eyeDisc.position.set(GEN_X, GEN_Y, -16.84 * mapScale); // на южной грани стены, лицом в зал
    if (!onlyMoveSpider) scene.add(eyeDisc);

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
    floorGlow.position.set(GEN_X, 0.03, GEN_Z + 3 * mapScale); // на полу, перед генератором (в зал)
    if (!onlyMoveSpider) scene.add(floorGlow);

    // коллизия — игрок не проходит сквозь генератор
    const GEN_R = 1.2;
    const genRect: Rect = { minX: GEN_X - GEN_R, maxX: GEN_X + GEN_R, minZ: GEN_Z - GEN_R, maxZ: GEN_Z + GEN_R };
    const finalGate = new THREE.Group();
    const finalGateLeft = new THREE.Group();
    const finalGateRight = new THREE.Group();
    if (!onlyMoveSpider) {
      colliders.push(genRect);
      genSlots.push({ rect: genRect, used: false, reusable: true, fill: () => undefined });
    }

    if (onlyMoveSpider) {
      const pole = new THREE.Group();
      const poleMetal = new THREE.MeshStandardMaterial({
        color: 0x4f565d, metalness: 0.72, roughness: 0.34, envMapIntensity: 0.9,
      });
      const concreteMat = new THREE.MeshStandardMaterial({
        color: 0x7b7770, metalness: 0.05, roughness: 0.86,
      });
      const darkMetal = new THREE.MeshStandardMaterial({
        color: 0x22272c, metalness: 0.85, roughness: 0.3,
      });
      const ceramicMat = new THREE.MeshStandardMaterial({
        color: 0xd7e2e8, emissive: 0x6aa9ff, emissiveIntensity: 0.1, metalness: 0.05, roughness: 0.28,
      });
      const electricMat = new THREE.MeshBasicMaterial({
        color: 0x8ee8ff, transparent: true, opacity: 0.92,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });

      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 1.18, 0.52, 8), concreteMat);
      base.position.y = 0.21; base.castShadow = true; base.receiveShadow = true;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.28, 5.45, 16), poleMetal);
      shaft.position.y = 2.95; shaft.castShadow = true; shaft.receiveShadow = true;
      const serviceBox = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.78, 0.28), darkMetal);
      serviceBox.position.set(0, 1.25, 0.24); serviceBox.castShadow = true;
      pole.add(base, shaft, serviceBox);

      for (const y of [0.78, 1.7, 2.72, 3.74]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.027, 8, 26), darkMetal);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = y;
        pole.add(ring);
      }

      const cross = new THREE.Mesh(new THREE.BoxGeometry(2.85, 0.18, 0.24), darkMetal);
      cross.position.y = 5.05;
      cross.castShadow = true;
      pole.add(cross);

      for (const side of [-1, 0, 1]) {
        const armX = side * 1.08;
        const insulator = new THREE.Group();
        for (let i = 0; i < 4; i++) {
          const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.1, 18), ceramicMat);
          disc.rotation.x = Math.PI / 2;
          disc.position.y = 5.22 + i * 0.12;
          disc.position.x = armX;
          disc.castShadow = true;
          insulator.add(disc);
        }
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), ceramicMat);
        cap.position.set(armX, 5.74, 0);
        insulator.add(cap);
        pole.add(insulator);
      }

      const makeLine = (points: THREE.Vector3[], material: THREE.Material) => {
        pole.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
      };
      const wireMat = new THREE.LineBasicMaterial({ color: 0x11171d, transparent: true, opacity: 0.95 });
      for (const x of [-1.08, 0, 1.08]) {
        makeLine([
          new THREE.Vector3(x - 1.15, 5.66, -0.22),
          new THREE.Vector3(x - 0.55, 5.52, -0.18),
          new THREE.Vector3(x, 5.62, -0.15),
          new THREE.Vector3(x + 0.55, 5.52, -0.18),
          new THREE.Vector3(x + 1.15, 5.66, -0.22),
        ], wireMat);
      }
      makeLine([
        new THREE.Vector3(-1.08, 5.62, 0),
        new THREE.Vector3(-0.78, 5.28, 0.16),
        new THREE.Vector3(-0.36, 5.5, -0.08),
        new THREE.Vector3(0, 5.16, 0.14),
        new THREE.Vector3(0.34, 5.48, -0.12),
        new THREE.Vector3(0.74, 5.24, 0.1),
        new THREE.Vector3(1.08, 5.62, 0),
      ], electricMat);
      makeLine([
        new THREE.Vector3(0, 5.62, 0),
        new THREE.Vector3(0.18, 5.2, 0.18),
        new THREE.Vector3(-0.12, 4.92, -0.08),
        new THREE.Vector3(0.16, 4.58, 0.12),
      ], electricMat);

      const electricLight = new THREE.PointLight(0x8ee8ff, 7, 11 * mapScale, 2);
      electricLight.position.set(0, 5.25, 0);
      pole.add(electricLight);
      pole.position.set(START_X, 0, START_Z);
      scene.add(pole);

      const generatorMat = new THREE.MeshStandardMaterial({
        color: 0x220707, emissive: 0xff1800, emissiveIntensity: 1.1,
        metalness: 0.75, roughness: 0.34,
      });
      const generatorTrim = new THREE.MeshStandardMaterial({
        color: 0xe0b54a, emissive: 0x5a2600, emissiveIntensity: 0.25,
        metalness: 0.9, roughness: 0.22,
      });
      const makeCornerGenerator = (x: number, z: number) => {
        const g = new THREE.Group();
        const holeMat = new THREE.MeshBasicMaterial({ color: 0x020101 });
        const glowMat = new THREE.MeshBasicMaterial({
          color: 0xff1d00, transparent: true, opacity: 0.78,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const rimOuter = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.105, 12, 48), generatorTrim);
        rimOuter.rotation.x = Math.PI / 2;
        rimOuter.position.y = 0.08;
        rimOuter.castShadow = true;
        const rimInner = new THREE.Mesh(new THREE.TorusGeometry(0.54, 0.045, 10, 42), generatorMat);
        rimInner.rotation.x = Math.PI / 2;
        rimInner.position.y = 0.11;
        const hole = new THREE.Mesh(new THREE.CircleGeometry(0.72, 48), holeMat);
        hole.rotation.x = -Math.PI / 2;
        hole.position.y = 0.055;
        const redCore = new THREE.Mesh(new THREE.CircleGeometry(0.5, 42), glowMat);
        redCore.rotation.x = -Math.PI / 2;
        redCore.position.y = 0.07;
        const glow = new THREE.Mesh(new THREE.RingGeometry(0.62, 1.28, 48), glowMat);
        glow.rotation.x = -Math.PI / 2;
        glow.position.y = 0.035;
        const light = new THREE.PointLight(0xff2200, 4.8, 7, 2);
        light.position.y = 0.55;
        g.add(glow, hole, redCore, rimOuter, rimInner, light);
        g.position.set(x, 0, z);
        scene.add(g);

        let filled = false;
        const fill = () => {
          if (filled) return;
          filled = true;
          const battery = new THREE.Group();
          const shell = new THREE.MeshStandardMaterial({ color: 0x23272e, metalness: 0.9, roughness: 0.3 });
          const glowMat = new THREE.MeshStandardMaterial({
            color: 0x36ff65, emissive: 0x36ff65, emissiveIntensity: 1.7,
            metalness: 0.25, roughness: 0.35,
          });
          const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.9, 16), glowMat);
          body.rotation.z = Math.PI / 2;
          const capA = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 16), shell);
          capA.rotation.z = Math.PI / 2; capA.position.x = -0.49;
          const capB = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 16), shell);
          capB.rotation.z = Math.PI / 2; capB.position.x = 0.49;
          battery.add(body, capA, capB);
          battery.position.set(0, 0.46, 0);
          battery.rotation.z = -0.25;
          battery.rotation.x = Math.PI / 2;
          g.add(battery);
        };

        const r = 1.1;
        const rect = { minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r };
        genSlots.push({ rect, used: false, reusable: false, fill });
      };
      const cornerOffset = 5;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          makeCornerGenerator(START_X + sx * cornerOffset, START_Z + sz * cornerOffset);
        }
      }

      const gateMat = new THREE.MeshStandardMaterial({
        color: 0x1c2229, metalness: 1, roughness: 0.24, emissive: 0x050607, emissiveIntensity: 0.25,
      });
      const gateGlow = new THREE.MeshStandardMaterial({
        color: 0xff2600, emissive: 0xff2600, emissiveIntensity: 1.4, metalness: 0.4, roughness: 0.35,
      });
      const makeGateHalf = (side: -1 | 1) => {
        const half = side < 0 ? finalGateLeft : finalGateRight;
        for (let i = 0; i < 4; i++) {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.6, 0.18), gateMat);
          bar.position.set(side * (0.35 + i * 0.38), 1.8, 0);
          bar.castShadow = true; bar.receiveShadow = true;
          half.add(bar);
        }
        const railA = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.16, 0.22), gateMat);
        railA.position.set(side * 0.92, 0.45, 0);
        const railB = railA.clone();
        railB.position.y = 3.15;
        half.add(railA, railB);
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 10), gateGlow);
        eye.position.set(side * 0.92, 1.85, 0.18);
        half.add(eye);
        finalGate.add(half);
      };
      makeGateHalf(-1);
      makeGateHalf(1);
      finalGate.position.set(GEN_X, 0, GEN_Z + 1.15 * mapScale);
      scene.add(finalGate);
    }

    // ── Батарейки ──────────────────────────────────────────
    // Спавнятся ОДИН раз в начале по достижимым клеткам карты. Светятся зелёным,
    // чтобы их было видно в темноте. Игрок подбирает одну за раз, несёт к
    // генератору; при касании коллизий батарейка исчезает (доставлена).
    function makeBattery(x: number, z: number): Battery {
      const g = new THREE.Group();
      // «Энергоячейка»: тёмный металлический корпус-клетка со светящимся зелёным
      // ядром, кольцами-акцентами и клеммой «+». Светится САМА (emissive), но НЕ
      // освещает окружение — поэтому её свет не пробивается сквозь стены.
      const GREEN = 0x39ff6a;
      const shellMat = new THREE.MeshStandardMaterial({ color: 0x23272e, metalness: 0.95, roughness: 0.32, envMapIntensity: 0.9 });
      const trimMat = new THREE.MeshStandardMaterial({ color: 0xc9d1d9, metalness: 1.0, roughness: 0.25, envMapIntensity: 1.1 });
      const coreMat = new THREE.MeshStandardMaterial({ color: 0x2bd24f, emissive: GREEN, emissiveIntensity: 1.9, metalness: 0.2, roughness: 0.4 });
      const haloMat = new THREE.MeshStandardMaterial({ color: GREEN, emissive: GREEN, emissiveIntensity: 0.7, transparent: true, opacity: 0.26, metalness: 0, roughness: 0.1 });
      const ringMat = new THREE.MeshStandardMaterial({ color: GREEN, emissive: GREEN, emissiveIntensity: 1.6, metalness: 0.3, roughness: 0.4 });

      // светящееся ядро (энергия) + полупрозрачный ореол вокруг
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.66, 20), coreMat);
      const halo = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.225, 0.6, 20), haloMat);
      g.add(core, halo);

      // верхняя и нижняя «крышки» корпуса (тёмный металл, слегка конусом)
      const capTop = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.25, 0.16, 20), shellMat);
      capTop.position.y = 0.36; capTop.castShadow = true;
      const capBot = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.27, 0.16, 20), shellMat);
      capBot.position.y = -0.36; capBot.castShadow = true;
      g.add(capTop, capBot);

      // 4 ребра-стойки «клетки» вокруг ядра
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.56, 0.085), shellMat);
        rib.position.set(Math.cos(a) * 0.225, 0, Math.sin(a) * 0.225);
        rib.rotation.y = -a; rib.castShadow = true;
        g.add(rib);
      }

      // светящиеся кольца-акценты на стыках крышек и ядра
      for (const ry of [0.28, -0.28]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.022, 10, 28), ringMat);
        ring.rotation.x = Math.PI / 2; ring.position.y = ry; g.add(ring);
      }

      // клемма «+» сверху и контакт снизу (яркий металл)
      const nub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 16), trimMat);
      nub.position.y = 0.49; nub.castShadow = true;
      const botContact = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.05, 16), trimMat);
      botContact.position.y = -0.465; botContact.castShadow = true;
      g.add(nub, botContact);

      g.position.set(x, 0.6, z);
      scene.add(g);
      return { group: g, delivered: false, carried: false, locked: false, pickupAbilityGiven: false, insertAbilityGiven: false };
    }
    // ── Переключатель = КНОПКА НА СТЕНЕ ────────────────────
    // Никуда нести не надо: подходишь к стене и жмёшь E. Красная кнопка с
    // подсветкой утоплена в панель на стене; при нажатии становится зелёной,
    // вдавливается внутрь и ревёт сирена. Пока не нажаты ВСЕ — дальше нельзя.
    // (x,z) — точка на грани стены; angle — наружу из стены (куда смотрит кнопка).
    function makeSwitch(x: number, z: number, angle: number): Switch {
      const g = new THREE.Group();
      // монтажная панель, прижата к стене (в локальных координатах перед = +Z)
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.7, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x2b2f37, metalness: 0.85, roughness: 0.45 }),
      );
      plate.position.z = 0.06; plate.castShadow = true; plate.receiveShadow = true;
      // ободок-подсветка вокруг кнопки
      const ringMat = new THREE.MeshStandardMaterial({ color: 0x551111, emissive: 0xff1400, emissiveIntensity: 1.1 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.04, 10, 24), ringMat);
      ring.position.z = 0.13;
      // сама кнопка — короткий цилиндр, лежит вдоль +Z (нажимается внутрь)
      const btnMat = new THREE.MeshStandardMaterial({ color: 0xff2a14, emissive: 0xff1400, emissiveIntensity: 1.4, metalness: 0.3, roughness: 0.4 });
      const button = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 24), btnMat);
      button.rotation.x = Math.PI / 2; // ось цилиндра -> вдоль Z
      button.position.z = 0.16;
      const light = new THREE.PointLight(0xff2200, 4, 5, 2); light.position.z = 0.4;
      g.add(plate, ring, button, light);
      g.position.set(x, 1.55, z);  // на высоте руки
      g.rotation.y = angle;        // лицом наружу из стены
      scene.add(g);
      const setActive = (b: boolean) => {
        const c = b ? 0x22ff44 : 0xff1400;
        btnMat.color.set(b ? 0x2bd24f : 0xff2a14);
        btnMat.emissive.set(c); ringMat.emissive.set(c); light.color.set(b ? 0x33ff66 : 0xff2200);
        button.position.z = b ? 0.08 : 0.16; // нажата → вдавлена
      };
      return { group: g, x, z, active: false, setActive };
    }

    // Подобрать точку на ближайшей стене для монтажа кнопки рядом с точкой (px,pz).
    // Возвращает позицию на грани стены + угол наружу (в сторону открытого прохода).
    function mountOnWall(px: number, pz: number): { x: number; z: number; angle: number } {
      let best: Rect | null = null, bestD = Infinity;
      for (const b of colliders) {
        if (b === genRect) continue;
        const cx = Math.max(b.minX, Math.min(px, b.maxX));
        const cz = Math.max(b.minZ, Math.min(pz, b.maxZ));
        const d = Math.hypot(px - cx, pz - cz);
        if (d < bestD) { bestD = d; best = b; }
      }
      if (!best) return { x: px, z: pz, angle: 0 };
      const sxw = best.maxX - best.minX, szw = best.maxZ - best.minZ;
      const midX = (best.minX + best.maxX) / 2, midZ = (best.minZ + best.maxZ) / 2;
      const OFF = 0.16; // кнопка чуть выступает из грани
      if (sxw <= szw) { // вертикальная стена (тонкая по X), грани по ±X
        const pos = px > midX, sign = pos ? 1 : -1;
        const faceX = pos ? best.maxX : best.minX;
        const z = Math.min(best.maxZ - 0.4, Math.max(best.minZ + 0.4, pz));
        return { x: faceX + sign * OFF, z, angle: sign > 0 ? Math.PI / 2 : -Math.PI / 2 };
      } else { // горизонтальная стена (тонкая по Z), грани по ±Z
        const pos = pz > midZ, sign = pos ? 1 : -1;
        const faceZ = pos ? best.maxZ : best.minZ;
        const x = Math.min(best.maxX - 0.4, Math.max(best.minX + 0.4, px));
        return { x, z: faceZ + sign * OFF, angle: sign > 0 ? 0 : Math.PI };
      }
    }

    // ── Достижимость карты (флуд-фолл по сетке) ─────────────
    // Чтобы батарейки/переключатели не спавнились в стенах или в отрезанных
    // карманах, считаем все клетки, до которых игрок реально доходит со спавна.
    const minWX = wx(0), maxWX = wx(cols * 2), minWZ = wz(0), maxWZ = wz(rows * 2);
    // границы для флуд-фолла шире карты — чтобы достижимость заходила в
    // комнаты-пристройки за левым/правым краем (иначе батарейки туда не попадут)
    const reachMinX = minWX - 9 * mapScale, reachMaxX = maxWX + 9 * mapScale;
    // расстояние от точки до ближайшей стены (0 — внутри стены)
    const clearAt = (x: number, z: number) => {
      let m = Infinity;
      for (const b of colliders) {
        const cx = Math.max(b.minX, Math.min(x, b.maxX));
        const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
        const d = Math.hypot(x - cx, z - cz);
        if (d < m) m = d;
      }
      return m;
    };
    const STEP = 1.0, STAND = 1.3, GAP = 0.4; // шаг сетки, зазор «стоять» / «протиснуться»
    function computeReach(): { x: number; z: number }[] {
      const reach: { x: number; z: number }[] = [];
      const seen = new Set<string>();
      const key = (ix: number, iz: number) => ix + '|' + iz;
      const sIx = Math.round(START_X / STEP), sIz = Math.round(START_Z / STEP); // стартовая клетка = спавн игрока
      const queue: [number, number][] = [[sIx, sIz]];
      seen.add(key(sIx, sIz));
      while (queue.length) {
        const [ix, iz] = queue.shift()!;
        const x = ix * STEP, z = iz * STEP;
        if (clearAt(x, z) >= STAND) reach.push({ x, z });
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = ix + dx, nz = iz + dz, wxp = nx * STEP, wzp = nz * STEP;
          if (wxp < reachMinX || wxp > reachMaxX || wzp < minWZ || wzp > maxWZ) continue;
          if (seen.has(key(nx, nz))) continue;
          if (clearAt(wxp, wzp) < GAP) { seen.add(key(nx, nz)); continue; }      // соседняя клетка в стене
          if (clearAt((x + wxp) / 2, (z + wzp) / 2) < GAP) continue;             // между клетками стена
          seen.add(key(nx, nz)); queue.push([nx, nz]);
        }
      }
      return reach;
    }

    const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

    // ── Выступы-карманы (альковы) ──────────────────────────
    // На поздних уровнях у краёв карты делаем маленькие «выступы»: 3 стены
    // образуют карман, открытый ТОЛЬКО в сторону центра (вход не в открытое
    // пространство, а из коридора). Внутри спавнятся переключатель и батарейка.
    const alcoveSpots: { x: number; z: number }[] = [];
    function buildAlcoves(count: number) {
      if (count <= 0) return;
      const reach1 = computeReach();
      const cand = shuffle(reach1.filter((c) =>
        Math.abs(c.x) > 22 * mapScale && !inCentral(c.x, c.z) && clearAt(c.x, c.z) >= 1.7 && Math.abs(c.z) < 13 * mapScale,
      ));
      const D = 2.2, T2 = TH;
      for (const c of cand) {
        if (alcoveSpots.length >= count) break;
        if (alcoveSpots.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 16)) continue;
        const sgn = c.x > 0 ? 1 : -1;                 // «спина» алькова — у края, вход — к центру
        addWall(c.x + sgn * D, c.z, T2, 2 * D + T2);  // задняя стена карманa
        addWall(c.x + sgn * D / 2, c.z - D, D + T2, T2); // боковая
        addWall(c.x + sgn * D / 2, c.z + D, D + T2, T2); // боковая
        alcoveSpots.push({ x: c.x, z: c.z });
      }
    }
    buildAlcoves(cfg.alcoves);

    // ── Достижимые клетки с учётом альковов ────────────────
    const reach = computeReach();
    const playerStart = onlyMoveSpider
      ? (reach
        .filter((c) => clearAt(c.x, c.z) >= 1.45 && !inCentral(c.x, c.z))
        .sort((a, b) => Math.abs(b.x - START_X) - Math.abs(a.x - START_X))[0] ?? { x: START_X, z: START_Z })
      : { x: START_X, z: START_Z };
    // выбрать n точек из пула с минимальным расстоянием между ними и от запретных
    function pickSpawns(n: number, avoid: { x: number; z: number }[], minSep: number) {
      const pool = shuffle(reach.filter((c) =>
        clearAt(c.x, c.z) >= 1.45 &&
        !inCentral(c.x, c.z) &&                               // не в центральном зале
        Math.hypot(c.x - START_X, c.z - START_Z) > 7 &&       // не у самого спавна
        Math.hypot(c.x - GEN_X, c.z - GEN_Z) > 5,             // не у генератора
      ));
      const chosen: { x: number; z: number }[] = [];
      const taken = [...avoid];
      let sep = minSep;
      while (chosen.length < n && sep > 1.4) {
        for (const c of pool) {
          if (chosen.length >= n) break;
          if (chosen.includes(c)) continue;
          if (taken.every((p) => Math.hypot(p.x - c.x, p.z - c.z) >= sep)) { chosen.push(c); taken.push(c); }
        }
        sep *= 0.7; // не набралось — ослабляем требование к разбросу
      }
      return chosen;
    }
    // лёгкий джиттер вокруг клетки (рандом тем больше, чем выше уровень)
    const jitter = (c: { x: number; z: number }) => {
      const r = cfg.randomness * 2.4;
      for (let t = 0; t < 6; t++) {
        const nx = c.x + (Math.random() - 0.5) * 2 * r, nz = c.z + (Math.random() - 0.5) * 2 * r;
        if (clearAt(nx, nz) >= 1.3 && !inCentral(nx, nz)) return { x: nx, z: nz }; // не в центр. зал
      }
      return c;
    };

    // ── Раскладка переключателей ───────────────────────────
    // В альковах — по переключателю, остальные (если их больше) — по карте.
    const switchPts: { x: number; z: number }[] = [];
    for (const a of alcoveSpots) { if (switchPts.length < switchGoal) switchPts.push({ x: a.x, z: a.z }); }
    if (switchPts.length < switchGoal) {
      switchPts.push(...pickSpawns(switchGoal - switchPts.length, switchPts, 12));
    }
    // каждую точку «прижимаем» к ближайшей стене → кнопка на стене
    const switchesArr: Switch[] = switchPts.slice(0, switchGoal).map((p) => {
      const m = mountOnWall(p.x, p.z);
      return makeSwitch(m.x, m.z, m.angle);
    });

    // ── Раскладка батареек ─────────────────────────────────
    // В альковах рядом с переключателем тоже кладём батарейку, остальные — по карте.
    const batteryPts: { x: number; z: number }[] = [];
    for (const a of alcoveSpots) {
      if (batteryPts.length >= batteryGoal) break;
      const sgn = a.x > 0 ? 1 : -1;
      batteryPts.push({ x: a.x - sgn * 1.0, z: a.z }); // сдвиг к выходу алькова, рядом с переключателем
    }
    if (batteryPts.length < batteryGoal) {
      const more = pickSpawns(batteryGoal - batteryPts.length, [...switchPts, ...batteryPts], 9)
        .map((c) => jitter(c));
      batteryPts.push(...more);
    }
    const batteries: Battery[] = batteryPts.slice(0, batteryGoal).map((p) => makeBattery(p.x, p.z));

    // ── Мясо (восстанавливает сытость) ─────────────────────
    // Лежит на полу по карте, слегка светится тёплым (чтобы найти в темноте).
    // Подбирается касанием → +1 сытость. Голод убывает со временем (см. цикл).
    function makeMeat(x: number, z: number): Meat {
      const g = new THREE.Group();
      const fleshMat = new THREE.MeshStandardMaterial({
        color: 0x9e2b2b, emissive: 0x5a0f10, emissiveIntensity: 0.55, roughness: 0.6, metalness: 0.05,
      });
      const fatMat = new THREE.MeshStandardMaterial({ color: 0xd98c8c, emissive: 0x3a1414, emissiveIntensity: 0.4, roughness: 0.7 });
      const boneMat = new THREE.MeshStandardMaterial({ color: 0xeae0cf, emissive: 0x4a4438, emissiveIntensity: 0.35, roughness: 0.5 });
      // мясистый кусок (неровный) + жировые прожилки
      const lump = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 12), fleshMat);
      lump.scale.set(1.1, 0.7, 0.85); lump.castShadow = true;
      const lump2 = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), fatMat);
      lump2.position.set(0.18, 0.08, -0.1); lump2.castShadow = true;
      // косточка, торчащая сбоку
      const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 8), boneMat);
      bone.rotation.z = Math.PI / 2.3; bone.position.set(-0.34, 0.06, 0.05); bone.castShadow = true;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), boneMat);
      knob.position.set(-0.55, 0.12, 0.08);
      g.add(lump, lump2, bone, knob);
      g.position.set(x, 0.45, z);
      scene.add(g);
      return { group: g, eaten: false };
    }
    if (levelNum === 1 || onlyMoveSpider) ownedAbilRef.current = onlyMoveSpider ? ['move', 'climb'] : ['move'];
    while (!onlyMoveSpider && ownedAbilRef.current.length < levelNum) {
      const def = DEFAULT_ABIL_ORDER.find((a) => !ownedAbilRef.current.includes(a));
      if (!def) break;
      ownedAbilRef.current = [...ownedAbilRef.current, def];
    }
    hungerActive = ownedAbilRef.current.includes('hunger') && !onlyMoveSpider;
    // мясо спавнится только когда голод активен как способность паука
    const meatGoal = 4 + levelNum;
    const meatPts = hungerActive
      ? shuffle(reach.filter((c) => clearAt(c.x, c.z) >= 1.3 && Math.hypot(c.x - START_X, c.z - START_Z) > 6)).slice(0, meatGoal)
      : [];
    const meats: Meat[] = meatPts.map((p) => makeMeat(p.x, p.z));

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

    // ── Лицо (на передней стороне головы, +z — куда смотрит игрок) ──
    const faceMat = new THREE.MeshStandardMaterial({
      color: 0x111318, emissive: 0x000000, roughness: 0.5, metalness: 0,
    });
    const eyeGeo = new THREE.SphereGeometry(0.07, 12, 12);
    const leftEye = new THREE.Mesh(eyeGeo, faceMat);
    leftEye.position.set(-0.12, 0.06, 0.30);
    const rightEye = new THREE.Mesh(eyeGeo, faceMat);
    rightEye.position.set(0.12, 0.06, 0.30);
    // блик в глазах — маленькие белые точки, «живой» взгляд
    const shineMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8 });
    const shineGeo = new THREE.SphereGeometry(0.025, 8, 8);
    const lShine = new THREE.Mesh(shineGeo, shineMat); lShine.position.set(-0.10, 0.09, 0.355);
    const rShine = new THREE.Mesh(shineGeo, shineMat); rShine.position.set(0.14, 0.09, 0.355);
    // улыбка — половинка тора, изгиб вниз
    const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.022, 8, 16, Math.PI), faceMat);
    mouth.position.set(0, -0.07, 0.30);
    mouth.rotation.z = Math.PI; // дуга изгибается вниз → улыбка
    head.add(leftEye, rightEye, lShine, rShine, mouth);

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
    const setPlayerRunPose = (phase: number, intensity = 1) => {
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      const armSwing = 1.05 * intensity;
      const legSwing = 1.15 * intensity;
      leftArm.rotation.x = s * armSwing;
      rightArm.rotation.x = -s * armSwing;
      leftLeg.rotation.x = -s * legSwing;
      rightLeg.rotation.x = s * legSwing;
      torso.rotation.x = -0.16 * intensity + Math.abs(c) * 0.04;
      head.rotation.x = 0.08 * intensity;
      player.position.y = Math.abs(c) * 0.14 * intensity;
    };

    player.position.set(playerStart.x, 0, playerStart.z);
    player.scale.setScalar(2);      // игрок в 2 раза больше (хитбокс — PLAYER_R ниже)
    scene.add(player);

    // ── Гигантский паук: способности по уровням ────────────
    // Чем дальше уровень — тем больше «чувств» у паука, и каждое бьёт по своей
    // тактике игрока: HEAR (стой тихо) → SEE (прячься за стены) → SMELL (петляй) →
    // WEB (рви линию видимости) → CLONE (не загоняй себя в угол). Пауков может
    // быть несколько (клоны), поэтому держим МАССИВ экземпляров.
    type SpiderLeg = {
      legG: THREE.Group; fem: THREE.Group; tib: THREE.Group; foot: THREE.Object3D;
      rootX: number; rootY: number; rootZ: number;
      baseY: number; baseFemur: number; baseTibia: number; side: number; phase: number;
    };
    type SpiderState = 'IDLE' | 'CHASE' | 'PATROL';
    type SpiderInst = {
      group: THREE.Group; legs: SpiderLeg[]; touchR: number; legReach: number; bodyY: number; wallDrop: THREE.Object3D;
      heading: number; dist: number; bias: number;
      state: SpiderState; wpX: number; wpZ: number; // текущая путевая точка патруля
      stuck: number; lastX: number; lastZ: number;  // анти-залипание
      idleT: number;                                // таймер засады (IDLE)
      wallClimb: number; wallNx: number; wallNz: number;
    };
    const spiders: SpiderInst[] = [];
    // радиус коллизии паука = по ширине его тела/коридора (растёт с картой), чтобы
    // он НЕ проходил сквозь стены телом, а полз вдоль/огибал их (как по стенам).
    const finalSpiderScale = onlyMoveSpider ? 0.62 : 1;
    const SP_R = (CW - TH) / 2 * 0.7 * finalSpiderScale;

    // АДАПТИВНЫЙ набор способностей паука (накоплен по тактикам игрока).
    if (levelNum === 1 || onlyMoveSpider) ownedAbilRef.current = onlyMoveSpider ? ['move', 'climb'] : ['move']; // новый забег — с чистого листа
    // возобновлённая игра (сейв на уровне N, но способностей меньше) → добираем по умолчанию
    while (!onlyMoveSpider && ownedAbilRef.current.length < levelNum) {
      const def = DEFAULT_ABIL_ORDER.find((a) => !ownedAbilRef.current.includes(a));
      if (!def) break;
      ownedAbilRef.current = [...ownedAbilRef.current, def];
    }
    tacticRef.current = { still: 0, hide: 0, open: 0, flee: 0, loop: 0 }; // метрики тактик — заново
    const owned = ownedAbilRef.current;
    hungerActive = owned.includes('hunger') && !onlyMoveSpider;
    const can = {
      hear:  owned.includes('hear'),
      see:   owned.includes('see'),
      smell: owned.includes('smell'),
      web:   owned.includes('web'),
      clone: owned.includes('clone'),
      climb: owned.includes('climb'),
    };
    const shownAbil = owned.filter((k) => k !== 'climb').map((k) => ABIL_META[k]).filter(Boolean);
    setSpiderAbil(shownAbil); // для HUD и заставки
    const refreshSpiderAbilityHud = () => {
      const shown = ownedAbilRef.current.filter((k) => k !== 'climb').map((k) => ABIL_META[k]).filter(Boolean);
      hungerActive = ownedAbilRef.current.includes('hunger') && !onlyMoveSpider;
      setSpiderAbil(shown);
    };
    const unlockNextSpiderAbility = () => {
      const order = onlyMoveSpider ? DEFAULT_ABIL_ORDER.filter((a) => a !== 'hunger' && a !== 'clone') : DEFAULT_ABIL_ORDER;
      const add = order.find((a) => !ownedAbilRef.current.includes(a));
      if (!add) return;
      ownedAbilRef.current = [...ownedAbilRef.current, add];
      if (add === 'hear') can.hear = true;
      else if (add === 'see') can.see = true;
      else if (add === 'smell') can.smell = true;
      else if (add === 'web') can.web = true;
      else if (add === 'clone') can.clone = true;
      refreshSpiderAbilityHud();
    };

    // дальности чувств (масштабируются вместе с картой)
    const SEE_RANGE = 13 * mapScale;
    const HEAR_RANGE = 12 * mapScale; // слышит ШАГИ, когда игрок двигается рядом (сквозь стены)
    const SMELL_RANGE = 8 * mapScale;
    const WEB_RANGE = 18 * mapScale;

    // прямая видимость: между точками a и b нет стены
    const hasLOS = (ax: number, az: number, bx: number, bz: number) => {
      const dx = bx - ax, dz = bz - az;
      const d = Math.hypot(dx, dz);
      const steps = Math.ceil(d / 0.6);
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        if (clearAt(ax + dx * t, az + dz * t) < 0.35) return false;
      }
      return true;
    };

    // след запаха игрока (для нюха): копим недавние позиции; паук идёт по «старому»
    // следу с задержкой ~2 с — поэтому, петляя, можно сбить его со следа.
    const scent: { x: number; z: number }[] = [];
    let scentTimer = 0;

    // громкий шум: активация переключателя ревёт сиреной. Паук со СЛУХОМ слышит
    // её через всю карту и идёт на источник (несколько секунд помнит место).
    let noiseAlert = 0;            // сек. оставшегося «слышу сирену»
    let noiseX = 0, noiseZ = 0;    // где сработала сирена
    const NOISE_HEARD = 6;         // сколько секунд паук идёт на шум

    // ── Gemini в фазе ПОИСКА ───────────────────────────────
    // Когда паук НЕ чувствует игрока, патруль вдоль стены предсказуем. Тогда курс
    // поиска подсказывает Gemini (редко — раз в несколько секунд, чтобы не жечь
    // бесплатный лимит). Чувствует игрока → рулят точные локальные чувства, Gemini
    // молчит. Если Gemini недоступен — откат на патруль вдоль стен.
    let searchTarget = Math.PI / 2;  // курс поиска от Gemini (радианы)
    let searchActive = false;        // есть валидный ответ
    let brainBusy = false;           // запрос уже в полёте
    let brainTimer = 0;              // сек. с прошлого запроса
    const BRAIN_EVERY = 5;          // опрос раз в 5 c — ~12/мин, под лимитом free
    let brainNext = BRAIN_EVERY;    // динамический интервал (растёт при 429/ошибке)
    let geminiOnline = false;        // удался ли последний запрос
    let geminiShown = false;        // дедуп React-стейта индикатора
    let lastSeenX = playerStart.x, lastSeenZ = playerStart.z, hasLastSeen = false; // где видели игрока
    // Ключ Gemini прямо из .env (VITE_GEMINI_API_KEY) → нейронка работает СРАЗУ,
    // без деплоя edge-функции. Если ключа нет — пойдём через безопасную функцию `ai`.
    // ⚠️ VITE_-ключ попадает в браузер; ок для локалки/личного билда, для прод —
    // лучше edge-функция (оставь VITE_GEMINI_API_KEY пустым).
    const DIRECT_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) || '';
    const askSearch = async (sx: number, sz: number) => {
      if (brainBusy || (!DIRECT_KEY && !supabase)) return;
      brainBusy = true;
      try {
        const system =
          'Ты — ИИ паука-охотника в тёмном лабиринте (вид сверху, оси X и Z). ' +
          'Игрока сейчас НЕ видно и НЕ слышно. Дай НЕПРЕДСКАЗУЕМЫЙ курс поиска, ' +
          'чтобы прочесать лабиринт и перехватить игрока, а не ходить по кругу. ' +
          'heading — ЦЕЛОЕ число градусов 0..359, где 0 = +Z, 90 = +X, 180 = -Z, 270 = -X.';
        const known = hasLastSeen ? ` Последний раз игрок был у x=${lastSeenX.toFixed(0)}, z=${lastSeenZ.toFixed(0)}.` : '';
        const prompt = `Паук: x=${sx.toFixed(0)}, z=${sz.toFixed(0)}. Карта по X от ${minWX.toFixed(0)} до ${maxWX.toFixed(0)}, по Z от ${minWZ.toFixed(0)} до ${maxWZ.toFixed(0)}.${known} Каким курсом ползти на поиск?`;
        // структурированный вывод → модель ВСЕГДА возвращает строго {"heading": N}
        const genCfg = {
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: 'application/json',
          responseSchema: { type: 'OBJECT', properties: { heading: { type: 'INTEGER' } }, required: ['heading'] },
          maxOutputTokens: 40,
          temperature: 1.0,
        };
        let text = '';
        if (DIRECT_KEY) {
          // прямой вызов Gemini из браузера по ключу из .env
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${DIRECT_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: genCfg,
              }),
            },
          );
          const d = await res.json();
          text = d?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        } else if (supabase) {
          // безопасный путь через edge-функцию (ключ в секрете сервера)
          const { data, error } = await supabase.functions.invoke('ai', { body: { prompt, system } });
          text = (!error && data && typeof data.text === 'string') ? data.text : '';
        }
        const m = text.match(/\{[\s\S]*?\}/);
        let ok = false;
        if (m) {
          const j = JSON.parse(m[0]);
          if (typeof j.heading === 'number' && isFinite(j.heading)) {
            searchTarget = (j.heading * Math.PI) / 180; searchActive = true; ok = true;
          }
        }
        geminiOnline = ok;
        brainNext = ok ? BRAIN_EVERY : 30; // ответ есть → обычный темп; нет (429/мусор) → ждём 30 c
      } catch {
        geminiOnline = false; // нет сети/ключа/лимита — откат на патруль вдоль стен
        brainNext = 30;       // backoff, чтобы не долбить квоту
      }
      brainBusy = false;
    };

    // Паутина-ловушка: пятно на полу. Наступил → медленнее, паук знает точку тревоги.
    type WebTrap = { mesh: THREE.Mesh; x: number; z: number; r: number; life: number; triggered: boolean };
    const webs: WebTrap[] = [];
    let webCd = 1.5;        // задержка перед первым выстрелом
    let webSlow = 0;        // сек. оставшегося замедления игрока
    let webbedShown = false; // чтобы не дёргать React-стейт каждый кадр
    let prevMx = 0, prevMz = 0; // прошлое направление игрока (для детекта петляния)
    const makeWeb = (x: number, z: number) => {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(2.15, 36),
        new THREE.MeshBasicMaterial({
          color: 0xdfe8ee,
          transparent: true,
          opacity: 0.42,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.065, z);
      scene.add(m);
      webs.push({ mesh: m, x, z, r: 2.15, life: 18, triggered: false });
    };

    // клонирование (6-й уровень): периодически добавляется ещё паук
    let cloneCd = 9;
    const MAX_SPIDERS = 3;
    const tmpFoot = new THREE.Vector3(); // переиспользуем для позиций лап (без аллокаций)

    // ── Стейт-машина и скорости паука ──────────────────────
    const SPIDER_SPEED = 3;              // обычная скорость ползания (игрок = 5)
    const CHASE_MULT = 2.0;              // в погоне (знает, где ты) — ДВОЙНАЯ: 3*2 = 6 (быстрее игрока!)
    const CHASE_RANGE = 7 * mapScale;    // подошёл ВПЛОТНУЮ (или почуял) → CHASE (засада)
    const ESCAPE_RANGE = 24 * mapScale;  // дальше этого и не чует → выходит в PATROL
    const TURN_PATROL = 2.4;             // рад/с поворот в патруле (плавно)
    const TURN_CHASE = 4.2;              // рад/с поворот в погоне (резвее)
    const ENABLE_WALL_CLIMB = can.climb; // финальная способность: паук перелезает через стены

    // ── Выравнивание по поверхности (raycast вниз) + глитч-фри ориентация ──
    // Луч вниз из точки над пауком находит поверхность под ним; «живот» паука
    // выравнивается по нормали через Quaternion.slerp, а разворот идёт строго
    // вокруг этой нормали (локальной оси Y) → модель НЕ заваливается на бок/спину.
    const surfRay = new THREE.Raycaster();
    const RAY_ORIGIN = new THREE.Vector3();
    const RAY_DIR = new THREE.Vector3(0, -1, 0);
    const upN = new THREE.Vector3(0, 1, 0);
    const fwdN = new THREE.Vector3();
    const rightN = new THREE.Vector3();
    const basisM = new THREE.Matrix4();
    const targetQ = new THREE.Quaternion();
    const surfTargets: THREE.Object3D[] = [floor, ...wallMeshes];
    const orientSpider = (S: SpiderInst, slerpT: number) => {
      const sp = S.group.position;
      // нормаль поверхности под пауком (готово к стенам; на полу = вверх)
      upN.set(0, 1, 0);
      if (S.wallClimb <= 0) {
      RAY_ORIGIN.set(sp.x, sp.y + 3, sp.z);
      surfRay.set(RAY_ORIGIN, RAY_DIR); surfRay.far = 8;
      const hit = surfRay.intersectObjects(surfTargets, false)[0];
      if (hit && hit.face) {
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        if (n.y > 0.3) upN.copy(n).normalize(); // «пол-подобную» нормаль принимаем
      }
      // желаемый «вперёд» = по курсу, спроецирован на плоскость поверхности
      }
      fwdN.set(Math.sin(S.heading), 0, Math.cos(S.heading)).projectOnPlane(upN);
      if (fwdN.lengthSq() < 1e-6) return;
      fwdN.normalize();
      rightN.crossVectors(upN, fwdN).normalize();
      fwdN.crossVectors(rightN, upN).normalize();   // ре-ортогонализация (без перекосов)
      basisM.makeBasis(rightN, upN, fwdN);           // локальные +X,+Y(вверх),+Z(вперёд)
      targetQ.setFromRotationMatrix(basisM);
      S.group.quaternion.slerp(targetQ, slerpT);     // плавно, без рывков
    };

    // выбрать путевую точку патруля: достижимая клетка подальше, по возможности в
    // нужном направлении preferH (радианы). reach считается ниже — на момент вызова готов.
    const wrapPi = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
    const nearestWall = (x: number, z: number, maxDist: number) => {
      let best: { nx: number; nz: number; d: number; outer: boolean } | null = null;
      for (const r of wallRects) {
        const cx = Math.max(r.minX, Math.min(x, r.maxX));
        const cz = Math.max(r.minZ, Math.min(z, r.maxZ));
        let dx = x - cx, dz = z - cz;
        let d = Math.hypot(dx, dz);
        if (d < 1e-5) {
          const left = Math.abs(x - r.minX), right = Math.abs(r.maxX - x);
          const top = Math.abs(z - r.minZ), bottom = Math.abs(r.maxZ - z);
          const m = Math.min(left, right, top, bottom);
          if (m === left) { dx = -1; dz = 0; d = 0; }
          else if (m === right) { dx = 1; dz = 0; d = 0; }
          else if (m === top) { dx = 0; dz = -1; d = 0; }
          else { dx = 0; dz = 1; d = 0; }
        }
        if (d > maxDist) continue;
        const outer =
          Math.abs(r.minX - bxMin) < 0.05 ||
          Math.abs(r.maxX - bxMax) < 0.05 ||
          Math.abs(r.minZ - bzMin) < 0.05 ||
          Math.abs(r.maxZ - bzMax) < 0.05;
        if (!best || d < best.d) best = { nx: dx / (d || 1), nz: dz / (d || 1), d, outer };
      }
      return best;
    };
    const pickWaypoint = (fromX: number, fromZ: number, preferH: number | null) => {
      let best: { x: number; z: number } | null = null, bestScore = -Infinity;
      for (let t = 0; t < 26; t++) {
        const c = reach[(Math.random() * reach.length) | 0];
        if (!c) break;
        const d = Math.hypot(c.x - fromX, c.z - fromZ);
        if (d < 10 * mapScale) continue;             // не слишком близко
        let score = Math.min(d, 40 * mapScale) * 0.05 + Math.random() * 0.5;
        if (preferH != null) {
          const ang = Math.atan2(c.x - fromX, c.z - fromZ);
          score += Math.PI - Math.abs(wrapPi(ang - preferH)); // ближе к курсу Gemini → выше
        }
        if (score > bestScore) { bestScore = score; best = c; }
      }
      return best || reach[(Math.random() * reach.length) | 0] || { x: fromX, z: fromZ };
    };

    function buildSpider() {
      // Ширина тела = ширина прохода коридора (≈ CW − TH), чтобы паук идеально
      // проходил в выход из центрального квадрата. По длине тело может быть больше.
      const bodyR = (CW - TH) / 2 * 0.97 * finalSpiderScale; // полуширина ≈ половина прохода
      const diameter = bodyR * 2;
      const legLen = diameter * 1.8;      // длинные лапки
      // глянцевый металлически-красный (как на референсе)
      const redBody = new THREE.MeshStandardMaterial({ color: 0xc8160c, emissive: 0x2c0402, emissiveIntensity: 0.35, metalness: 0.85, roughness: 0.18, envMapIntensity: 1.1 });
      const redLeg = new THREE.MeshStandardMaterial({ color: 0xb01608, emissive: 0x1e0301, emissiveIntensity: 0.35, metalness: 0.55, roughness: 0.4, envMapIntensity: 0.8 });
      const footMat = new THREE.MeshStandardMaterial({ color: 0x240a05, roughness: 0.75, metalness: 0.2 }); // тёмные кончики
      const eyeMat = new THREE.MeshStandardMaterial({ color: 0x050506, metalness: 0.1, roughness: 0.05 }); // чёрные блестящие глаза
      const shineMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9 });
      const hairMat = new THREE.MeshStandardMaterial({ color: 0x160604, roughness: 0.95, metalness: 0.05 });
      const s = new THREE.Group();

      // ── Волоски (детализация) ──────────────────────────────
      // Единичный конус-волосок масштабируем по длине; ориентируем вдоль нормали.
      const hairGeo = new THREE.ConeGeometry(0.5, 1, 4);
      const UP = new THREE.Vector3(0, 1, 0);
      const addHair = (parent: THREE.Object3D, px: number, py: number, pz: number, nx: number, ny: number, nz: number, len: number, thick: number) => {
        const n = new THREE.Vector3(nx, ny, nz).normalize();
        const h = new THREE.Mesh(hairGeo, hairMat);
        h.scale.set(thick, len, thick);
        h.quaternion.setFromUnitVectors(UP, n);
        h.position.set(px, py, pz).addScaledVector(n, len * 0.5);
        parent.add(h);
      };
      // опушка по эллипсоиду тела: волоски торчат наружу (и чуть вверх)
      const furSphere = (cx: number, cy: number, cz: number, r: number, sc: THREE.Vector3, count: number, len: number, thick: number) => {
        for (let k = 0; k < count; k++) {
          const u = Math.random(), v = Math.random();
          const th = 2 * Math.PI * u, ph = Math.acos(2 * v - 1);
          const nx = Math.sin(ph) * Math.cos(th), ny = Math.cos(ph), nz = Math.sin(ph) * Math.sin(th);
          addHair(s, cx + nx * r * sc.x, cy + ny * r * sc.y, cz + nz * r * sc.z, nx, ny * 0.6 + 0.4, nz, len, thick);
        }
      };
      // опушка вдоль кости (сегмента ноги): волоски по бокам, наружу и вверх
      const furSeg = (segG: THREE.Object3D, segLen: number, rows: number, len: number, thick: number) => {
        for (let r = 0; r < rows; r++) {
          const y = segLen * (0.18 + 0.64 * (rows === 1 ? 0.5 : r / (rows - 1)));
          for (const [dx, dz] of [[1, 0.35], [-1, 0.35], [0.35, 1], [0.35, -1]] as const) {
            addHair(segG, 0, y, 0, dx, 0.55, dz, len, thick);
          }
        }
      };

      // ── Тело: головогрудь (перед, +Z) + брюшко (зад) — поджарое, не «жирное» ──
      const cephalo = new THREE.Mesh(new THREE.SphereGeometry(bodyR * 0.62, 28, 20), redBody);
      cephalo.position.set(0, 0, bodyR * 0.5); cephalo.scale.set(0.92, 0.62, 1.0); cephalo.castShadow = true;
      const abdomen = new THREE.Mesh(new THREE.SphereGeometry(bodyR * 0.72, 30, 24), redBody);
      abdomen.position.set(0, bodyR * 0.08, -bodyR * 0.75); abdomen.scale.set(0.82, 0.72, 1.3); abdomen.castShadow = true;
      s.add(cephalo, abdomen);
      const wallDrop = new THREE.Group();
      const dropBody = new THREE.Mesh(new THREE.CapsuleGeometry(bodyR * 0.34, WALL_H * 0.72, 6, 12), redBody);
      dropBody.position.y = -WALL_H * 0.45;
      dropBody.castShadow = true;
      const dropTip = new THREE.Mesh(new THREE.SphereGeometry(bodyR * 0.38, 16, 12), redBody);
      dropTip.position.y = -WALL_H * 0.86;
      dropTip.castShadow = true;
      wallDrop.add(dropBody, dropTip);
      wallDrop.visible = false;
      s.add(wallDrop);
      // опушка тела — много тонких волосков (детализация как на фото)
      furSphere(abdomen.position.x, abdomen.position.y, abdomen.position.z, bodyR * 0.72, abdomen.scale, 70, bodyR * 0.3, bodyR * 0.014);
      furSphere(cephalo.position.x, cephalo.position.y, cephalo.position.z, bodyR * 0.62, cephalo.scale, 34, bodyR * 0.2, bodyR * 0.012);
      // хелицеры + мохнатый «рот» снизу спереди (как на фото — тёмный, волосатый)
      const mouth = new THREE.Mesh(new THREE.SphereGeometry(bodyR * 0.22, 16, 12), hairMat);
      mouth.position.set(0, -bodyR * 0.26, bodyR * 0.92); mouth.scale.set(1, 0.9, 0.7); s.add(mouth);
      for (const fx of [-1, 1]) {
        const fang = new THREE.Mesh(new THREE.ConeGeometry(bodyR * 0.07, bodyR * 0.28, 8), footMat);
        fang.position.set(fx * bodyR * 0.14, -bodyR * 0.42, bodyR * 0.92); fang.rotation.x = Math.PI * 0.92;
        s.add(fang);
      }
      // ── Глаза кучкой спереди (паук всё равно слепой — для вида) ──
      // 2 больших передних + 2 средних сверху + 2 маленьких по бокам.
      const eyeFront = bodyR * 1.0;
      const addEye = (ex: number, ey: number, r: number) => {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 14), eyeMat);
        eye.position.set(ex, ey, eyeFront - (bodyR - r) * 0.15); s.add(eye);
        const sh = new THREE.Mesh(new THREE.SphereGeometry(r * 0.28, 8, 8), shineMat);
        sh.position.set(ex - r * 0.35, ey + r * 0.4, eyeFront + r * 0.8 - (bodyR - r) * 0.15); s.add(sh);
      };
      addEye(-bodyR * 0.2, -bodyR * 0.02, bodyR * 0.17);  // большие передние
      addEye(bodyR * 0.2, -bodyR * 0.02, bodyR * 0.17);
      addEye(-bodyR * 0.18, bodyR * 0.28, bodyR * 0.11);  // средние сверху
      addEye(bodyR * 0.18, bodyR * 0.28, bodyR * 0.11);
      addEye(-bodyR * 0.42, bodyR * 0.14, bodyR * 0.08);  // маленькие по бокам
      addEye(bodyR * 0.42, bodyR * 0.14, bodyR * 0.08);

      // ── Реалистичная нога: бедро вверх-наружу к приподнятому колену,
      //    затем голень вниз-наружу к полу; сегменты сужаются, тёмный кончик + волоски. ──
      const boneZ = (len: number, rT: number, rB: number, angleZ: number, mat: THREE.Material) => {
        const g = new THREE.Group(); g.rotation.z = angleZ;
        const m = new THREE.Mesh(new THREE.CylinderGeometry(rT, rB, len, 8), mat);
        m.position.y = len / 2; m.castShadow = true; g.add(m);
        const tip = new THREE.Group(); tip.position.y = len; g.add(tip);
        return { g, tip };
      };
      const upAngle = 0.55;                 // наклон бедра от вертикали (вверх-наружу)
      const downExtra = 0.35;               // доворот голени вниз за колено
      const femurLen = legLen * 0.5, tibiaLen = legLen * 0.8;
      const kneeY = Math.cos(upAngle) * femurLen;
      const footY = kneeY - Math.cos(downExtra) * tibiaLen; // y ступни относительно тела (<0)

      const legs: SpiderLeg[] = [];
      for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
        const legG = new THREE.Group();
        const zOff = (i - 1.5) * (bodyR * 0.5);
        const rootX = side * bodyR * 0.55;
        const rootY = bodyR * 0.1;
        const rootZ = zOff;
        legG.position.set(rootX, rootY, rootZ);
        const femurAngle = -side * upAngle;                     // бедро вверх-наружу
        const fem = boneZ(femurLen, legLen * 0.04, legLen * 0.06, femurAngle, redLeg);
        const tibiaWorld = -side * (Math.PI - downExtra);       // голень вниз-наружу
        const baseTibia = tibiaWorld - femurAngle;
        const tib = boneZ(tibiaLen, legLen * 0.018, legLen * 0.038, baseTibia, redLeg);
        // тёмный кончик-лапка
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(legLen * 0.018, legLen * 0.008, legLen * 0.16, 6), footMat);
        foot.position.y = legLen * 0.08; foot.castShadow = true; tib.tip.add(foot);
        // густые волоски на бедре и голени
        furSeg(fem.g, femurLen, 2, legLen * 0.1, legLen * 0.006);
        furSeg(tib.g, tibiaLen, 3, legLen * 0.11, legLen * 0.005);
        fem.tip.add(tib.g); legG.add(fem.g);
        const baseY = side > 0 ? (-0.7 + i * 0.47) : (0.7 - i * 0.47); // веер передних/задних ног
        legG.rotation.y = baseY;
        s.add(legG);
        // ПОПЕРЕМЕННАЯ ТЕТРАПОДНАЯ походка, как у настоящих пауков: 8 ног идут
        // двумя группами по 4 «по диагонали» (L0,L2,R1,R3 ↔ L1,L3,R0,R2). Соседние
        // ноги на одной стороне в противофазе, левая и правая стороны тоже. Лёгкая
        // метахрональная волна (i*0.18) добавляет естественную «рябь».
        const group = (i % 2 === 0) ? 0 : Math.PI;
        const sideShift = side > 0 ? Math.PI : 0;
        const phase = group + sideShift + i * 0.18;
        legs.push({
          legG, fem: fem.g, tib: tib.g, foot: tib.tip,
          rootX, rootY, rootZ,
          baseY, baseFemur: femurAngle, baseTibia, side, phase,
        });
      }
      s.position.y = -footY + 0.05; // ступни ровно на полу
      scene.add(s);
      // горизонтальный размах лап от центра (чтобы касание ЛАП тоже убивало)
      const legReach = bodyR * 0.55
        + femurLen * Math.sin(upAngle)
        + tibiaLen * Math.sin(Math.PI - downExtra);
      return { group: s, legs, touchR: bodyR, legReach, bodyY: s.position.y, wallDrop };
    }
    // создать паука в (x,z) с курсом heading и добавить в массив
    const spawnSpider = (x: number, z: number, heading: number) => {
      const v = buildSpider();
      const p = new THREE.Vector3(x, 0, z);
      resolveCircle(p, SP_R);                 // вытолкнуть из стены, если задело
      v.group.position.set(p.x, v.bodyY, p.z);
      v.group.rotation.y = heading;
      // разный сдвиг курса у каждого паука → клоны не сбиваются в кучу
      const bias = spiders.length * 0.7 - 0.35;
      const wp = pickWaypoint(p.x, p.z, null);
      spiders.push({
        ...v, heading, dist: 0, bias,
        state: 'IDLE', wpX: wp.x, wpZ: wp.z,
        stuck: 0, lastX: p.x, lastZ: p.z, idleT: 0,
        wallClimb: 0, wallNx: 0, wallNz: 1,
      });
    };
    // паук спавнится на ВСЕХ уровнях в СЛУЧАЙНОЙ достижимой точке подальше от
    // игрока (не всегда слева), курсом в случайную сторону.
    {
      if (onlyMoveSpider) {
        spawnSpider(START_X, START_Z, Math.random() * Math.PI * 2);
      } else {
        const far = reach.filter((c) => Math.hypot(c.x - START_X, c.z - START_Z) > 18 * mapScale && clearAt(c.x, c.z) >= SP_R + 0.3);
        const pool = far.length ? far : reach;
        const cell = pool.length ? pool[Math.floor(Math.random() * pool.length)] : { x: minWX + SP_R + 1.2, z: 0 };
        spawnSpider(cell.x, cell.z, Math.random() * Math.PI * 2);
      }
    }

    // ── Клавиатура ─────────────────────────────────────────
    const keys: Record<string, boolean> = {};
    let mapView = false;     // режим осмотра всей карты (клавиша M)
    let switchesActive = 0;  // сколько переключателей дёрнуто

    // ── Сирена (синтез через WebAudio, без файла) ──────────
    // Громкий воющий звук при активации переключателя.
    let audioCtx: AudioContext | null = null;
    const playSiren = () => {
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtx = audioCtx || new AC();
        const ctx = audioCtx;
        const t0 = ctx.currentTime, dur = 1.8;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        // вой вверх-вниз
        for (let i = 0; i <= 3; i++) {
          osc.frequency.setValueAtTime(i % 2 ? 1150 : 580, t0 + i * 0.45);
          osc.frequency.linearRampToValueAtTime(i % 2 ? 580 : 1150, t0 + i * 0.45 + 0.45);
        }
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.7, t0 + 0.04); // громко
        gain.gain.setValueAtTime(0.7, t0 + dur - 0.15);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + dur);
      } catch { /* нет WebAudio */ }
    };

    // ── Звук скримера: резкий диссонансный визг + шум ──────
    const playScream = () => {
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtx = audioCtx || new AC();
        const ctx = audioCtx;
        if (ctx.state === 'suspended') ctx.resume();
        const t0 = ctx.currentTime, dur = 1.6;
        // шумовой всплеск (затухающий)
        const n = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 0.5);
        const noise = ctx.createBufferSource(); noise.buffer = buf;
        const nGain = ctx.createGain(); nGain.gain.value = 0.45;
        noise.connect(nGain).connect(ctx.destination);
        // диссонансные пилы, скользящие вниз
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.85, t0 + 0.02); // очень громко, мгновенно
        g.gain.setValueAtTime(0.85, t0 + dur - 0.25);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        g.connect(ctx.destination);
        for (const f of [180, 196, 466, 933, 1400]) {
          const o = ctx.createOscillator(); o.type = 'sawtooth';
          o.frequency.setValueAtTime(f, t0);
          o.frequency.linearRampToValueAtTime(f * 0.45, t0 + dur);
          o.connect(g); o.start(t0); o.stop(t0 + dur);
        }
        noise.start(t0); noise.stop(t0 + dur);
      } catch { /* нет WebAudio */ }
    };

    type FinalLightning = { line: THREE.Line; life: number };
    type FinalPiece = { mesh: THREE.Object3D; velocity: THREE.Vector3; spin: THREE.Vector3; life: number };
    type FinalShock = { mesh: THREE.Mesh; light: THREE.PointLight; life: number; maxLife: number };
    const finalCutscene = {
      active: false,
      t: 0,
      ended: false,
      burstDone: false,
      bloodDone: false,
      burstShake: 0,
      lightnings: [] as FinalLightning[],
      pieces: [] as FinalPiece[],
      shocks: [] as FinalShock[],
      blood: [] as THREE.Object3D[],
    };
    const makeLightningLine = (from: THREE.Vector3, to: THREE.Vector3, color = 0xfff06a, life = 0.22) => {
      const pts: THREE.Vector3[] = [from.clone()];
      for (let i = 1; i < 5; i++) {
        const t = i / 5;
        pts.push(new THREE.Vector3(
          from.x + (to.x - from.x) * t + (Math.random() - 0.5) * 1.2,
          from.y + (to.y - from.y) * t + (Math.random() - 0.5) * 0.9,
          from.z + (to.z - from.z) * t + (Math.random() - 0.5) * 1.2,
        ));
      }
      pts.push(to.clone());
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }),
      );
      scene.add(line);
      finalCutscene.lightnings.push({ line, life });
    };
    const addSpiderPieces = (x: number, z: number) => {
      const mat = new THREE.MeshStandardMaterial({ color: 0x8b0905, emissive: 0x350000, emissiveIntensity: 0.8, roughness: 0.72 });
      for (let i = 0; i < 38; i++) {
        const piece = new THREE.Mesh(
          i % 4 === 0
            ? new THREE.CapsuleGeometry(0.12, 0.75, 4, 8)
            : i % 4 === 1
              ? new THREE.BoxGeometry(0.22 + Math.random() * 0.38, 0.16 + Math.random() * 0.32, 0.22 + Math.random() * 0.38)
              : new THREE.SphereGeometry(0.16 + Math.random() * 0.26, 10, 8),
          mat,
        );
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.85;
        piece.position.set(x + Math.cos(a) * r, 1.1 + Math.random() * 1.6, z + Math.sin(a) * r);
        piece.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
        piece.castShadow = true;
        scene.add(piece);
        const speed = 7 + Math.random() * 9;
        finalCutscene.pieces.push({
          mesh: piece,
          velocity: new THREE.Vector3(Math.cos(a) * speed, 5 + Math.random() * 8, Math.sin(a) * speed),
          spin: new THREE.Vector3((Math.random() - 0.5) * 13, (Math.random() - 0.5) * 13, (Math.random() - 0.5) * 13),
          life: 4.2,
        });
      }
    };
    const addSpiderBurst = (x: number, z: number) => {
      const light = new THREE.PointLight(0xfff2aa, 9, 30);
      light.position.set(x, 3.2, z);
      scene.add(light);

      const shockMat = new THREE.MeshBasicMaterial({
        color: 0xfff2aa,
        transparent: true,
        opacity: 0.82,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const shock = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 8, 72), shockMat);
      shock.position.set(x, 0.18, z);
      shock.rotation.x = Math.PI / 2;
      scene.add(shock);
      finalCutscene.shocks.push({ mesh: shock, light, life: 0.75, maxLife: 0.75 });

      const top = new THREE.Vector3(x, 8, z);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + Math.random() * 0.35;
        makeLightningLine(top, new THREE.Vector3(x + Math.cos(a) * (4 + Math.random() * 5), 0.55, z + Math.sin(a) * (4 + Math.random() * 5)), 0xfff2aa, 0.34);
      }
      finalCutscene.burstShake = 0.9;
    };
    const addSpiderBloodToPlayer = () => {
      const mat = new THREE.MeshBasicMaterial({ color: 0x7a0503, transparent: true, opacity: 0.86 });
      for (let i = 0; i < 14; i++) {
        const drop = new THREE.Mesh(new THREE.SphereGeometry(0.06 + Math.random() * 0.08, 8, 6), mat);
        drop.position.set((Math.random() - 0.5) * 0.75, 1.0 + Math.random() * 1.3, 0.32 + Math.random() * 0.28);
        player.add(drop);
        finalCutscene.blood.push(drop);
      }
    };
    const startFinalCutscene = () => {
      if (finalCutscene.active || finalCutscene.ended) return;
      finalCutscene.active = true;
      finalCutscene.t = 0;
      finalCutscene.burstDone = false;
      finalCutscene.bloodDone = false;
      finalCutscene.burstShake = 0;
      setPaused(false);
      pausedRef.current = false;
      setFinalEnding(false);
      try { localStorage.removeItem(SAVE_KEY); } catch { /* нет localStorage */ }
    };
    const updateFinalCutscene = (dt: number) => {
      finalCutscene.t += dt;
      const t = finalCutscene.t;
      const centerX = START_X;
      const centerZ = START_Z;
      const poleTop = new THREE.Vector3(centerX, 5.2, centerZ);
      const spider = spiders[0];
      const runR = 6.2 * mapScale;

      if (t < 5) {
        const a = t * 1.9;
        player.visible = true;
        player.position.set(centerX + Math.cos(a) * runR, 0, centerZ + Math.sin(a) * runR);
        faceAngle = Math.atan2(-Math.sin(a), Math.cos(a));
        player.rotation.y = faceAngle;
        setPlayerRunPose(t * 13.5, 1);
        if (spider) {
          spider.group.visible = true;
          spider.group.position.set(centerX + Math.cos(a - 0.85) * runR, spider.bodyY, centerZ + Math.sin(a - 0.85) * runR);
          spider.heading = Math.atan2(player.position.x - spider.group.position.x, player.position.z - spider.group.position.z);
          spider.group.rotation.y = spider.heading;
        }
        if (Math.random() < 0.55) {
          const a2 = Math.random() * Math.PI * 2;
          makeLightningLine(poleTop, new THREE.Vector3(centerX + Math.cos(a2) * (7 + Math.random() * 7), 0.45, centerZ + Math.sin(a2) * (7 + Math.random() * 7)), 0xffd84a, 0.18);
        }
        camera.position.set(centerX, 18, centerZ + 18);
        camera.lookAt(centerX, 1.2, centerZ);
      } else if (t < 8) {
        if (firstPersonRef.current !== true) setFirstPerson(true);
        player.visible = false;
        faceAngle = Math.atan2(centerX - player.position.x, centerZ - player.position.z);
        const eyeH = 3.6;
        const fx = Math.sin(faceAngle), fz = Math.cos(faceAngle);
        camera.position.set(player.position.x + fx * 0.3, eyeH, player.position.z + fz * 0.3);
        camera.lookAt(centerX, 3.0, centerZ);
        if (spider) {
          const sp = spider.group.position;
          if (Math.random() < 0.95) makeLightningLine(poleTop, new THREE.Vector3(sp.x, sp.y + 1.4, sp.z), 0xffffaa, 0.16);
          if (t > 7 && !finalCutscene.burstDone) {
            finalCutscene.burstDone = true;
            playScream();
            spider.group.visible = false;
            addSpiderBurst(sp.x, sp.z);
            addSpiderPieces(sp.x, sp.z);
            addSpiderBloodToPlayer();
          }
        }
      } else if (t < 12) {
        if (!finalCutscene.bloodDone) {
          finalCutscene.bloodDone = true;
          setFirstPerson(false);
          player.visible = true;
        }
        const u = Math.min(1, (t - 8) / 4);
        const startX = centerX + runR * 0.35;
        const startZ = centerZ + runR * 0.5;
        player.position.set(startX + (GEN_X - startX) * u, 0, startZ + ((GEN_Z + 2.4 * mapScale) - startZ) * u);
        faceAngle = Math.atan2(GEN_X - player.position.x, (GEN_Z + 2.4 * mapScale) - player.position.z);
        player.rotation.y = faceAngle;
        setPlayerRunPose((t - 8) * 15, 1);
        finalGateLeft.position.x = -1.8 * u;
        finalGateRight.position.x = 1.8 * u;
        camera.position.set(player.position.x, 13, player.position.z + 8);
        camera.lookAt(player.position.x, 1.2, player.position.z - 2);
      } else {
        finalCutscene.active = false;
        finalCutscene.ended = true;
        setFinalEnding(true);
      }

      if (finalCutscene.burstShake > 0) {
        const s = finalCutscene.burstShake;
        camera.position.x += (Math.random() - 0.5) * s * 0.55;
        camera.position.y += (Math.random() - 0.5) * s * 0.35;
        camera.position.z += (Math.random() - 0.5) * s * 0.55;
        finalCutscene.burstShake = Math.max(0, s - dt * 1.8);
      }

      for (let i = finalCutscene.pieces.length - 1; i >= 0; i--) {
        const p = finalCutscene.pieces[i];
        p.life -= dt;
        p.velocity.y -= 12 * dt;
        p.velocity.multiplyScalar(1 - dt * 0.18);
        p.mesh.position.addScaledVector(p.velocity, dt);
        p.mesh.rotation.x += p.spin.x * dt;
        p.mesh.rotation.y += p.spin.y * dt;
        p.mesh.rotation.z += p.spin.z * dt;
        if (p.mesh.position.y < 0.28) {
          p.mesh.position.y = 0.28;
          p.velocity.y = Math.abs(p.velocity.y) * 0.32;
          p.velocity.x *= 0.68;
          p.velocity.z *= 0.68;
        }
        if (p.life <= 0) finalCutscene.pieces.splice(i, 1);
      }

      for (let i = finalCutscene.shocks.length - 1; i >= 0; i--) {
        const s = finalCutscene.shocks[i];
        s.life -= dt;
        const k = 1 - Math.max(0, s.life) / s.maxLife;
        s.mesh.scale.setScalar(1 + k * 8);
        const mat = s.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 0.82 * (1 - k));
        s.light.intensity = Math.max(0, 9 * (1 - k));
        if (s.life <= 0) {
          scene.remove(s.mesh);
          scene.remove(s.light);
          s.mesh.geometry.dispose();
          mat.dispose();
          finalCutscene.shocks.splice(i, 1);
        }
      }

      for (let i = finalCutscene.lightnings.length - 1; i >= 0; i--) {
        const l = finalCutscene.lightnings[i];
        l.life -= dt;
        const mat = l.line.material as THREE.LineBasicMaterial;
        mat.opacity = Math.max(0, l.life / 0.22);
        if (l.life <= 0) {
          scene.remove(l.line);
          l.line.geometry.dispose();
          mat.dispose();
          finalCutscene.lightnings.splice(i, 1);
        }
      }
    };

    // Проверка завершения уровня: ВСЕ батарейки доставлены И ВСЕ переключатели
    // дёрнуты. Если батарейки готовы, а переключатель нет — уровень не пройден.
    function tryComplete() {
      if (finished) return;
      if (collectedCount < batteryGoal || switchesActive < switchGoal) return;
      finished = true;
      try { localStorage.removeItem(SAVE_KEY); } catch { /* нет localStorage */ }
      if (levelNum >= LEVELS) { startFinalCutscene(); }       // последний уровень → финальная катсцена
      else { setLevelCleared(true); }                  // иначе → экран «уровень пройден»
    }

    const activateNearestSwitch = () => {
      for (const sw of switchesArr) {
        if (sw.active) continue;
        if (Math.hypot(sw.x - player.position.x, sw.z - player.position.z) < 3.4) {
          sw.active = true; sw.setActive(true);
          switchesActive++; setSwitchesOn(switchesActive);
          playSiren(); tryComplete();
          if (can.hear) { noiseAlert = NOISE_HEARD; noiseX = player.position.x; noiseZ = player.position.z; }
          break;
        }
      }
    };
    switchFnRef.current = activateNearestSwitch;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!startedRef.current) return; // на меню клавиши игнорируются
      keys[e.code] = true;
      if (e.code === 'Escape' && !finished) { // пауза / снятие паузы
        pausedRef.current = !pausedRef.current;
        setPaused(pausedRef.current);
        return;
      }
      if (e.code === 'KeyM') {
        mapView = !mapView;
        document.exitPointerLock?.();
      }
      if (e.code === 'KeyQ') dropFnRef.current?.(); // выбросить батарейку
      if (e.code === 'KeyE') activateNearestSwitch(); // дёрнуть ближайший переключатель → сирена
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => { keys[e.code] = false; };
    const onMouseMove = (e: MouseEvent) => {
      if (!firstPersonRef.current || document.pointerLockElement !== renderer.domElement) return;
      if (!startedRef.current || introRef.current || pausedRef.current || mapView || finished) return;
      faceAngle -= e.movementX * FIRST_PERSON_MOUSE_SENS;
    };
    const onCanvasClick = () => {
      if (!firstPersonRef.current || !startedRef.current || introRef.current || pausedRef.current || mapView || finished) return;
      renderer.domElement.requestPointerLock?.();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    renderer.domElement.addEventListener('click', onCanvasClick);

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
    const FIRST_PERSON_MOUSE_SENS = 0.0026;
    const FIRST_PERSON_KEY_TURN = 2.5;
    let vision = NORMAL_VISION;
    let walkPhase = 0;
    let walkAmt = 0; // 0 — стоит, 1 — идёт (для плавного старта/стопа)

    // ── Состояние батареек ──
    let carrying: Battery | null = null; // батарейка в руках (или null)
    let collectedCount = 0;              // сколько доставлено в генератор

    // ── Голод (целые единицы сытости) ──
    const SATIETY_MAX = 3;               // максимум сытости (и старт)
    const HUNGER_INTERVAL = 30;          // −1 сытость каждые 30 c → полный запас ≈ 90 c
    const MEAT_SPAWN_INTERVAL = 30;      // новое мясо появляется каждые 30 c
    let satietyVal = SATIETY_MAX;        // текущая сытость (целое 0..3)
    let hungerTimer = 0;                 // секунд с прошлого «минус сытость»
    let meatSpawnTimer = 0;              // секунд с прошлого нового мяса
    setSatiety(SATIETY_MAX);             // сброс HUD на старте уровня

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
    let deadFlag = false;  // паук коснулся игрока — сцена замораживается
    pausedRef.current = false;

    // ── Загрузка сохранённого прогресса ────────────────────
    // Если есть сохранение — восстанавливаем счётчик, позицию игрока и батарейки
    // (доставленные/выброшенные/несомую), иначе остаётся случайный спавн.
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const sv = JSON.parse(raw) as {
          level?: number; collected?: number; carryingIndex?: number | null;
          player?: { x: number; z: number; face: number };
          batteries?: {
            x: number; z: number; delivered: boolean; carried: boolean;
            abilityGiven?: boolean; pickupAbilityGiven?: boolean; insertAbilityGiven?: boolean;
          }[];
          switches?: boolean[];
        };
        // сохранение от ДРУГОГО уровня (например только {level}) — спавн оставляем свежим
        if ((sv.level ?? levelNum) === levelNum) {
        collectedCount = sv.collected ?? 0;
        setCollected(collectedCount);
        if (Array.isArray(sv.switches)) {
          sv.switches.forEach((on, i) => {
            const sw = switchesArr[i];
            if (sw && on) { sw.active = true; sw.setActive(true); switchesActive++; }
          });
          setSwitchesOn(switchesActive);
        }
        if (sv.player) { player.position.set(sv.player.x, 0, sv.player.z); faceAngle = sv.player.face ?? 0; }
        if (Array.isArray(sv.batteries)) {
          sv.batteries.forEach((sb, i) => {
            const b = batteries[i];
            if (!b) return;
            b.delivered = !!sb.delivered;
            b.carried = !!sb.carried;
            b.pickupAbilityGiven = !!(sb.pickupAbilityGiven ?? sb.abilityGiven);
            b.insertAbilityGiven = !!sb.insertAbilityGiven;
            if (onlyMoveSpider) {
              if (b.pickupAbilityGiven) unlockNextSpiderAbility();
              if (b.insertAbilityGiven) unlockNextSpiderAbility();
            }
            if (b.delivered) scene.remove(b.group);
            else b.group.position.set(sb.x, sb.carried ? 2.0 : 0.55, sb.z);
          });
          const ci = sv.carryingIndex;
          if (ci != null && batteries[ci] && !batteries[ci].delivered) {
            carrying = batteries[ci];
            carrying.carried = true;
          }
        }
        } // конец: сохранение того же уровня
      }
    } catch { /* нет localStorage или битое сохранение */ }

    if (onlyMoveSpider && collectedCount > 0) {
      let filledSlots = 0;
      for (const slot of genSlots) {
        if (slot.reusable || filledSlots >= collectedCount) continue;
        slot.used = true;
        slot.fill();
        filledSlots++;
      }
    }

    // снимок текущего состояния для сохранения (вызывается из кнопок паузы)
    getStateRef.current = () => ({
      level: levelNum,
      collected: collectedCount,
      carryingIndex: carrying ? batteries.indexOf(carrying) : null,
      player: { x: player.position.x, z: player.position.z, face: faceAngle },
      batteries: batteries.map((b) => ({
        x: b.group.position.x, z: b.group.position.z, delivered: b.delivered, carried: b.carried,
        pickupAbilityGiven: b.pickupAbilityGiven, insertAbilityGiven: b.insertAbilityGiven,
      })),
      switches: switchesArr.map((s) => s.active),
    });

    function animate() {
      frameId = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (pausedRef.current) { renderer.render(scene, camera); return; } // на паузе — заморозка
      if (deadFlag) { renderer.render(scene, camera); return; }          // смерть — заморозка
      if (finalCutscene.active) { updateFinalCutscene(dt); renderer.render(scene, camera); return; }

      const webMul = webSlow > 0 ? 0.45 : 1; // опутан паутиной → медленнее
      const speed = (carrying ? 5 * 0.67 : 5) * webMul; // с батарейкой ещё на 33% медленнее
      const touchMove = mobileInputRef.current;
      let mx = 0;
      let mz = 0;
      if (firstPersonRef.current && !mapView) {
        const turn = (keys['ArrowRight'] ? 1 : 0) - (keys['ArrowLeft'] ? 1 : 0);
        faceAngle -= turn * FIRST_PERSON_KEY_TURN * dt;
        const strafe = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0) + touchMove.mx;
        const forward = (keys['KeyW'] || keys['ArrowUp'] ? 1 : 0) - (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0) - touchMove.mz;
        const fx = Math.sin(faceAngle), fz = Math.cos(faceAngle);
        const rx = Math.cos(faceAngle), rz = -Math.sin(faceAngle);
        mx = fx * forward + rx * strafe;
        mz = fz * forward + rz * strafe;
      } else {
        mx = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0) + touchMove.mx;
        mz = (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0) - (keys['KeyW'] || keys['ArrowUp'] ? 1 : 0) + touchMove.mz;
      }
      // на меню и на заставке игрок стоит (сцена = фон)
      if (!startedRef.current || introRef.current) { mx = 0; mz = 0; }
      const len = Math.hypot(mx, mz);
      const moving = len > 0;

      if (moving) {
        mx /= len; mz /= len;
        player.position.x += mx * speed * dt;
        player.position.z += mz * speed * dt;
        if (!firstPersonRef.current || mapView) faceAngle = Math.atan2(mx, mz);
      }
      player.rotation.y = faceAngle;
      resolveCollision(player.position);

      // ── Батарейки: подбор / переноска / доставка ──
      if (carrying) {
        // несём батарейку чуть впереди игрока (в направлении взгляда)
        const fx = Math.sin(faceAngle), fz = Math.cos(faceAngle);
        const side = firstPersonRef.current ? 0.55 : 0;
        const front = firstPersonRef.current ? 1.05 : 1.4;
        const holdY = firstPersonRef.current ? 1.25 : 2.0;
        carrying.group.position.set(
          player.position.x + fx * front + Math.cos(faceAngle) * side,
          holdY,
          player.position.z + fz * front - Math.sin(faceAngle) * side,
        );
        carrying.group.rotation.y = faceAngle;
        // доставка: коллизия батарейки касается коллизии генератора → исчезает
        const bx = carrying.group.position.x, bz = carrying.group.position.z, hb = 0.5;
        const hitSlot = genSlots.find((s) =>
          (s.reusable || !s.used) &&
          bx + hb > s.rect.minX && bx - hb < s.rect.maxX &&
          bz + hb > s.rect.minZ && bz - hb < s.rect.maxZ
        );
        if (hitSlot) {
          hitSlot.used = true;
          hitSlot.fill();
          scene.remove(carrying.group);
          if (onlyMoveSpider && !carrying.insertAbilityGiven) {
            carrying.insertAbilityGiven = true;
            unlockNextSpiderAbility();
          }
          carrying.delivered = true;
          carrying = null;
          collectedCount++;
          setCollected(collectedCount);
          tryComplete(); // все батарейки + все переключатели → следующий уровень / победа
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
            if (onlyMoveSpider && !b.pickupAbilityGiven) {
              b.pickupAbilityGiven = true;
              unlockNextSpiderAbility();
            }
            carrying = b;
            break;
          }
        }
      }
      // лежащие на полу батарейки медленно крутятся (заметнее)
      for (const b of batteries) {
        if (!b.delivered && !b.carried) b.group.rotation.y += dt * 1.5;
      }

      // ── ГОЛОД (способность паука, со 2-го уровня): сытость тает; мясо её восполняет ──
      if (hungerActive && startedRef.current && !introRef.current && !finished) {
        // тик голода: −1 сытость каждые HUNGER_INTERVAL секунд
        hungerTimer += dt;
        if (hungerTimer >= HUNGER_INTERVAL) {
          hungerTimer -= HUNGER_INTERVAL;
          satietyVal = Math.max(0, satietyVal - 1);
          setSatiety(satietyVal);
        }
        meatSpawnTimer += dt;
        if (meatSpawnTimer >= MEAT_SPAWN_INTERVAL) {
          meatSpawnTimer -= MEAT_SPAWN_INTERVAL;
          const meatSpawnPts = reach.filter((c) =>
            clearAt(c.x, c.z) >= 1.3 &&
            Math.hypot(c.x - player.position.x, c.z - player.position.z) > 8 &&
            meats.every((m) => m.eaten || Math.hypot(m.group.position.x - c.x, m.group.position.z - c.z) > 5)
          );
          const p = meatSpawnPts.length ? meatSpawnPts[Math.floor(Math.random() * meatSpawnPts.length)] : null;
          if (p) meats.push(makeMeat(p.x, p.z));
        }
        // подбор мяса касанием → +1 сытость. ПРИ ПОЛНОЙ (3) НЕ берём (не тратим).
        for (const m of meats) {
          if (m.eaten) continue;
          const mdx = m.group.position.x - player.position.x;
          const mdz = m.group.position.z - player.position.z;
          if (mdx * mdx + mdz * mdz < PICKUP_R * PICKUP_R && satietyVal < SATIETY_MAX) {
            m.eaten = true; scene.remove(m.group);
            satietyVal = Math.min(SATIETY_MAX, satietyVal + 1);
            hungerTimer = 0;          // поел — таймер до следующего минуса заново
            setSatiety(satietyVal);
          } else if (!m.eaten) {
            m.group.rotation.y += dt * 1.2; // лёгкое вращение, заметнее в темноте
          }
        }
        // сытость кончилась → смерть от голода
        if (satietyVal <= 0) {
          deadFlag = true; finished = true; setStarved(true);
        }
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

      // ── Паук(и): чувства по уровню; вне игры и на заставке скрыты ──
      const huntActive = startedRef.current && !introRef.current;
      for (const S of spiders) S.group.visible = huntActive;
      if (huntActive && !finished) {
        // обновляем след запаха игрока (нюх идёт по «старому» следу с лагом)
        scentTimer += dt;
        if (scentTimer > 0.25) {
          scentTimer = 0;
          scent.push({ x: player.position.x, z: player.position.z });
          if (scent.length > 8) scent.shift(); // ~2 с лага → петляя, сбиваешь след
        }
        // CLONE: периодически добавляется ещё паук (подальше от игрока)
        if (can.clone && !onlyMoveSpider && spiders.length < MAX_SPIDERS) {
          cloneCd -= dt;
          if (cloneCd <= 0) {
            cloneCd = 12;
            const far = reach.filter((c) => Math.hypot(c.x - player.position.x, c.z - player.position.z) > 16 * mapScale);
            const pick = far.length ? far[(spiders.length * 911) % far.length] : { x: minWX + SP_R + 1.2, z: 0 };
            spawnSpider(pick.x, pick.z, Math.PI / 2);
          }
        }
        // WEB: главный паук стреляет паутиной по прямой видимости (замедляет)
        webCd -= dt;
        if (can.web && webCd <= 0 && spiders.length) {
          const sp0 = spiders[0].group.position;
          const dx = player.position.x - sp0.x, dz = player.position.z - sp0.z;
          const d = Math.hypot(dx, dz);
          if (d < WEB_RANGE && d > 2 && hasLOS(sp0.x, sp0.z, player.position.x, player.position.z)) {
            webCd = 4.2;
            const trapDist = Math.max(2.4, d - 1.8);
            makeWeb(sp0.x + (dx / d) * trapDist, sp0.z + (dz / d) * trapDist);
          }
        }
        // затухание «слышу сирену»
        if (noiseAlert > 0) noiseAlert = Math.max(0, noiseAlert - dt);
        // Паутина-ловушка: наступил в зону → замедление + паук знает, где ты.
        if (webSlow > 0) webSlow = Math.max(0, webSlow - dt);
        for (let i = webs.length - 1; i >= 0; i--) {
          const w = webs[i];
          w.life -= dt;
          const hx = w.x - player.position.x, hz = w.z - player.position.z;
          const hitPlayer = hx * hx + hz * hz < (w.r + PLAYER_R * 0.4) * (w.r + PLAYER_R * 0.4);
          if (hitPlayer) {
            webSlow = 4.0;
            if (!w.triggered) {
              w.triggered = true;
              noiseAlert = NOISE_HEARD;
              noiseX = player.position.x;
              noiseZ = player.position.z;
              lastSeenX = player.position.x;
              lastSeenZ = player.position.z;
              hasLastSeen = true;
              for (const S of spiders) S.state = 'CHASE';
            }
          }
          const mat = w.mesh.material as THREE.MeshBasicMaterial;
          mat.opacity = w.triggered ? 0.58 : 0.34 + Math.sin(performance.now() * 0.006) * 0.08;
          if (w.life <= 0) { scene.remove(w.mesh); webs.splice(i, 1); }
        }
        if ((webSlow > 0) !== webbedShown) { webbedShown = webSlow > 0; setWebbed(webbedShown); }

        // ── Движение каждого паука: стейт-машина IDLE / CHASE / PATROL ──
        const probe = SP_R + 1.1;
        const free = (vx: number, vz: number) => clearAt(vx, vz) > SP_R;
        let packSensed = false;   // хоть один паук чувствует игрока (для Gemini-поиска)
        let anyPatrol = false;    // кто-то патрулирует (для индикатора Gemini)
        let nearestDist = Infinity; let nearestSp: SpiderInst | null = null; // ближайший паук (для метрик тактик)
        for (const S of spiders) {
          const sp = S.group.position;
          const dx = player.position.x - sp.x, dz = player.position.z - sp.z;
          const distP = Math.hypot(dx, dz);
          if (distP < nearestDist) { nearestDist = distP; nearestSp = S; }

          // ── ДЕТЕКЦИЯ игрока через чувства уровня (видит/слышит/нюхает) ──
          let sensed = false, senseH = 0;
          if (can.see && distP < SEE_RANGE && hasLOS(sp.x, sp.z, player.position.x, player.position.z)) {
            sensed = true; senseH = Math.atan2(dx, dz);                      // ВИДИТ
          } else if (can.hear && noiseAlert > 0) {
            sensed = true; senseH = Math.atan2(noiseX - sp.x, noiseZ - sp.z); // СЛЫШИТ сирену
          } else if (can.hear && moving && distP < HEAR_RANGE) {
            sensed = true; senseH = Math.atan2(dx, dz);                      // СЛЫШИТ шаги вблизи
          } else if (can.smell && distP < SMELL_RANGE && scent.length) {
            const sc = scent[0];
            if (hasLOS(sp.x, sp.z, sc.x, sc.z)) {
              sensed = true; senseH = Math.atan2(sc.x - sp.x, sc.z - sp.z); // НЮХ
            }
          }
          if (sensed) { packSensed = true; lastSeenX = player.position.x; lastSeenZ = player.position.z; hasLastSeen = true; }

          // ── ПЕРЕХОДЫ СОСТОЯНИЙ ──
          const chaseTrigger = sensed || distP < CHASE_RANGE; // почуял ИЛИ подошёл вплотную (засада)
          if (S.state !== 'CHASE' && chaseTrigger) {
            S.state = 'CHASE';
            // ===================== JUMPSCARE HOOK =====================
            // Момент броска из засады/патруля в погоню (… → CHASE).
            // СЮДА вставь воспроизведение своего звука скримера, напр.: playJumpscare();
            // Срабатывает ОДИН раз при входе в CHASE.
            // ==========================================================
          } else if (S.state === 'CHASE' && !sensed && distP > ESCAPE_RANGE) {
            S.state = 'PATROL';                          // игрок убежал далеко → патруль
            const wp = pickWaypoint(sp.x, sp.z, searchActive ? searchTarget : null);
            S.wpX = wp.x; S.wpZ = wp.z;
          } else if (S.state === 'IDLE') {
            S.idleT += dt;                               // засидевшись в засаде — идём патрулировать
            if (S.idleT > 4) { S.state = 'PATROL'; const wp = pickWaypoint(sp.x, sp.z, null); S.wpX = wp.x; S.wpZ = wp.z; }
          }
          if (S.state === 'PATROL') anyPatrol = true;

          // ── ЖЕЛАЕМЫЙ КУРС по состоянию ──
          let desiredH = S.heading, moveScale = 1, turnRate = TURN_PATROL;
          if (S.state === 'IDLE') {
            moveScale = 0;                               // засада: стоит неподвижно
            if (sensed) desiredH = senseH;              // но доворачивается к замеченной жертве
          } else if (S.state === 'CHASE') {
            desiredH = sensed ? senseH : Math.atan2(lastSeenX - sp.x, lastSeenZ - sp.z); // к игроку / последнему месту
            turnRate = TURN_CHASE;
          } else { // PATROL — плавно между путевыми точками
            if (Math.hypot(S.wpX - sp.x, S.wpZ - sp.z) < 3 * mapScale) {
              // дошёл: иногда замираем в засаде, иначе берём новую точку (плавный разворот)
              if (Math.random() < 0.3) { S.state = 'IDLE'; S.idleT = 0; }
              else { const wp = pickWaypoint(sp.x, sp.z, searchActive ? searchTarget : null); S.wpX = wp.x; S.wpZ = wp.z; }
            }
            desiredH = Math.atan2(S.wpX - sp.x, S.wpZ - sp.z);
          }

          // ── РУЛЁЖКА с обходом стен (без бесконечного кручения на месте) ──
          const fwd = new THREE.Vector3(Math.sin(S.heading), 0, Math.cos(S.heading));
          const frontFree = free(sp.x + fwd.x * probe, sp.z + fwd.z * probe);
          let goalH = desiredH;
          let wallMode = false;
          const wall = nearestWall(sp.x, sp.z, SP_R + 1.6);
          if (moveScale > 0 && !frontFree) {
            if (ENABLE_WALL_CLIMB && wall && !wall.outer) {
              goalH = desiredH;
              S.wallClimb = 1.0;
              S.wallNx = wall.nx;
              S.wallNz = wall.nz;
              wallMode = true;
            } else {
              const leftFree = free(sp.x + Math.sin(S.heading + 1.2) * probe, sp.z + Math.cos(S.heading + 1.2) * probe);
              const rightFree = free(sp.x + Math.sin(S.heading - 1.2) * probe, sp.z + Math.cos(S.heading - 1.2) * probe);
              if (leftFree && !rightFree) goalH = S.heading + 1.2;
              else if (rightFree && !leftFree) goalH = S.heading - 1.2;
              else if (leftFree && rightFree) goalH = wrapPi(desiredH - S.heading) > 0 ? S.heading + 1.2 : S.heading - 1.2;
              else goalH = S.heading + Math.PI;            // тупик → плавный разворот
            }
          } else if (ENABLE_WALL_CLIMB && S.wallClimb > 0 && wall && !wall.outer) {
            S.wallNx = wall.nx;
            S.wallNz = wall.nz;
            wallMode = true;
          }
          if (!wallMode) S.wallClimb = Math.max(0, S.wallClimb - dt * 2.5);
          S.heading += Math.max(-turnRate * dt, Math.min(turnRate * dt, wrapPi(goalH - S.heading)));

          // ── ДВИЖЕНИЕ (на резком довороте — медленнее: плавные дуги, без рывков) ──
          const aligned = Math.max(0, Math.cos(wrapPi(goalH - S.heading)));
          const baseSpeed = SPIDER_SPEED * (S.state === 'CHASE' ? CHASE_MULT : 1);
          const spd = dt * baseSpeed * moveScale * (S.state === 'CHASE' ? 1 : 0.35 + 0.65 * aligned);
          const before = sp.clone();
          if (spd > 0) {
            if (S.wallClimb > 0) {
              sp.x += Math.sin(S.heading) * spd;
              sp.z += Math.cos(S.heading) * spd;
            } else {
              sp.x += Math.sin(S.heading) * spd; sp.z += Math.cos(S.heading) * spd;
            }
            sp.x = Math.min(maxWX - 1, Math.max(minWX + 1, sp.x));
            sp.z = Math.min(maxWZ - 1, Math.max(minWZ + 1, sp.z));
            if (S.wallClimb <= 0) resolveCircle(sp, SP_R); // на полу тело не проходит сквозь стены
          }
          const moved = before.distanceTo(sp);
          S.dist += moved;

          // ── АНТИ-ЗАЛИПАНИЕ: хочет идти, но стоит → дёрнуть курс / сменить точку ──
          if (moveScale > 0) {
            if (moved < 0.01 * baseSpeed) S.stuck += dt; else S.stuck = Math.max(0, S.stuck - dt * 2);
            if (S.stuck > 0.8) {
              S.stuck = 0;
              S.heading += (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random());
              if (S.state === 'PATROL') { const wp = pickWaypoint(sp.x, sp.z, null); S.wpX = wp.x; S.wpZ = wp.z; }
            }
          }

          // ── ОРИЕНТАЦИЯ: живот по нормали поверхности, разворот вокруг неё ──
          orientSpider(S, Math.min(1, dt * 10));

          // ── ПОХОДКА (тетраподная) ──
          const gait = S.dist * 1.9;
          const wallPose = S.wallClimb > 0 ? Math.min(1, S.wallClimb / 0.35) : 0;
          for (const L of S.legs) {
            const { swing, lift } = spiderLegPose(gait + L.phase);
            if (wallPose > 0) {
              const wallFemur = -L.side * 0.22;
              const wallTibia = -L.side * (Math.PI - 0.18) - wallFemur;
              L.legG.position.set(
                THREE.MathUtils.lerp(L.rootX, L.side * S.touchR * 0.18, wallPose),
                L.rootY,
                L.rootZ,
              );
              L.legG.rotation.y = THREE.MathUtils.lerp(L.baseY + swing * 0.42, L.baseY * 0.42 + swing * 0.14, wallPose);
              L.fem.rotation.z = THREE.MathUtils.lerp(L.baseFemur + L.side * lift * 0.7, wallFemur, wallPose);
              L.tib.rotation.z = THREE.MathUtils.lerp(L.baseTibia + L.side * lift * 0.5, wallTibia, wallPose);
            } else {
              L.legG.position.set(L.rootX, L.rootY, L.rootZ);
              L.legG.rotation.y = L.baseY + swing * 0.42;
              L.fem.rotation.z = L.baseFemur + L.side * lift * 0.7;
              L.tib.rotation.z = L.baseTibia + L.side * lift * 0.5;
            }
          }
          S.wallDrop.visible = wallPose > 0;
          sp.y = (S.wallClimb > 0 ? WALL_H + S.bodyY : S.bodyY) + Math.abs(Math.sin(gait)) * S.touchR * 0.06;

          // ── КАСАНИЕ → смерть: тело паука ИЛИ реальный кончик лапы ──
          if (!finished) {
            const bodyR = S.touchR + PLAYER_R;
            let touched = dx * dx + dz * dz < bodyR * bodyR;
            if (!touched) {
              const footR = PLAYER_R + 0.5;
              for (const L of S.legs) {
                L.foot.getWorldPosition(tmpFoot);
                const fdx = tmpFoot.x - player.position.x, fdz = tmpFoot.z - player.position.z;
                if (fdx * fdx + fdz * fdz < footR * footR) { touched = true; break; }
              }
            }
            if (!touched && S.wallClimb > 0) {
              const hangX = sp.x - S.wallNx * (S.touchR * 0.55);
              const hangZ = sp.z - S.wallNz * (S.touchR * 0.55);
              const hdx = hangX - player.position.x, hdz = hangZ - player.position.z;
              const hangR = PLAYER_R + S.touchR * 0.65;
              touched = hdx * hdx + hdz * hdz < hangR * hangR;
            }
            if (touched) { deadFlag = true; finished = true; setDead(true); playScream(); }
          }
        }

        // ── МЕТРИКИ ТАКТИКИ ИГРОКА (для адаптивной контр-способности на след. уровне) ──
        const tr = tacticRef.current;
        if (!moving) {
          tr.still += dt;                                  // стоит/крадётся (избегает слуха)
        } else {
          const losN = nearestSp
            ? hasLOS(nearestSp.group.position.x, nearestSp.group.position.z, player.position.x, player.position.z)
            : false;
          if (nearestDist < SEE_RANGE && losN) tr.open += dt; // бегает на виду
          else tr.hide += dt;                                 // двигается, но прячется за стенами
          if (nearestDist > ESCAPE_RANGE * 0.75) tr.flee += dt; // держит большую дистанцию / убегает
          if ((prevMx || prevMz) && (mx * prevMx + mz * prevMz) < -0.3) tr.loop += dt * 3; // развернулся → петляет
          prevMx = mx; prevMz = mz;
        }

        // ── Gemini выбирает КУДА патрулировать (когда не чувствует игрока) ──
        // Раз в несколько секунд просим у нейронки курс — он влияет на выбор
        // следующей путевой точки патруля (см. pickWaypoint(..., searchTarget)).
        brainTimer += dt;
        if (!packSensed && anyPatrol && brainTimer >= brainNext && !brainBusy && spiders.length) {
          brainTimer = 0;
          askSearch(spiders[0].group.position.x, spiders[0].group.position.z);
        }
        const searching = !packSensed && anyPatrol && searchActive && geminiOnline; // Gemini направляет патруль
        if (searching !== geminiShown) { geminiShown = searching; setGeminiSearch(searching); }
      }

      if (mapView) {
        // ── Режим карты: вся темнота убрана, видно карту целиком ──
        if (camera.fov !== 55) { camera.fov = 55; camera.updateProjectionMatrix(); }
        player.visible = false;
        for (const S of spiders) S.group.visible = false;
        ambient.intensity = 1.4;
        lantern.distance = 200;
        glow.distance = 200;
        lantern.position.set(player.position.x, 30, player.position.z);
        glow.position.set(player.position.x, 30, player.position.z);
        zoneMarks.forEach((m) => (m.visible = false));
        // Камера высоко над центром: высота считается так, чтобы вся карта влезала на любом уровне.
        const mapCenterX = (bxMin + bxMax) / 2;
        const mapCenterZ = (bzMin + bzMax) / 2;
        const mapW = bxMax - bxMin + 16 * mapScale;
        const mapH = bzMax - bzMin + 16 * mapScale;
        const fov = THREE.MathUtils.degToRad(camera.fov);
        const fitByHeight = mapH / (2 * Math.tan(fov / 2));
        const fitByWidth = mapW / (2 * Math.tan(fov / 2) * camera.aspect);
        const mapViewY = Math.max(fitByHeight, fitByWidth, 52) + 8 * mapScale;
        camera.position.set(mapCenterX, mapViewY, mapCenterZ + 0.001);
        camera.lookAt(mapCenterX, 0, mapCenterZ);
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

        if (firstPersonRef.current) {
          if (camera.fov !== 72) { camera.fov = 72; camera.updateProjectionMatrix(); }
          // ── От первого лица: камера в «глазах», смотрит по направлению взгляда ──
          player.visible = false; // своё тело не загораживает обзор
          const eyeH = 2.85;
          const fx = Math.sin(faceAngle), fz = Math.cos(faceAngle);
          camera.position.set(player.position.x + fx * 0.22, eyeH, player.position.z + fz * 0.22);
          camera.lookAt(player.position.x + fx * 14, eyeH - 0.08, player.position.z + fz * 14);
        } else {
          if (camera.fov !== 55) { camera.fov = 55; camera.updateProjectionMatrix(); }
          // ── От третьего лица: камера сверху, под небольшим углом ──
          player.visible = true;
          camera.position.set(player.position.x, 22, player.position.z + 11);
          camera.lookAt(player.position.x, 0, player.position.z);
        }
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
      switchFnRef.current = undefined;
      mobileInputRef.current = { mx: 0, mz: 0 };
      setStick({ x: 0, y: 0, active: false });
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      renderer.domElement.removeEventListener('click', onCanvasClick);
      window.removeEventListener('resize', onResize);
      envRT.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [runId, level]);

  const touchButtonStyle = {
    width: 64,
    height: 64,
    borderRadius: '50%',
    border: '1px solid rgba(255,255,255,0.35)',
    background: 'rgba(8,12,16,0.72)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 'bold',
    fontFamily: 'monospace',
    boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
    touchAction: 'none',
    userSelect: 'none',
  } as const;

  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', overflow: 'hidden', background: '#05070a', touchAction: 'none' }}>
      {/* Живая 3D-сцена игры — рендерится всегда; на меню служит фоном */}
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />

      {/* «Лифтовая» музыка меню (зациклена) */}
      <audio ref={audioRef} src="/menu-music.mp3" loop preload="auto" />

      {finalEnding && (
        <div
          style={{
            position: 'absolute', inset: 0, zIndex: 80,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#000', color: '#fff', fontFamily: 'monospace',
            fontSize: 'min(14vw, 120px)', fontWeight: 'bold', letterSpacing: 8,
          }}
        >
          КОНЕЦ
        </div>
      )}


      {/* HUD — только в игре */}
      {started && !finalEnding && (
        <>
          {/* Кнопка вида: от 1-го ↔ от 3-го лица (та же кнопка возвращает обратно) */}
          <button
            onClick={() => setFirstPerson((v) => !v)}
            style={{
              position: 'absolute', top: 12, right: 12,
              padding: '10px 16px', fontSize: 15, fontWeight: 'bold', fontFamily: 'monospace',
              background: firstPerson ? '#2bd24f' : 'rgba(255,255,255,0.14)',
              color: firstPerson ? '#05140a' : '#fff',
              border: '1px solid rgba(255,255,255,0.35)', borderRadius: 10, cursor: 'pointer',
            }}
          >
            {firstPerson ? '👁 1-е лицо' : '🎥 3-е лицо'}
          </button>

          {/* Счётчики — левый верхний угол: уровень, батарейки, переключатели */}
          <div
            style={{
              position: 'absolute', top: 12, left: 12,
              fontSize: 30, fontWeight: 'bold',
              fontFamily: 'monospace', textShadow: '0 0 8px #000, 0 0 4px #000',
              pointerEvents: 'none', display: 'flex', gap: 18, alignItems: 'center',
            }}
          >
            <span style={{ color: '#9fd0ff' }}>УР {level}/{LEVELS}</span>
            <span style={{ color: '#33ff66' }}>🔋 {collected}/{batteryCount}</span>
            {switchCount > 0 && (
              <span style={{ color: switchesOn >= switchCount ? '#33ff66' : '#ff5a3c' }}>
                🚨 {switchesOn}/{switchCount}
              </span>
            )}
            {spiderAbil.some((a) => a.en === 'STARVE YOU') && (
              <span style={{ color: satiety <= 1 ? '#ff5a3c' : '#ffb44a' }} title="Сытость (ешь мясо!)">
                {'🍖'.repeat(Math.max(0, satiety))}{satiety <= 0 ? '☠' : ''}
              </span>
            )}
          </div>

          {/* Способности паука на этом уровне */}
          {spiderAbil.length > 0 && (
            <div
              style={{
                position: 'absolute', top: 52, left: 12, fontSize: 14, fontWeight: 'bold',
                fontFamily: 'monospace', textShadow: '0 0 8px #000', pointerEvents: 'none',
                color: '#ff6a55',
              }}
            >
              🕷 SPAID CAN: {spiderAbil.map((a) => a.en).join(', ')}
            </div>
          )}

          {/* Gemini ведёт паука в фазе поиска (когда он тебя не чувствует) */}
          {geminiSearch && (
            <div
              style={{
                position: 'absolute', top: 72, left: 12, fontSize: 13, fontWeight: 'bold',
                fontFamily: 'monospace', textShadow: '0 0 8px #000', pointerEvents: 'none',
                color: '#c8a8ff',
              }}
            >
              🧠 паук ищет тебя (Gemini)
            </div>
          )}

          {/* Опутан паутиной — игрок замедлен */}
          {webbed && (
            <div
              style={{
                position: 'absolute', inset: 0, pointerEvents: 'none',
                boxShadow: 'inset 0 0 160px 40px rgba(245,245,245,0.35)',
                border: '6px solid rgba(255,255,255,0.25)',
              }}
            >
              <div
                style={{
                  position: 'absolute', bottom: '14%', left: 0, right: 0, textAlign: 'center',
                  color: '#fff', fontFamily: 'monospace', fontSize: 22, fontWeight: 'bold',
                  textShadow: '0 0 10px #000',
                }}
              >
                🕸 ОПУТАН ПАУТИНОЙ — ты замедлен!
              </div>
            </div>
          )}

          {/* Все батарейки доставлены, но не все переключатели дёрнуты — напоминание */}
          {switchCount > 0 && collected >= batteryCount && switchesOn < switchCount && (
            <div
              style={{
                position: 'absolute', top: 60, left: 12,
                color: '#ff5a3c', fontSize: 16, fontWeight: 'bold', fontFamily: 'monospace',
                textShadow: '0 0 8px #000', pointerEvents: 'none',
              }}
            >
              Дёрни все переключатели (E), чтобы пройти уровень!
            </div>
          )}

          {showTouchControls && !showIntro && !paused && !dead && !starved && !won && !levelCleared && (
            <>
              <div
                ref={joystickRef}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  updateJoystick(e.clientX, e.clientY);
                }}
                onPointerMove={(e) => updateJoystick(e.clientX, e.clientY)}
                onPointerUp={clearJoystick}
                onPointerCancel={clearJoystick}
                style={{
                  position: 'absolute',
                  left: 22,
                  bottom: 24,
                  width: 142,
                  height: 142,
                  borderRadius: '50%',
                  border: '1px solid rgba(255,255,255,0.28)',
                  background: 'rgba(8,12,16,0.42)',
                  boxShadow: '0 10px 34px rgba(0,0,0,0.42), inset 0 0 22px rgba(255,255,255,0.05)',
                  touchAction: 'none',
                  userSelect: 'none',
                  zIndex: 45,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: 64,
                    height: 64,
                    marginLeft: -32,
                    marginTop: -32,
                    borderRadius: '50%',
                    border: '1px solid rgba(255,255,255,0.42)',
                    background: stick.active ? 'rgba(43,210,79,0.78)' : 'rgba(255,255,255,0.2)',
                    transform: `translate(${stick.x}px, ${stick.y}px)`,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.55)',
                  }}
                />
              </div>

              <div
                style={{
                  position: 'absolute',
                  right: 18,
                  bottom: 24,
                  display: 'grid',
                  gridTemplateColumns: '64px 64px',
                  gap: 12,
                  zIndex: 45,
                }}
              >
                <button
                  onPointerDown={(e) => { e.preventDefault(); dropFnRef.current?.(); }}
                  style={touchButtonStyle}
                >
                  DROP
                </button>
                <button
                  onPointerDown={(e) => { e.preventDefault(); switchFnRef.current?.(); }}
                  style={{ ...touchButtonStyle, background: 'rgba(255,138,42,0.72)', color: '#120806' }}
                >
                  ACT
                </button>
                <button
                  onPointerDown={(e) => { e.preventDefault(); setFirstPerson((v) => !v); }}
                  style={touchButtonStyle}
                >
                  VIEW
                </button>
                <button
                  onPointerDown={(e) => {
                    e.preventDefault();
                    if (!pausedRef.current) pause();
                    else resume();
                  }}
                  style={touchButtonStyle}
                >
                  PAUSE
                </button>
              </div>
            </>
          )}

          {/* Подсказка управления — левый нижний угол */}
          {!showTouchControls && (
            <div
              style={{
                position: 'absolute', bottom: 12, left: 12,
                background: 'rgba(0,0,0,0.6)', color: '#fff',
                padding: '8px 12px', borderRadius: 8, fontSize: 13,
                pointerEvents: 'none', lineHeight: 1.5,
              }}
            >
              <b>WASD</b> / стрелки — движение · <b>M</b> — вся карта · <b>Q</b> — выбросить{switchCount > 0 ? ' · ' : ''}{switchCount > 0 ? <b>E</b> : ''}{switchCount > 0 ? ' — переключатель' : ''} · <b>Esc</b> — пауза<br />
              Подбери батарейку (подойди к ней) и отнеси к красному генератору{switchCount > 0 ? ', затем дёрни переключатели' : ''}
            </div>
          )}
        </>
      )}

      {/* Скример: морда паука влетает на весь экран, тряска, вспышки → потом меню */}
      {dead && (
        <>
          <style>{`
            @keyframes scr-zoom {
              0%   { transform: scale(0.05) rotate(-8deg); opacity: 0; }
              12%  { transform: scale(1.2) rotate(3deg); opacity: 1; }
              100% { transform: scale(2.9) rotate(-2deg); opacity: 1; }
            }
            @keyframes scr-shake {
              0%,100% { transform: translate(0,0); }
              20% { transform: translate(-18px, 12px); }
              40% { transform: translate(16px, -14px); }
              60% { transform: translate(-14px, -10px); }
              80% { transform: translate(12px, 14px); }
            }
            @keyframes scr-flash {
              0%,100% { background: #000; }
              50% { background: #5e0000; }
            }
          `}</style>
          <div
            style={{
              position: 'absolute', inset: 0, zIndex: 50, overflow: 'hidden',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              animation: 'scr-flash 0.12s steps(1) infinite',
            }}
          >
            {/* тряска-обёртка */}
            <div style={{ position: 'absolute', inset: '-10%', animation: 'scr-shake 0.09s infinite' }}>
              <img
                src="/spider-face.jpg"
                alt=""
                style={{
                  position: 'absolute', top: '50%', left: '50%', marginLeft: '-35vmin', marginTop: '-35vmin',
                  width: '70vmin', height: '70vmin', objectFit: 'cover', borderRadius: '50%',
                  // окрас «в красное» как у паука + жуткое свечение
                  filter: 'grayscale(1) sepia(1) saturate(7) hue-rotate(-35deg) brightness(1.05) contrast(1.2)',
                  boxShadow: '0 0 120px 40px rgba(190,20,10,0.85)',
                  transformOrigin: 'center',
                  animation: 'scr-zoom 1.1s ease-in forwards',
                }}
              />
            </div>
          </div>
        </>
      )}

      {/* Смерть от голода */}
      {starved && (
        <div
          style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 16, zIndex: 30,
            background: 'rgba(10,4,2,0.92)', color: '#fff', fontFamily: 'monospace',
          }}
        >
          <div style={{ fontSize: 'min(18vw, 120px)' }}>🍖☠</div>
          <div style={{ fontSize: 'min(8vw, 56px)', fontWeight: 'bold', letterSpacing: 3, color: '#ff7a4a', textShadow: '0 0 20px #5a0f10' }}>
            ВЫ УМЕРЛИ ОТ ГОЛОДА
          </div>
          <div style={{ fontSize: 16, opacity: 0.8 }}>надо было есть мясо…</div>
        </div>
      )}

      {/* Заставка перед уровнем: «SPAID CAN …» — что умеет паук на этом уровне */}
      {started && showIntro && !dead && !won && !exited && (
        <div
          style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'flex-start', justifyContent: 'center', gap: 22, zIndex: 20,
            paddingLeft: 'min(9vw, 120px)',
            background: 'rgba(4,2,3,0.88)', color: '#fff', fontFamily: 'monospace',
          }}
        >
          <div style={{ fontSize: 14, letterSpacing: 4, color: '#9fd0ff' }}>
            УРОВЕНЬ {level} / {LEVELS}
          </div>
          <div
            style={{
              fontSize: 'min(6.2vw, 52px)', fontWeight: 'bold', letterSpacing: 2, textAlign: 'left',
              padding: '0 16px 0 0', textShadow: '0 0 24px #ff2a1a, 0 0 48px #7a0000',
            }}
          >
            SPAID CAN
          </div>
          <div style={{ width: 'min(78vw, 640px)', display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-start', gap: 10 }}>
            {spiderAbil.map((a) => (
              <div
                key={a.en}
                style={{
                  padding: '8px 12px',
                  border: '1px solid rgba(255,106,85,0.45)',
                  color: '#ff6a55',
                  fontSize: 'min(2.6vw, 13px)',
                  fontWeight: 'bold',
                  letterSpacing: 1,
                  background: 'rgba(255,42,26,0.08)',
                }}
              >
                {a.en}
              </div>
            ))}
          </div>
          <button
            onClick={() => setShowIntro(false)}
            style={{
              alignSelf: 'center',
              marginTop: 6, padding: '16px 44px', fontSize: 22, fontWeight: 'bold', fontFamily: 'monospace',
              background: '#c0160c', color: '#fff', border: 'none', borderRadius: 12, cursor: 'pointer',
              boxShadow: '0 4px 18px rgba(0,0,0,0.6)',
            }}
          >
            ▶ В лабиринт
          </button>
        </div>
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

      {/* Уровень пройден — переход на следующий уровень */}
      {levelCleared && !won && (
        <div
          style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', gap: 26,
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.7)', color: '#fff', fontFamily: 'monospace',
          }}
        >
          <div
            style={{
              fontSize: 'min(11vw, 110px)', fontWeight: 'bold', letterSpacing: 4,
              textShadow: '0 0 24px #33ff66, 0 0 48px #33ff66', textAlign: 'center',
            }}
          >
            УРОВЕНЬ {level}<br />ПРОЙДЕН
          </div>
          <button
            onClick={nextLevel}
            style={{
              padding: '16px 40px', fontSize: 22, fontWeight: 'bold',
              fontFamily: 'monospace', background: '#2bd24f', color: '#05140a',
              border: 'none', borderRadius: 12, cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            }}
          >
            ▶ Уровень {Math.min(LEVELS, level + 1)}
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
            onClick={() => { setShowIntro(true); setStarted(true); }}
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
            onClick={() => setShowSettings(true)}
            style={{
              position: 'absolute', top: 'calc(50% + 58px)', left: '8%',
              padding: '14px 36px', fontSize: 18, fontWeight: 'bold', fontFamily: 'monospace',
              background: 'rgba(255,255,255,0.12)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.35)', borderRadius: 12, cursor: 'pointer',
            }}
          >
            ⚙ Настройки
          </button>

          {/* Панель настроек — громкость музыки */}
          {showSettings && (
            <div
              onClick={() => setShowSettings(false)}
              style={{
                position: 'absolute', inset: 0, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.6)', zIndex: 10,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: 'min(90vw, 420px)', padding: '28px 32px',
                  background: '#0d1119', color: '#fff', fontFamily: 'monospace',
                  border: '1px solid rgba(255,255,255,0.25)', borderRadius: 16,
                  boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
                  display: 'flex', flexDirection: 'column', gap: 22,
                }}
              >
                <div style={{ fontSize: 26, fontWeight: 'bold', letterSpacing: 3 }}>⚙ Настройки</div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16 }}>
                    <span>🎵 Громкость музыки</span>
                    <span style={{ color: '#33ff66', fontWeight: 'bold' }}>{Math.round(volume * 100)}%</span>
                  </div>
                  <input
                    type="range" min={0} max={1} step={0.01} value={volume}
                    onChange={(e) => { setVolume(parseFloat(e.target.value)); if (muted) setMuted(false); }}
                    style={{ width: '100%', accentColor: '#2bd24f', cursor: 'pointer' }}
                  />
                  <button
                    onClick={() => setMuted((m) => !m)}
                    style={{
                      alignSelf: 'flex-start', marginTop: 4, padding: '8px 16px', fontSize: 14,
                      fontFamily: 'monospace', fontWeight: 'bold',
                      background: muted ? '#c0392b' : 'rgba(255,255,255,0.14)', color: '#fff',
                      border: '1px solid rgba(255,255,255,0.3)', borderRadius: 10, cursor: 'pointer',
                    }}
                  >
                    {muted ? '🔇 Музыка выключена' : '🔊 Музыка включена'}
                  </button>
                </div>

                <button
                  onClick={() => setShowSettings(false)}
                  style={{
                    padding: '12px 0', fontSize: 18, fontWeight: 'bold', fontFamily: 'monospace',
                    background: '#2bd24f', color: '#05140a', border: 'none', borderRadius: 12, cursor: 'pointer',
                  }}
                >
                  Готово
                </button>
              </div>
            </div>
          )}

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

          {/* Описание игры — под картинкой справа */}
          <div
            style={{
              position: 'absolute', top: 'calc(50% + min(9.5vw, 120px))', right: '6%',
              transform: 'translateX(50%)',
              width: 'min(34vw, 340px)', textAlign: 'center',
              fontSize: 'min(1.6vw, 15px)', lineHeight: 1.5, color: '#d8dde3',
              textShadow: '0 0 8px #000', pointerEvents: 'none',
            }}
          >
            <div style={{ color: '#ff5a47', fontWeight: 'bold', marginBottom: 6, letterSpacing: 1 }}>
              🕷 Хоррор-лабиринт
            </div>
            Вы заперты в тёмном железном лабиринте, по которому бродит
            гигантский паук-охотник. Соберите все&nbsp;
            <span style={{ color: '#2bff55' }}>батарейки</span>
            &nbsp;и отнесите их к&nbsp;
            <span style={{ color: '#ff5a47' }}>красному генератору</span>, нажмите все&nbsp;
            <span style={{ color: '#ff8a2a' }}>кнопки-переключатели</span>
            &nbsp;на стенах (клавиша&nbsp;E) — и пройдите все {LEVELS}&nbsp;уровней.
            Не попадитесь пауку: одно касание&nbsp;— и&nbsp;конец.
          </div>
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
