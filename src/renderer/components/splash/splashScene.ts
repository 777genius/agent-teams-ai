export interface SplashSceneHandle {
  stop: () => void;
}

export interface SplashSceneOptions {
  reducedMotion?: boolean;
}

declare global {
  interface Window {
    __claudeTeamsSplashEnhancedStartedAt?: number;
    __claudeTeamsSplashScene?: SplashSceneHandle;
  }
}

interface Point {
  x: number;
  y: number;
}

interface RobotNode extends Point {
  teamIndex: number;
  robotIndex: number;
  color: string;
  size: number;
  bob: number;
}

interface TeamNode {
  index: number;
  center: Point;
  color: string;
  radius: number;
  robots: RobotNode[];
}

interface DepthParticle {
  x: number;
  y: number;
  size: number;
  speed: number;
  phase: number;
  alpha: number;
}

interface Palette {
  isLight: boolean;
  centerGlow: string;
  teamColors: string[];
  teamLineAlpha: number;
  robotBody: string;
  robotShade: string;
  robotEye: string;
  messageAccent: string;
  particle: string;
}

const TAU = Math.PI * 2;
const TEAM_MEMBER_COUNTS = [4, 3, 5] as const;
const MAX_DPR = 2;

export function startSplashScene(
  splash: HTMLElement,
  options: SplashSceneOptions = {}
): SplashSceneHandle {
  const existingScene = window.__claudeTeamsSplashScene;
  if (existingScene && splash.querySelector('#splash-enhanced-canvas')) {
    return existingScene;
  }

  const previousCanvas = splash.querySelector<HTMLCanvasElement>('#splash-enhanced-canvas');
  previousCanvas?.remove();

  const canvas = document.createElement('canvas');
  canvas.id = 'splash-enhanced-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  splash.appendChild(canvas);

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) {
    const emptyHandle = {
      stop: () => {
        canvas.remove();
      },
    };
    return emptyHandle;
  }

  const reducedMotion =
    options.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = {
    width: 1,
    height: 1,
    dpr: 1,
    particles: [] as DepthParticle[],
    running: true,
    frameId: 0,
    startedAt: performance.now(),
  };

  const resize = (): void => {
    const rect = splash.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);

    if (state.width === width && state.height === height && state.dpr === dpr) {
      return;
    }

    state.width = width;
    state.height = height;
    state.dpr = dpr;
    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.particles = createDepthParticles(width, height);
  };

  const render = (now: number): void => {
    if (!state.running) return;

    resize();
    const time = (now - state.startedAt) / 1000;
    drawScene(ctx, state.width, state.height, time, state.particles, reducedMotion);

    if (!reducedMotion) {
      state.frameId = window.requestAnimationFrame(render);
    }
  };

  const onResize = (): void => resize();
  window.addEventListener('resize', onResize);
  resize();
  render(performance.now());

  const handle: SplashSceneHandle = {
    stop: () => {
      state.running = false;
      window.cancelAnimationFrame(state.frameId);
      window.removeEventListener('resize', onResize);
      canvas.remove();
      if (window.__claudeTeamsSplashScene === handle) {
        window.__claudeTeamsSplashScene = undefined;
        window.__claudeTeamsSplashEnhancedStartedAt = undefined;
      }
    },
  };
  window.__claudeTeamsSplashScene = handle;
  window.__claudeTeamsSplashEnhancedStartedAt = performance.now();

  return handle;
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  particles: DepthParticle[],
  reducedMotion: boolean
): void {
  ctx.clearRect(0, 0, width, height);
  const palette = resolvePalette();
  const mobile = width < 560 || height < 620;
  const sceneTime = reducedMotion ? 1.2 : time;
  const teams = buildTeams(width, height, sceneTime, mobile, palette);
  const center = getCenter(width, height, mobile);

  drawAmbientField(ctx, width, height, sceneTime, particles, palette, mobile);
  drawCenterAura(ctx, center, sceneTime, palette, mobile);
  drawCrossTeamGuides(ctx, teams, center, sceneTime, palette, mobile);

  for (const team of teams) {
    drawTeamHalo(ctx, team, sceneTime, palette);
  }

  drawMessages(ctx, teams, center, sceneTime, palette, mobile);

  for (const team of teams) {
    drawTeamLinks(ctx, team, palette);
  }

  for (const team of teams) {
    for (const robot of team.robots) {
      drawRobot(ctx, robot, sceneTime, palette);
    }
  }

  clearCentralContentReserve(ctx, center, mobile);
}

function resolvePalette(): Palette {
  const isLight = document.documentElement.classList.contains('light');
  return isLight
    ? {
        isLight,
        centerGlow: '#4f46e5',
        teamColors: ['#0284c7', '#059669', '#d97706'],
        teamLineAlpha: 0.34,
        robotBody: '#eef2ff',
        robotShade: '#c7d2fe',
        robotEye: '#ffffff',
        messageAccent: '#db2777',
        particle: '#312e81',
      }
    : {
        isLight,
        centerGlow: '#818cf8',
        teamColors: ['#38bdf8', '#34d399', '#f59e0b'],
        teamLineAlpha: 0.42,
        robotBody: '#111827',
        robotShade: '#27324a',
        robotEye: '#e0f2fe',
        messageAccent: '#f472b6',
        particle: '#c4b5fd',
      };
}

function getCenter(width: number, height: number, mobile: boolean): Point {
  return {
    x: width / 2,
    y: height * (mobile ? 0.47 : 0.49),
  };
}

function buildTeams(
  width: number,
  height: number,
  time: number,
  mobile: boolean,
  palette: Palette
): TeamNode[] {
  const center = getCenter(width, height, mobile);
  const spreadX = mobile ? Math.min(width * 0.3, 126) : Math.min(width * 0.26, 320);
  const spreadY = mobile ? Math.min(height * 0.17, 132) : Math.min(height * 0.19, 190);
  const teamRadius = mobile
    ? clamp(Math.min(width, height) * 0.09, 30, 40)
    : clamp(Math.min(width, height) * 0.075, 44, 62);
  const robotSize = mobile ? 11 : 14;
  const centers: Point[] = [
    {
      x: center.x - spreadX,
      y: center.y - spreadY * (mobile ? 0.6 : 0.45),
    },
    {
      x: center.x + spreadX,
      y: center.y - spreadY * (mobile ? 0.6 : 0.45),
    },
    {
      x: center.x,
      y: center.y + spreadY * (mobile ? 1.22 : 0.95),
    },
  ];

  return centers.map((teamCenter, teamIndex) => {
    const drift = Math.sin(time * 0.75 + teamIndex * 1.7) * (mobile ? 3 : 6);
    const centerWithDrift = {
      x: teamCenter.x + Math.cos(teamIndex * 2.1 + time * 0.35) * (mobile ? 2 : 4),
      y: teamCenter.y + drift,
    };
    const color = palette.teamColors[teamIndex % palette.teamColors.length] ?? palette.centerGlow;
    const memberCount = TEAM_MEMBER_COUNTS[teamIndex] ?? 3;
    const robots = Array.from({ length: memberCount }, (_, robotIndex) => {
      const baseAngle =
        -Math.PI / 2 + robotIndex * (TAU / memberCount) + (teamIndex === 2 ? TAU / 20 : 0);
      const orbit = baseAngle + Math.sin(time * 0.55 + teamIndex + robotIndex) * 0.1;
      const orbitRadius =
        teamRadius * (0.88 + (memberCount > 4 ? 0.08 : 0) + 0.05 * Math.sin(time + robotIndex));
      return {
        teamIndex,
        robotIndex,
        color,
        size: memberCount > 4 ? robotSize * 0.88 : robotSize,
        bob: Math.sin(time * 2.2 + teamIndex * 0.8 + robotIndex * 1.1),
        x: centerWithDrift.x + Math.cos(orbit) * orbitRadius,
        y: centerWithDrift.y + Math.sin(orbit) * orbitRadius,
      };
    });

    return {
      index: teamIndex,
      center: centerWithDrift,
      color,
      radius: teamRadius,
      robots,
    };
  });
}

function drawAmbientField(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  particles: DepthParticle[],
  palette: Palette,
  mobile: boolean
): void {
  const visibleParticles = mobile ? Math.floor(particles.length * 0.6) : particles.length;
  for (let i = 0; i < visibleParticles; i++) {
    const particle = particles[i];
    if (!particle) continue;
    const y = (particle.y + time * particle.speed) % (height + 24);
    const x = particle.x + Math.sin(time * 0.45 + particle.phase) * 8;
    const pulse = 0.78 + Math.sin(time * 1.8 + particle.phase) * 0.22;
    ctx.beginPath();
    ctx.fillStyle = withAlpha(palette.particle, particle.alpha * pulse);
    ctx.arc(x, y - 12, particle.size, 0, TAU);
    ctx.fill();
  }
}

function drawCenterAura(
  ctx: CanvasRenderingContext2D,
  center: Point,
  time: number,
  palette: Palette,
  mobile: boolean
): void {
  const radius = mobile ? 86 : 128;
  const glow = ctx.createRadialGradient(center.x, center.y, 20, center.x, center.y, radius);
  glow.addColorStop(0, withAlpha(palette.centerGlow, palette.isLight ? 0.13 : 0.2));
  glow.addColorStop(0.48, withAlpha(palette.messageAccent, palette.isLight ? 0.07 : 0.11));
  glow.addColorStop(1, withAlpha(palette.centerGlow, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, TAU);
  ctx.fill();

  for (let i = 0; i < 3; i++) {
    const ringRadius = radius * (0.42 + i * 0.18) + Math.sin(time * 1.1 + i) * 3;
    ctx.beginPath();
    ctx.strokeStyle = withAlpha(palette.centerGlow, 0.1 - i * 0.018);
    ctx.lineWidth = 1;
    ctx.setLineDash([8 + i * 2, 12 + i * 3]);
    ctx.lineDashOffset = -time * (18 + i * 8);
    ctx.arc(center.x, center.y, ringRadius, 0, TAU);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawCrossTeamGuides(
  ctx: CanvasRenderingContext2D,
  teams: TeamNode[],
  center: Point,
  time: number,
  palette: Palette,
  mobile: boolean
): void {
  for (let i = 0; i < teams.length; i++) {
    const from = teams[i];
    const to = teams[(i + 1) % teams.length];
    if (!from || !to) continue;
    const anchor = getCrossTeamAnchor(center, i, mobile);
    const cp1 = mix(from.center, anchor, 0.62);
    const cp2 = mix(to.center, anchor, 0.62);
    ctx.beginPath();
    ctx.moveTo(from.center.x, from.center.y);
    ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, to.center.x, to.center.y);
    ctx.strokeStyle = withAlpha(palette.messageAccent, palette.isLight ? 0.16 : 0.2);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 13]);
    ctx.lineDashOffset = -time * 28;
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawTeamHalo(
  ctx: CanvasRenderingContext2D,
  team: TeamNode,
  time: number,
  palette: Palette
): void {
  const pulse = 1 + Math.sin(time * 1.8 + team.index) * 0.035;
  const radiusX = team.radius * 1.56 * pulse;
  const radiusY = team.radius * 1.14 * pulse;
  const glow = ctx.createRadialGradient(
    team.center.x,
    team.center.y,
    team.radius * 0.35,
    team.center.x,
    team.center.y,
    team.radius * 2
  );
  glow.addColorStop(0, withAlpha(team.color, palette.isLight ? 0.08 : 0.12));
  glow.addColorStop(1, withAlpha(team.color, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(team.center.x, team.center.y, team.radius * 2, team.radius * 1.56, 0, 0, TAU);
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(team.center.x, team.center.y, radiusX, radiusY, time * 0.08, 0, TAU);
  ctx.strokeStyle = withAlpha(team.color, palette.isLight ? 0.28 : 0.34);
  ctx.lineWidth = 1.25;
  ctx.setLineDash([10, 8]);
  ctx.lineDashOffset = -time * (22 + team.index * 4);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawTeamLinks(ctx: CanvasRenderingContext2D, team: TeamNode, palette: Palette): void {
  const pairs = getTeamConnectionPairs(team.robots.length);

  for (const [fromIndex, toIndex] of pairs) {
    const from = team.robots[fromIndex];
    const to = team.robots[toIndex];
    if (!from || !to) continue;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = withAlpha(team.color, palette.teamLineAlpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawMessages(
  ctx: CanvasRenderingContext2D,
  teams: TeamNode[],
  center: Point,
  time: number,
  palette: Palette,
  mobile: boolean
): void {
  for (const team of teams) {
    drawLocalMessages(ctx, team, time, palette, mobile);
  }
  drawCrossTeamMessages(ctx, teams, center, time, palette, mobile);
}

function drawLocalMessages(
  ctx: CanvasRenderingContext2D,
  team: TeamNode,
  time: number,
  palette: Palette,
  mobile: boolean
): void {
  const pairs = getLocalMessagePairs(team.index, team.robots.length);
  const activeWindow = 0.76;
  const period = 2.15 + team.index * 0.12;

  for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
    const [fromIndex, toIndex] = pairs[pairIndex] ?? [0, 1];
    const from = team.robots[fromIndex];
    const to = team.robots[toIndex];
    if (!from || !to) continue;
    const raw = positiveModulo(time + team.index * 0.7 + pairIndex * 0.36, period) / period;
    if (raw > activeWindow) continue;
    const progress = easeInOutCubic(raw / activeWindow);
    const curve = makeLocalCurve(from, to, team.center, team.radius * 0.42);
    drawMessageFlight(ctx, curve, progress, team.color, time, mobile ? 5.5 : 7, palette);
  }
}

function drawCrossTeamMessages(
  ctx: CanvasRenderingContext2D,
  teams: TeamNode[],
  center: Point,
  time: number,
  palette: Palette,
  mobile: boolean
): void {
  const activeWindow = 0.64;
  const period = 4.25;
  const routes = [
    { fromTeam: 0, fromRobot: 3, toTeam: 1, toRobot: 1, delay: 0, anchor: 0 },
    { fromTeam: 2, fromRobot: 4, toTeam: 0, toRobot: 1, delay: 0.82, anchor: 2 },
    { fromTeam: 1, fromRobot: 2, toTeam: 2, toRobot: 0, delay: 1.68, anchor: 1, accent: true },
    { fromTeam: 0, fromRobot: 0, toTeam: 2, toRobot: 3, delay: 2.54, anchor: 2 },
  ];

  for (const route of routes) {
    const fromTeam = teams[route.fromTeam];
    const toTeam = teams[route.toTeam];
    if (!fromTeam || !toTeam) continue;
    const raw = positiveModulo(time + route.delay, period) / period;
    if (raw > activeWindow) continue;

    const from = fromTeam.robots[route.fromRobot % fromTeam.robots.length];
    const to = toTeam.robots[route.toRobot % toTeam.robots.length];
    if (!from || !to) continue;
    const progress = easeInOutCubic(raw / activeWindow);
    const curve = makeCrossCurve(from, to, center, route.anchor, mobile);
    drawMessageFlight(
      ctx,
      curve,
      progress,
      route.accent ? palette.messageAccent : fromTeam.color,
      time,
      mobile ? 6 : 8.5,
      palette,
      true
    );
  }
}

function drawMessageFlight(
  ctx: CanvasRenderingContext2D,
  curve: [Point, Point, Point, Point],
  progress: number,
  color: string,
  time: number,
  size: number,
  palette: Palette,
  crossTeam = false
): void {
  const [p0, p1, p2, p3] = curve;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  ctx.strokeStyle = withAlpha(color, crossTeam ? 0.24 : 0.18);
  ctx.lineWidth = crossTeam ? 1.25 : 1;
  ctx.setLineDash(crossTeam ? [8, 10] : [4, 8]);
  ctx.lineDashOffset = -time * (crossTeam ? 52 : 34);
  ctx.stroke();
  ctx.setLineDash([]);

  for (let i = 7; i >= 1; i--) {
    const t = progress - i * 0.036;
    if (t <= 0) continue;
    const point = cubicPoint(p0, p1, p2, p3, t);
    const alpha = (1 - i / 8) * (palette.isLight ? 0.22 : 0.32);
    ctx.fillStyle = withAlpha(color, alpha);
    ctx.beginPath();
    ctx.arc(point.x, point.y, size * (0.18 + i * 0.025), 0, TAU);
    ctx.fill();
  }

  const position = cubicPoint(p0, p1, p2, p3, progress);
  const tangent = cubicTangent(p0, p1, p2, p3, progress);
  const angle = Math.atan2(tangent.y, tangent.x);
  drawMessageBubble(ctx, position, angle, size, color, palette, crossTeam);
  ctx.restore();
}

function drawMessageBubble(
  ctx: CanvasRenderingContext2D,
  position: Point,
  angle: number,
  size: number,
  color: string,
  palette: Palette,
  crossTeam: boolean
): void {
  ctx.save();
  ctx.translate(position.x, position.y);
  ctx.rotate(angle * 0.14);
  ctx.shadowColor = withAlpha(color, palette.isLight ? 0.22 : 0.5);
  ctx.shadowBlur = crossTeam ? 18 : 12;

  const width = size * (crossTeam ? 2.5 : 2.25);
  const height = size * 1.62;
  roundRectPath(ctx, -width / 2, -height / 2, width, height, size * 0.45);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(-width * 0.24, height * 0.42);
  ctx.lineTo(-width * 0.36, height * 0.78);
  ctx.lineTo(-width * 0.05, height * 0.44);
  ctx.closePath();
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.fillStyle = palette.robotEye;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.arc(i * size * 0.43, -size * 0.02, size * 0.12, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawRobot(
  ctx: CanvasRenderingContext2D,
  robot: RobotNode,
  time: number,
  palette: Palette
): void {
  const size = robot.size;
  const x = robot.x;
  const y = robot.y + robot.bob * 1.6;
  const tilt = Math.sin(time * 1.5 + robot.teamIndex + robot.robotIndex * 0.8) * 0.08;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.shadowColor = withAlpha(robot.color, palette.isLight ? 0.2 : 0.42);
  ctx.shadowBlur = size * 1.6;

  ctx.strokeStyle = withAlpha(robot.color, palette.isLight ? 0.64 : 0.82);
  ctx.lineWidth = Math.max(1, size * 0.11);
  ctx.beginPath();
  ctx.moveTo(-size * 0.78, size * 0.22);
  ctx.lineTo(-size * 1.12, size * 0.55);
  ctx.moveTo(size * 0.78, size * 0.22);
  ctx.lineTo(size * 1.12, size * 0.55);
  ctx.stroke();

  const bodyGradient = ctx.createLinearGradient(0, -size, 0, size);
  bodyGradient.addColorStop(0, mixColor(robot.color, palette.robotBody, 0.28));
  bodyGradient.addColorStop(1, mixColor(robot.color, palette.robotShade, 0.62));
  roundRectPath(ctx, -size * 0.78, -size * 0.74, size * 1.56, size * 1.48, size * 0.42);
  ctx.fillStyle = bodyGradient;
  ctx.fill();
  ctx.strokeStyle = withAlpha(robot.color, palette.isLight ? 0.74 : 0.9);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = withAlpha(robot.color, 0.75);
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.76);
  ctx.lineTo(0, -size * 1.18);
  ctx.stroke();
  ctx.fillStyle = robot.color;
  ctx.beginPath();
  ctx.arc(0, -size * 1.25, size * 0.16, 0, TAU);
  ctx.fill();

  ctx.fillStyle = palette.robotEye;
  ctx.beginPath();
  ctx.arc(-size * 0.3, -size * 0.2, size * 0.16, 0, TAU);
  ctx.arc(size * 0.3, -size * 0.2, size * 0.16, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = withAlpha(palette.robotEye, 0.72);
  ctx.lineWidth = Math.max(1, size * 0.09);
  ctx.beginPath();
  ctx.moveTo(-size * 0.36, size * 0.24);
  ctx.quadraticCurveTo(0, size * 0.5, size * 0.36, size * 0.24);
  ctx.stroke();

  ctx.fillStyle = withAlpha(robot.color, palette.isLight ? 0.58 : 0.82);
  ctx.fillRect(-size * 0.42, size * 0.82, size * 0.28, size * 0.22);
  ctx.fillRect(size * 0.14, size * 0.82, size * 0.28, size * 0.22);
  ctx.restore();
}

function getTeamConnectionPairs(memberCount: number): [number, number][] {
  if (memberCount <= 3) {
    return [
      [0, 1],
      [1, 2],
      [2, 0],
    ];
  }

  const pairs: [number, number][] = [];
  for (let index = 0; index < memberCount; index++) {
    pairs.push([index, (index + 1) % memberCount]);
  }
  if (memberCount >= 4) pairs.push([0, 2]);
  if (memberCount >= 5) pairs.push([1, 4]);
  return pairs;
}

function getLocalMessagePairs(teamIndex: number, memberCount: number): [number, number][] {
  const routeMap: [number, number][][] = [
    [
      [0, 2],
      [3, 1],
      [1, 0],
    ],
    [
      [2, 0],
      [0, 1],
      [1, 2],
    ],
    [
      [4, 1],
      [0, 3],
      [2, 4],
      [3, 0],
    ],
  ];
  return (routeMap[teamIndex] ?? routeMap[0]).filter(
    ([fromIndex, toIndex]) => fromIndex < memberCount && toIndex < memberCount
  );
}

function makeLocalCurve(
  from: Point,
  to: Point,
  center: Point,
  lift: number
): [Point, Point, Point, Point] {
  const mid = mix(from, to, 0.5);
  const away = normalize({ x: mid.x - center.x, y: mid.y - center.y });
  const control = {
    x: mid.x + away.x * lift,
    y: mid.y + away.y * lift,
  };
  return [from, mix(from, control, 0.72), mix(to, control, 0.72), to];
}

function makeCrossCurve(
  from: Point,
  to: Point,
  center: Point,
  index: number,
  mobile: boolean
): [Point, Point, Point, Point] {
  const anchor = getCrossTeamAnchor(center, index, mobile);
  const curveLift = 0.32 + index * 0.06;
  const cp1 = mix(from, anchor, curveLift);
  const cp2 = mix(to, anchor, curveLift);
  const normal = normalize({ x: to.y - from.y, y: from.x - to.x });
  const offset = mobile ? 22 + index * 6 : 42 + index * 12;
  return [
    from,
    { x: cp1.x + normal.x * offset, y: cp1.y + normal.y * offset },
    { x: cp2.x + normal.x * offset, y: cp2.y + normal.y * offset },
    to,
  ];
}

function getCrossTeamAnchor(center: Point, index: number, mobile: boolean): Point {
  const horizontalOffset = mobile ? 108 : 178;
  const topOffset = mobile ? 94 : 138;
  const lowerOffset = mobile ? 106 : 112;
  if (index === 0) {
    return {
      x: center.x,
      y: center.y - topOffset,
    };
  }
  if (index === 1) {
    return {
      x: center.x + horizontalOffset,
      y: center.y + lowerOffset,
    };
  }
  return {
    x: center.x - horizontalOffset,
    y: center.y + lowerOffset,
  };
}

function clearCentralContentReserve(
  ctx: CanvasRenderingContext2D,
  center: Point,
  mobile: boolean
): void {
  const width = mobile ? 260 : 330;
  const height = mobile ? 166 : 184;
  const y = center.y + (mobile ? 12 : 10);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  roundRectPath(ctx, center.x - width / 2, y - height / 2, width, height, mobile ? 32 : 40);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.98)';
  ctx.fill();

  const glow = ctx.createRadialGradient(center.x, y, 8, center.x, y, width * 0.62);
  glow.addColorStop(0, 'rgba(0, 0, 0, 0.96)');
  glow.addColorStop(0.68, 'rgba(0, 0, 0, 0.9)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  roundRectPath(ctx, center.x - width / 2, y - height / 2, width, height, mobile ? 32 : 40);
  ctx.fill();
  ctx.restore();
}

function createDepthParticles(width: number, height: number): DepthParticle[] {
  const count = width < 560 ? 46 : 78;
  return Array.from({ length: count }, (_, index) => {
    const seed = index * 97.13;
    return {
      x: pseudoRandom(seed) * width,
      y: pseudoRandom(seed + 12.4) * (height + 24),
      size: 0.45 + pseudoRandom(seed + 22.8) * 1.15,
      speed: 8 + pseudoRandom(seed + 31.2) * 18,
      phase: pseudoRandom(seed + 48.7) * TAU,
      alpha: 0.06 + pseudoRandom(seed + 72.1) * 0.16,
    };
  });
}

function pseudoRandom(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const clamped = clamp(t, 0, 1);
  const mt = 1 - clamped;
  const mt2 = mt * mt;
  const t2 = clamped * clamped;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * clamped * p1.x + 3 * mt * t2 * p2.x + t2 * clamped * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * clamped * p1.y + 3 * mt * t2 * p2.y + t2 * clamped * p3.y,
  };
}

function cubicTangent(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const clamped = clamp(t, 0, 1);
  const mt = 1 - clamped;
  return {
    x:
      3 * mt * mt * (p1.x - p0.x) +
      6 * mt * clamped * (p2.x - p1.x) +
      3 * clamped * clamped * (p3.x - p2.x),
    y:
      3 * mt * mt * (p1.y - p0.y) +
      6 * mt * clamped * (p2.y - p1.y) +
      3 * clamped * clamped * (p3.y - p2.y),
  };
}

function mix(from: Point, to: Point, amount: number): Point {
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
  };
}

function normalize(point: Point): Point {
  const length = Math.hypot(point.x, point.y) || 1;
  return {
    x: point.x / length,
    y: point.y / length,
  };
}

function easeInOutCubic(value: number): number {
  const t = clamp(value, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function withAlpha(hex: string, alpha: number): string {
  const normalized = normalizeHex(hex);
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

function mixColor(hexA: string, hexB: string, amount: number): string {
  const a = hexToRgb(normalizeHex(hexA));
  const b = hexToRgb(normalizeHex(hexB));
  const t = clamp(amount, 0, 1);
  return `rgb(${Math.round(a.r + (b.r - a.r) * t)}, ${Math.round(
    a.g + (b.g - a.g) * t
  )}, ${Math.round(a.b + (b.b - a.b) * t)})`;
}

function normalizeHex(hex: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return '#ffffff';
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}
