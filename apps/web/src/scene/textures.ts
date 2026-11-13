/**
 * Procedural recipes for the few sprites the scene needs. Each is drawn once, at start, onto a 2D
 * canvas with gradients and paths. There is no image, SVG or font file anywhere.
 */
export interface TextureRecipe {
  readonly width: number;
  readonly height: number;
  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void;
}

function radial(ctx: CanvasRenderingContext2D, w: number, h: number, stops: Array<[number, string]>): void {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.min(w, h) / 2);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

export const TEXTURE_RECIPES = {
  /** A wisp: a round head, straight sides and a wavy hem, fading toward the bottom, with two eye cuts. */
  ghost: {
    width: 96,
    height: 128,
    draw(ctx, w, h) {
      const r = w * 0.42;
      const cx = w / 2;
      const top = h * 0.08;
      const hemY = h * 0.86;
      ctx.beginPath();
      ctx.moveTo(cx - r, top + r);
      ctx.arc(cx, top + r, r, Math.PI, 0);
      ctx.lineTo(cx + r, hemY);
      const waves = 3;
      const step = (2 * r) / waves;
      for (let i = 0; i < waves; i++) {
        const x1 = cx + r - step * i;
        ctx.quadraticCurveTo(x1 - step / 4, hemY + h * 0.1, x1 - step / 2, hemY);
        ctx.quadraticCurveTo(x1 - (3 * step) / 4, hemY - h * 0.07, x1 - step, hemY);
      }
      ctx.closePath();
      const g = ctx.createLinearGradient(0, top, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.7, 'rgba(255,255,255,0.75)');
      g.addColorStop(1, 'rgba(255,255,255,0.1)');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.42, top + r * 1.05, r * 0.14, r * 0.22, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + r * 0.42, top + r * 1.05, r * 0.14, r * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    },
  },
  /** A soft puff of fog. */
  fog: {
    width: 128,
    height: 128,
    draw: (ctx, w, h) => radial(ctx, w, h, [[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]),
  },
  /** A wide, flat puff for the fog bank on the floor (about 2.5 times wider than high). */
  fogBank: {
    width: 256,
    height: 96,
    draw(ctx, w, h) {
      ctx.save();
      // A round gradient stretched into an ellipse that touches the edges of the canvas.
      ctx.translate(w / 2, h / 2);
      ctx.scale(w / h, 1);
      const r = h / 2;
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-r, -r, 2 * r, 2 * r);
      ctx.restore();
    },
  },
  /** A small soft dot: dust mote and corridor pulse. */
  mote: {
    width: 32,
    height: 32,
    draw: (ctx, w, h) => radial(ctx, w, h, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]),
  },
  /** A large, soft light for the lamp. */
  glow: {
    width: 256,
    height: 256,
    draw: (ctx, w, h) => radial(ctx, w, h, [[0, 'rgba(255,255,255,0.9)'], [0.35, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]),
  },
} as const satisfies Record<string, TextureRecipe>;

export type TextureName = keyof typeof TEXTURE_RECIPES;
export const TEXTURE_NAMES = Object.keys(TEXTURE_RECIPES) as TextureName[];

/** Draws one recipe on a new canvas. */
export function drawTexture(name: TextureName, doc: Document = document): HTMLCanvasElement {
  const recipe: TextureRecipe = TEXTURE_RECIPES[name];
  const canvas = doc.createElement('canvas');
  canvas.width = recipe.width;
  canvas.height = recipe.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas is not available');
  recipe.draw(ctx, recipe.width, recipe.height);
  return canvas;
}
