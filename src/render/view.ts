import { WORLD_H, WORLD_W } from '../sim/constants';
import type { Vec } from '../sim/geom';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Maps world coordinates to screen (CSS pixel) coordinates. On tall portrait
 * screens the map is turned 90° clockwise so it fills a phone held upright.
 */
export class View {
  scale = 1;
  ox = 0;
  oy = 0;
  rotated = false;

  fit(width: number, height: number, inset: Insets): void {
    const availW = Math.max(50, width - inset.left - inset.right);
    const availH = Math.max(50, height - inset.top - inset.bottom);
    this.rotated = availH > availW * 1.15;
    const ww = this.rotated ? WORLD_H : WORLD_W;
    const wh = this.rotated ? WORLD_W : WORLD_H;
    this.scale = Math.min(availW / ww, availH / wh);
    this.ox = inset.left + (availW - ww * this.scale) / 2;
    this.oy = inset.top + (availH - wh * this.scale) / 2;
  }

  toScreen(p: Vec): Vec {
    const s = this.scale;
    if (!this.rotated) return { x: this.ox + p.x * s, y: this.oy + p.y * s };
    return { x: this.ox + (WORLD_H - p.y) * s, y: this.oy + p.x * s };
  }

  toWorld(q: Vec): Vec {
    const s = this.scale;
    if (!this.rotated) return { x: (q.x - this.ox) / s, y: (q.y - this.oy) / s };
    return { x: (q.y - this.oy) / s, y: WORLD_H - (q.x - this.ox) / s };
  }

  /** How many degrees the map is turned on screen. */
  get rotation(): number {
    return this.rotated ? 90 : 0;
  }
}
