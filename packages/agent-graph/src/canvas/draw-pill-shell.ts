import { hexWithAlpha } from './render-cache';

export interface PillShellOptions {
  width: number;
  height: number;
  radius: number;
  fillStyle: string;
  borderColor: string;
  borderWidth: number;
  shadowColor?: string;
  shadowBlur?: number;
  accentColor?: string;
  accentWidth?: number;
}

export function drawPillShell(
  ctx: CanvasRenderingContext2D,
  options: PillShellOptions
): void {
  const {
    width,
    height,
    radius,
    fillStyle,
    borderColor,
    borderWidth,
    shadowColor,
    shadowBlur = 0,
    accentColor,
    accentWidth = 4,
  } = options;
  const halfWidth = width / 2;
  const halfHeight = height / 2;

  if (shadowColor && shadowBlur > 0) {
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = shadowBlur;
  }

  ctx.beginPath();
  ctx.roundRect(-halfWidth, -halfHeight, width, height, radius);
  ctx.fillStyle = fillStyle;
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = borderWidth;
  ctx.stroke();

  if (accentColor) {
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.roundRect(-halfWidth, -halfHeight, accentWidth, height, [radius, 0, 0, radius]);
    ctx.fill();
  }
}

export function drawPillStackLayer(
  ctx: CanvasRenderingContext2D,
  options: {
    width: number;
    height: number;
    radius: number;
    offsetX: number;
    offsetY: number;
    fillColor: string;
    fillAlpha: number;
  }
): void {
  const { width, height, radius, offsetX, offsetY, fillColor, fillAlpha } = options;
  const halfWidth = width / 2;
  const halfHeight = height / 2;

  ctx.beginPath();
  ctx.roundRect(-halfWidth + offsetX, -halfHeight + offsetY, width, height, radius);
  ctx.fillStyle = hexWithAlpha(fillColor, fillAlpha);
  ctx.fill();
}
