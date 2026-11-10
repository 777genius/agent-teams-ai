declare module 'pica' {
  export interface PicaInstance {
    resize(
      from: HTMLCanvasElement,
      to: HTMLCanvasElement,
      options?: Record<string, unknown>
    ): Promise<HTMLCanvasElement>;
  }

  export default function createPica(options?: Record<string, unknown>): PicaInstance;
}
