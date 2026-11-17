/** Small inline SVG glyphs, drawn for this product on a 24 by 24 grid with a round stroke. They are decorative: the text beside them is the name. */
const PATHS = {
  // Exorcist tools
  query_metrics: 'M4 19V5 M4 19h16 M8 15l3-4 3 2 5-6',
  search_errors: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M16 16l4 4',
  tail_logs: 'M5 6h14 M5 12h14 M5 18h9',
  recent_deploys: 'M12 19V7 M7 11l5-5 5 5 M5 21h14',
  diff_commit: 'M12 3v6 M12 15v6 M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  submit_diagnosis: 'M5 12l5 5 9-10',
  // Legend
  ghost: 'M6 21V10a6 6 0 0 1 12 0v11l-3-2-3 2-3-2z M10 10h.01 M14 10h.01',
  fog: 'M3 8h12 M6 12h15 M3 16h10 M9 20h9',
  darkroom: 'M4 4h16v16H4z M9 9h6v6H9z',
  lantern: 'M9 3h6 M8 6h8v11H8z M10 21h4 M12 9v5',
  mist: 'M7 18a4 4 0 0 1 1-7.9A5 5 0 0 1 17.5 11 3.5 3.5 0 0 1 17 18z',
  dust: 'M6 8h.01 M12 5h.01 M17 9h.01 M9 13h.01 M15 15h.01 M7 18h.01 M18 19h.01',
  incident: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  // Replay controls
  play: 'M8 5l11 7-11 7z',
  pause: 'M8 5v14 M16 5v14',
  prev: 'M6 5v14 M19 5l-9 7 9 7z',
  next: 'M18 5v14 M5 5l9 7-9 7z',
  speed: 'M4 18a8 8 0 1 1 16 0 M12 18l4-6',
  back: 'M4 11l8-7 8 7 M6 10v10h12V10',
  // Sound button: a speaker with waves (on) and a speaker with a cross (off)
  speaker: 'M4 9v6h4l5 4V5L8 9H4z M16.5 9a4 4 0 0 1 0 6 M19 6.5a8 8 0 0 1 0 11',
  'speaker-off': 'M4 9v6h4l5 4V5L8 9H4z M17 9l5 6 M22 9l-5 6',
  // The neutral glyph for a name with no icon
  dot: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
} as const;
export type IconName = keyof typeof PATHS;
export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const path = (PATHS as Record<string, string>)[name] ?? PATHS.dot;
  return (
    <svg className="icon" aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}
