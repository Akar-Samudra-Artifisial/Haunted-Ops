/**
 * Palette tokens of the house scene. One source: PixiJS reads the numbers, a test checks the strings
 * that repeat CSS custom properties. Our own colours: a night house with a warm lamp and cold ghosts.
 */
export const PALETTE = {
  night: '#14121c', // page and sky (equal to --bg)
  nightDeep: '#0b0a10', // dark room fill, vignette
  wallLeft: '#3b3354',
  wallRight: '#2f2945',
  floor: '#4a3f66',
  trim: '#8d82bb', // outline, corridor, selection base
  lampWarm: '#ffd08a',
  glowWarm: '#ffb45e',
  lightCold: '#9cc7e6',
  ghost: '#e9f3ff',
  fog: '#8fb3c9',
  alarm: '#ff7a66', // incident mark, level 3 rim
  pill: '#1a1626', // label and badge background
  text: '#f4efe6',
  ring: '#ffd866', // selection ring (equal to --focus)
  alarmText: '#ffb3a3', // alarm colour for text on the pill
  fogText: '#a9d4ec', // fog colour for text on the pill
} as const;

export type PaletteToken = keyof typeof PALETTE;

/** `#rrggbb` to the number PixiJS takes. */
export function hexToNumber(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16);
}

/** The page's system font stack. The scene never loads a font file. */
export const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Opacity of the pill behind labels and badges. */
export const PILL_ALPHA = 0.85;

export interface ContrastPair {
  readonly name: string;
  readonly fg: PaletteToken;
  readonly bg: PaletteToken;
  /** `text` needs 4.5 to 1, `shape` needs 3 to 1. */
  readonly kind: 'text' | 'shape';
}

/** Every pair of colours that carries text or a UI shape in the scene. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { name: 'label on pill', fg: 'text', bg: 'pill', kind: 'text' },
  { name: 'badge (alarm) on pill', fg: 'alarmText', bg: 'pill', kind: 'text' },
  { name: 'badge (fog) on pill', fg: 'fogText', bg: 'pill', kind: 'text' },
  { name: 'badge (ghost) on pill', fg: 'ghost', bg: 'pill', kind: 'text' },
  { name: 'label on dark room', fg: 'text', bg: 'nightDeep', kind: 'text' },
  { name: 'outline on dark room', fg: 'trim', bg: 'nightDeep', kind: 'shape' },
  { name: 'outline on night', fg: 'trim', bg: 'night', kind: 'shape' },
  { name: 'corridor on night', fg: 'trim', bg: 'night', kind: 'shape' },
  { name: 'selection ring on night', fg: 'ring', bg: 'night', kind: 'shape' },
];
