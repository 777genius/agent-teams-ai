import { PARTICIPANT_AVATAR_URLS } from '@renderer/utils/memberAvatarCatalog';

export interface SplashSceneHandle {
  stop: () => void;
  ready?: Promise<void>;
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
  receivePulse: number;
  avatarUrl: string;
}

interface TeamNode {
  index: number;
  center: Point;
  color: string;
  radius: number;
  robots: RobotNode[];
}

interface MessageFlightState {
  progress: number;
  motionSpeed: number;
  bubbleScale: number;
  bubbleAlpha: number;
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
  robotBody: string;
  robotShade: string;
  robotEye: string;
  messageAccent: string;
  particle: string;
}

const TAU = Math.PI * 2;
const TEAM_MEMBER_COUNTS = [4, 3, 5] as const;
const TEAM_MEMBER_OFFSETS = [0, 4, 7] as const;
const TEAM_LABELS = ['Marketing', 'Researchers', 'Coding'] as const;
const MAX_DPR = 2;
const avatarCache = new Map<string, HTMLImageElement>();
const avatarLoading = new Map<string, Promise<HTMLImageElement | null>>();

export function startSplashScene(
  splash: HTMLElement,
  options: SplashSceneOptions = {}
): SplashSceneHandle {
  const existingScene = window.__claudeTeamsSplashScene;
  if (existingScene && splash.querySelector('#splash-enhanced-canvas')) {
    return existingScene;
  }

  const ready = preloadAvatarImages();
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
      ready,
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
    ready,
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
  drawCrossTeamGuides(ctx, teams, sceneTime, palette);

  for (const team of teams) {
    drawTeamHalo(ctx, team, sceneTime, palette);
  }

  drawMessages(ctx, teams, sceneTime, palette, mobile);

  for (const team of teams) {
    for (const robot of team.robots) {
      drawRobot(ctx, robot, sceneTime, palette);
    }
  }

  for (const team of teams) {
    drawTeamLabel(ctx, team, palette, mobile);
  }
}

function resolvePalette(): Palette {
  const isLight = document.documentElement.classList.contains('light');
  return isLight
    ? {
        isLight,
        centerGlow: '#4f46e5',
        teamColors: ['#0369a1', '#047857', '#b45309'],
        robotBody: '#eef2ff',
        robotShade: '#dbe4ff',
        robotEye: '#ffffff',
        messageAccent: '#7c3aed',
        particle: '#312e81',
      }
    : {
        isLight,
        centerGlow: '#7c83f7',
        teamColors: ['#24a8d8', '#23b488', '#d58a19'],
        robotBody: '#0f1724',
        robotShade: '#1a2438',
        robotEye: '#d8f3ff',
        messageAccent: '#8b5cf6',
        particle: '#a6a4d6',
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
  const spreadX = mobile ? Math.min(width * 0.36, 148) : Math.min(width * 0.34, 380);
  const spreadY = mobile ? Math.min(height * 0.22, 154) : Math.min(height * 0.22, 220);
  const teamRadius = mobile
    ? clamp(Math.min(width, height) * 0.092, 31, 42)
    : clamp(Math.min(width, height) * 0.072, 42, 62);
  const robotSize = mobile ? 9.8 : 11.8;
  const centers: Point[] = [
    {
      x: center.x - spreadX,
      y: center.y - spreadY * (mobile ? 0.66 : 0.58),
    },
    {
      x: center.x + spreadX,
      y: center.y - spreadY * (mobile ? 0.66 : 0.58),
    },
    {
      x: center.x,
      y: center.y + spreadY * (mobile ? 1.34 : 1.18),
    },
  ];

  return centers.map((teamCenter, teamIndex) => {
    const drift = Math.sin(time * 0.75 + teamIndex * 1.7) * (mobile ? 2.2 : 4.2);
    const centerWithDrift = {
      x: teamCenter.x + Math.cos(teamIndex * 2.1 + time * 0.35) * (mobile ? 1.4 : 2.8),
      y: teamCenter.y + drift,
    };
    const color = palette.teamColors[teamIndex % palette.teamColors.length] ?? palette.centerGlow;
    const memberCount = TEAM_MEMBER_COUNTS[teamIndex] ?? 3;
    const robots = Array.from({ length: memberCount }, (_, robotIndex) => {
      const baseAngle =
        -Math.PI / 2 + robotIndex * (TAU / memberCount) + (teamIndex === 2 ? TAU / 20 : 0);
      const orbit = baseAngle + Math.sin(time * 0.55 + teamIndex + robotIndex) * 0.07;
      const orbitRadius =
        teamRadius * (0.94 + (memberCount > 4 ? 0.07 : 0) + 0.03 * Math.sin(time + robotIndex));
      return {
        teamIndex,
        robotIndex,
        color,
        size: memberCount > 4 ? robotSize * 0.88 : robotSize,
        bob: Math.sin(time * 2.2 + teamIndex * 0.8 + robotIndex * 1.1),
        receivePulse: 0,
        avatarUrl:
          PARTICIPANT_AVATAR_URLS[(TEAM_MEMBER_OFFSETS[teamIndex] ?? 0) + robotIndex] ??
          PARTICIPANT_AVATAR_URLS[0],
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
  glow.addColorStop(0, withAlpha(palette.centerGlow, palette.isLight ? 0.1 : 0.14));
  glow.addColorStop(0.48, withAlpha(palette.messageAccent, palette.isLight ? 0.04 : 0.07));
  glow.addColorStop(1, withAlpha(palette.centerGlow, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, TAU);
  ctx.fill();

  for (let i = 0; i < 3; i++) {
    const ringRadius = radius * (0.42 + i * 0.18) + Math.sin(time * 1.1 + i) * 3;
    ctx.beginPath();
    ctx.strokeStyle = withAlpha(palette.centerGlow, 0.07 - i * 0.014);
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
  time: number,
  palette: Palette
): void {
  for (let i = 0; i < teams.length; i++) {
    const from = teams[i];
    const to = teams[(i + 1) % teams.length];
    if (!from || !to) continue;
    ctx.beginPath();
    ctx.moveTo(from.center.x, from.center.y);
    ctx.lineTo(to.center.x, to.center.y);
    ctx.strokeStyle = withAlpha(palette.messageAccent, palette.isLight ? 0.14 : 0.18);
    ctx.lineWidth = 1.05;
    ctx.setLineDash([7, 12]);
    ctx.lineDashOffset = -time * 34;
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
  glow.addColorStop(0, withAlpha(team.color, palette.isLight ? 0.045 : 0.065));
  glow.addColorStop(1, withAlpha(team.color, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(team.center.x, team.center.y, team.radius * 1.82, team.radius * 1.36, 0, 0, TAU);
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(team.center.x, team.center.y, radiusX, radiusY, time * 0.08, 0, TAU);
  ctx.strokeStyle = withAlpha(team.color, palette.isLight ? 0.2 : 0.24);
  ctx.lineWidth = 1;
  ctx.setLineDash([12, 10]);
  ctx.lineDashOffset = -time * (22 + team.index * 4);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawMessages(
  ctx: CanvasRenderingContext2D,
  teams: TeamNode[],
  time: number,
  palette: Palette,
  mobile: boolean
): void {
  for (const team of teams) {
    drawLocalMessages(ctx, team, time, palette, mobile);
  }
  drawCrossTeamMessages(ctx, teams, time, palette, mobile);
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
    applyReceivePulse(to, getReceivePulse(raw, activeWindow));
    const flightState = getMessageFlightState(raw, activeWindow, 0.12);
    if (!flightState) continue;
    const curve = makeLocalCurve(from, to, team.center, team.radius * 0.42);
    drawMessageFlight(ctx, curve, flightState, team.color, mobile ? 4.6 : 5.8, palette);
  }
}

function drawCrossTeamMessages(
  ctx: CanvasRenderingContext2D,
  teams: TeamNode[],
  time: number,
  palette: Palette,
  mobile: boolean
): void {
  const activeWindow = 0.64;
  const period = 4.25;
  const routes = [
    { fromTeam: 0, fromRobot: 3, toTeam: 1, toRobot: 1, delay: 0 },
    { fromTeam: 1, fromRobot: 2, toTeam: 2, toRobot: 0, delay: 1.34, accent: true },
    { fromTeam: 2, fromRobot: 4, toTeam: 0, toRobot: 1, delay: 2.68 },
  ];

  for (const route of routes) {
    const fromTeam = teams[route.fromTeam];
    const toTeam = teams[route.toTeam];
    if (!fromTeam || !toTeam) continue;
    const raw = positiveModulo(time + route.delay, period) / period;

    const from = fromTeam.robots[route.fromRobot % fromTeam.robots.length];
    const to = toTeam.robots[route.toRobot % toTeam.robots.length];
    if (!from || !to) continue;
    applyReceivePulse(to, getReceivePulse(raw, activeWindow) * 0.88);
    const flightState = getMessageFlightState(raw, activeWindow, 0.1);
    if (!flightState) continue;
    const curve = makeStraightCurve(from, to);
    drawMessageFlight(
      ctx,
      curve,
      flightState,
      route.accent ? palette.messageAccent : fromTeam.color,
      mobile ? 5.2 : 6.8,
      palette,
      true
    );
  }
}

function drawMessageFlight(
  ctx: CanvasRenderingContext2D,
  curve: [Point, Point, Point, Point],
  state: MessageFlightState,
  color: string,
  size: number,
  palette: Palette,
  crossTeam = false
): void {
  const [p0, p1, p2, p3] = curve;
  ctx.save();

  const progress = state.progress;
  const speed = clamp(state.motionSpeed, 0, 1);
  if (speed > 0.045) {
    drawSpeedTrail(ctx, curve, progress, speed, color, size, palette, crossTeam);
  }

  const position = cubicPoint(p0, p1, p2, p3, progress);
  const tangent = cubicTangent(p0, p1, p2, p3, progress);
  const angle = Math.atan2(tangent.y, tangent.x);
  drawMessageBubble(
    ctx,
    position,
    angle,
    size,
    color,
    palette,
    crossTeam,
    state.bubbleScale,
    state.bubbleAlpha
  );
  ctx.restore();
}

function drawSpeedTrail(
  ctx: CanvasRenderingContext2D,
  curve: [Point, Point, Point, Point],
  progress: number,
  speed: number,
  color: string,
  size: number,
  palette: Palette,
  crossTeam: boolean
): void {
  const [p0, p1, p2, p3] = curve;
  const trailLength = (crossTeam ? 0.26 : 0.21) * (0.24 + speed * 1.08);
  const segmentCount = Math.round(9 + speed * 10);
  const alphaBase = (palette.isLight ? 0.22 : 0.32) * speed;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = withAlpha(color, alphaBase * 0.58);
  ctx.shadowBlur = size * (0.78 + speed * 1.28);

  for (let segment = 0; segment < segmentCount; segment++) {
    const startRatio = segment / segmentCount;
    const endRatio = (segment + 1) / segmentCount;
    const t0 = progress - trailLength * (1 - startRatio);
    const t1 = progress - trailLength * (1 - endRatio);
    if (t1 <= 0) continue;

    const from = cubicPoint(p0, p1, p2, p3, Math.max(0, t0));
    const to = cubicPoint(p0, p1, p2, p3, Math.max(0, t1));
    const headWeight = endRatio * endRatio;
    const width = size * (0.12 + headWeight * 0.48) * (0.9 + speed * 0.45);
    const alpha = alphaBase * headWeight;

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = withAlpha(color, alpha * 0.34);
    ctx.lineWidth = width * 2.35;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = withAlpha(color, alpha);
    ctx.lineWidth = width;
    ctx.stroke();
  }

  ctx.restore();
}

function getMessageFlightState(
  raw: number,
  activeWindow: number,
  settleWindow: number
): MessageFlightState | null {
  if (raw > activeWindow + settleWindow) return null;

  if (raw <= activeWindow) {
    const phase = raw / activeWindow;
    return {
      progress: easeInOutCubic(phase),
      motionSpeed: getEasedMotionSpeed(phase),
      bubbleScale: 1,
      bubbleAlpha: 1,
    };
  }

  const settlePhase = (raw - activeWindow) / settleWindow;
  const eased = easeOutCubic(settlePhase);
  return {
    progress: 1,
    motionSpeed: 0,
    bubbleScale: Math.max(0.12, 1 - eased * 0.88),
    bubbleAlpha: Math.max(0, 1 - eased),
  };
}

function applyReceivePulse(robot: RobotNode, pulse: number): void {
  robot.receivePulse = Math.max(robot.receivePulse, pulse);
}

function getReceivePulse(raw: number, activeWindow: number): number {
  const previousStart = activeWindow * 0.78;
  const previousEnd = Math.min(0.96, activeWindow + 0.11);
  const duration = (previousEnd - previousStart) / 3;
  const start = activeWindow - duration * 0.62;
  const end = activeWindow + duration * 0.38;
  if (raw < start || raw > end) return 0;

  const phase = (raw - start) / (end - start);
  return Math.sin(phase * Math.PI) * (1 - phase * 0.28);
}

function getEasedMotionSpeed(value: number): number {
  const t = clamp(value, 0, 1);
  const derivative = t < 0.5 ? 12 * t * t : 12 * (1 - t) * (1 - t);
  return clamp(derivative / 3, 0, 1);
}

function easeOutCubic(value: number): number {
  const t = clamp(value, 0, 1);
  return 1 - Math.pow(1 - t, 3);
}

function drawMessageBubble(
  ctx: CanvasRenderingContext2D,
  position: Point,
  angle: number,
  size: number,
  color: string,
  palette: Palette,
  crossTeam: boolean,
  scale = 1,
  alpha = 1
): void {
  if (scale <= 0.02 || alpha <= 0.01) return;

  ctx.save();
  ctx.translate(position.x, position.y);
  ctx.rotate(angle * 0.08);
  ctx.scale(scale, scale);
  ctx.globalAlpha = alpha;
  ctx.shadowColor = withAlpha(color, (palette.isLight ? 0.16 : 0.3) * alpha);
  ctx.shadowBlur = (crossTeam ? 12 : 8) * (0.5 + scale * 0.5);

  const width = size * (crossTeam ? 2.28 : 2.06);
  const height = size * 1.42;
  roundRectPath(ctx, -width / 2, -height / 2, width, height, size * 0.28);
  ctx.fillStyle = withAlpha(color, palette.isLight ? 0.82 : 0.9);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(-width * 0.24, height * 0.42);
  ctx.lineTo(-width * 0.32, height * 0.68);
  ctx.lineTo(-width * 0.03, height * 0.42);
  ctx.closePath();
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.fillStyle = palette.robotEye;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.arc(i * size * 0.4, -size * 0.02, size * 0.095, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawTeamLabel(
  ctx: CanvasRenderingContext2D,
  team: TeamNode,
  palette: Palette,
  mobile: boolean
): void {
  const label = TEAM_LABELS[team.index] ?? '';
  if (!label) return;

  const fontSize = mobile ? 7.5 : 8.5;
  const y = team.center.y + team.radius * (mobile ? 1.65 : 1.58);
  ctx.save();
  ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const metrics = ctx.measureText(label);
  const paddingX = mobile ? 4 : 5;
  const paddingY = mobile ? 2 : 2.5;
  const width = metrics.width + paddingX * 2;
  const height = fontSize + paddingY * 2;
  const x = team.center.x - width / 2;
  const rectY = y - height / 2;

  roundRectPath(ctx, x, rectY, width, height, height / 2);
  ctx.fillStyle = withAlpha(palette.isLight ? '#ffffff' : '#090a14', palette.isLight ? 0.36 : 0.24);
  ctx.fill();
  ctx.strokeStyle = withAlpha(team.color, palette.isLight ? 0.18 : 0.24);
  ctx.lineWidth = 0.75;
  ctx.stroke();

  ctx.shadowColor = withAlpha(team.color, palette.isLight ? 0.12 : 0.22);
  ctx.shadowBlur = mobile ? 4 : 6;
  ctx.fillStyle = withAlpha(palette.isLight ? '#3f3f46' : '#e4e4e7', palette.isLight ? 0.58 : 0.66);
  ctx.fillText(label, team.center.x, y + 0.2);
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
  const y = robot.y + robot.bob * 0.9 - robot.receivePulse * size * 0.24;
  const tilt = Math.sin(time * 1.5 + robot.teamIndex + robot.robotIndex * 0.8) * 0.045;
  const img = getAvatarImage(robot.avatarUrl);
  const avatarSize = size * 2.65;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.scale(1 + robot.receivePulse * 0.065, 1 + robot.receivePulse * 0.065);
  ctx.shadowColor = withAlpha(robot.color, palette.isLight ? 0.2 : 0.34);
  ctx.shadowBlur = size * (1.25 + robot.receivePulse * 0.72);

  if (img) {
    ctx.globalAlpha = palette.isLight ? 0.92 : 0.86;
    ctx.drawImage(img, -avatarSize / 2, -avatarSize / 2, avatarSize, avatarSize);
    ctx.globalAlpha = 1;
  } else {
    drawAvatarFallback(ctx, size, robot.color, palette);
  }
  ctx.restore();
}

function getAvatarImage(url: string): HTMLImageElement | null {
  const cached = avatarCache.get(url);
  if (cached) {
    avatarCache.delete(url);
    avatarCache.set(url, cached);
    return cached;
  }

  void loadAvatarImage(url);
  return null;
}

function preloadAvatarImages(): Promise<void> {
  return Promise.allSettled(PARTICIPANT_AVATAR_URLS.map((url) => loadAvatarImage(url))).then(
    () => undefined
  );
}

function loadAvatarImage(url: string): Promise<HTMLImageElement | null> {
  const cached = avatarCache.get(url);
  if (cached) return Promise.resolve(cached);

  const loading = avatarLoading.get(url);
  if (loading) return loading;

  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const finish = (): void => {
        avatarCache.set(url, img);
        avatarLoading.delete(url);
        resolve(img);
      };

      if (typeof img.decode === 'function') {
        void img.decode().then(finish, finish);
      } else {
        finish();
      }
    };
    img.onerror = () => {
      avatarLoading.delete(url);
      resolve(null);
    };
    img.src = url;
  });

  avatarLoading.set(url, promise);
  return promise;
}

function drawAvatarFallback(
  ctx: CanvasRenderingContext2D,
  size: number,
  color: string,
  palette: Palette
): void {
  ctx.strokeStyle = withAlpha(color, palette.isLight ? 0.44 : 0.56);
  ctx.lineWidth = Math.max(1, size * 0.08);
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.72);
  ctx.lineTo(0, -size * 1.0);
  ctx.stroke();
  ctx.fillStyle = withAlpha(color, palette.isLight ? 0.64 : 0.78);
  ctx.beginPath();
  ctx.arc(0, -size * 1.08, size * 0.13, 0, TAU);
  ctx.fill();
  ctx.fillStyle = palette.robotEye;
  ctx.beginPath();
  ctx.arc(-size * 0.24, -size * 0.13, size * 0.095, 0, TAU);
  ctx.arc(size * 0.24, -size * 0.13, size * 0.095, 0, TAU);
  ctx.fill();
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

function makeStraightCurve(from: Point, to: Point): [Point, Point, Point, Point] {
  return [from, mix(from, to, 0.33), mix(from, to, 0.66), to];
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

function normalizeHex(hex: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return '#ffffff';
}
