import { mulberry32 } from './rng.js';

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

/** A cloud of soft round blobs from a seeded generator: a noise texture for the fog layers, made once. */
function noise(seed: number, blobs: number, rLo: number, rHi: number): TextureRecipe['draw'] {
  return (ctx, w, h) => {
    const rnd = mulberry32(seed);
    for (let i = 0; i < blobs; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const r = (rLo + (rHi - rLo) * rnd()) * Math.min(w, h);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${(0.25 + 0.3 * rnd()).toFixed(2)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    // Fade the edges so a layer has no hard border.
    ctx.globalCompositeOperation = 'destination-in';
    const edge = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.min(w, h) / 2);
    edge.addColorStop(0, 'rgba(255,255,255,1)');
    edge.addColorStop(0.6, 'rgba(255,255,255,0.8)');
    edge.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  };
}

export const TEXTURE_RECIPES = {
  /** A ghost: a rounded head, a body that narrows into a wavy tail that curls to one side, and two eye holes. */
  ghost: {
    width: 96,
    height: 144,
    draw(ctx, w, h) {
      const cx = w / 2;
      const r = w * 0.34;
      const top = h * 0.05;
      const shoulderY = top + r * 1.25;
      ctx.beginPath();
      ctx.arc(cx, top + r, r, Math.PI, 0);
      // Right side: out to the shoulder, then in toward the tail.
      ctx.bezierCurveTo(cx + r * 1.25, shoulderY, cx + r * 1.35, h * 0.55, cx + r * 0.9, h * 0.72);
      // The tail: three waves that drift to the left as they go down.
      ctx.bezierCurveTo(cx + r * 0.8, h * 0.8, cx + r * 0.35, h * 0.78, cx + r * 0.3, h * 0.88);
      ctx.bezierCurveTo(cx + r * 0.25, h * 0.97, cx - r * 0.2, h * 0.92, cx - r * 0.3, h * 0.97);
      ctx.bezierCurveTo(cx - r * 0.5, h * 1.0, cx - r * 0.9, h * 0.9, cx - r * 1.0, h * 0.82);
      ctx.bezierCurveTo(cx - r * 1.4, h * 0.65, cx - r * 1.3, h * 0.45, cx - r * 1.2, shoulderY);
      ctx.bezierCurveTo(cx - r * 1.1, top + r * 1.05, cx - r, top + r, cx - r, top + r);
      ctx.closePath();
      // A cold white body that turns toward the fog colour as it goes down, so a crowd of ghosts is not one white blob.
      const g = ctx.createLinearGradient(0, top, 0, h);
      g.addColorStop(0, 'rgba(247,252,255,1)');
      g.addColorStop(0.65, 'rgba(190,226,238,0.85)');
      g.addColorStop(1, 'rgba(150,205,225,0.15)');
      ctx.fillStyle = g;
      ctx.fill();
      // A dark outline: each silhouette stays apart from the glow and from its neighbours.
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, w * 0.035);
      ctx.strokeStyle = 'rgba(11,10,18,0.6)';
      ctx.stroke();
      // Two deep eye holes, cut through, with a dark rim around them for contrast.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.42, top + r * 1.0, r * 0.19, r * 0.3, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + r * 0.42, top + r * 1.0, r * 0.19, r * 0.3, 0, 0, Math.PI * 2);
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
  /** Three soft noise clouds for the fog layers of a room: they drift at different speeds. */
  noiseA: { width: 128, height: 128, draw: noise(11, 14, 0.14, 0.3) },
  noiseB: { width: 128, height: 128, draw: noise(23, 18, 0.1, 0.22) },
  noiseC: { width: 128, height: 128, draw: noise(37, 10, 0.18, 0.36) },
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
