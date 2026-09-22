/**
 * Post-processing bloom effect.
 * Adapted from agent-flow's bloom-renderer.ts (Apache 2.0).
 * Zero imports — pure Canvas 2D.
 */

export class BloomRenderer {
  #bloomCanvas: HTMLCanvasElement;
  #bloomCtx: CanvasRenderingContext2D;
  #tempCanvas: HTMLCanvasElement;
  #tempCtx: CanvasRenderingContext2D;
  #intensity: number;
  #w = 0;
  #h = 0;

  constructor(intensity = 0.6) {
    this.#intensity = intensity;
    this.#bloomCanvas = document.createElement('canvas');
    this.#bloomCtx = this.#bloomCanvas.getContext('2d')!;
    this.#tempCanvas = document.createElement('canvas');
    this.#tempCtx = this.#tempCanvas.getContext('2d')!;
  }

  resize(w: number, h: number): void {
    const hw = Math.ceil(w / 2);
    const hh = Math.ceil(h / 2);
    if (this.#w === hw && this.#h === hh) return;
    this.#w = hw;
    this.#h = hh;
    this.#bloomCanvas.width = hw;
    this.#bloomCanvas.height = hh;
    this.#tempCanvas.width = hw;
    this.#tempCanvas.height = hh;
  }

  setIntensity(v: number): void {
    this.#intensity = Math.max(0, Math.min(1, v));
  }

  apply(source: HTMLCanvasElement, targetCtx: CanvasRenderingContext2D): void {
    if (this.#intensity <= 0 || this.#w === 0) return;

    this.#bloomCtx.clearRect(0, 0, this.#w, this.#h);
    this.#bloomCtx.drawImage(source, 0, 0, this.#w, this.#h);

    const radii = [8, 6, 4];
    for (const r of radii) {
      this.#tempCtx.clearRect(0, 0, this.#w, this.#h);
      this.#tempCtx.filter = `blur(${r}px)`;
      this.#tempCtx.drawImage(this.#bloomCanvas, 0, 0);
      this.#tempCtx.filter = 'none';

      this.#bloomCtx.clearRect(0, 0, this.#w, this.#h);
      this.#bloomCtx.drawImage(this.#tempCanvas, 0, 0);
    }

    const prevOp = targetCtx.globalCompositeOperation;
    const prevAlpha = targetCtx.globalAlpha;
    targetCtx.globalCompositeOperation = 'lighter';
    targetCtx.globalAlpha = this.#intensity;
    targetCtx.drawImage(this.#bloomCanvas, 0, 0, source.width, source.height);
    targetCtx.globalCompositeOperation = prevOp;
    targetCtx.globalAlpha = prevAlpha;
  }

  [Symbol.dispose](): void {
    this.#w = 0;
    this.#h = 0;
  }
}
