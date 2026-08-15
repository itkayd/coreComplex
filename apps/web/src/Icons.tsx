/**
 * The icon set, drawn here rather than fetched.
 *
 * WHY NOT AN ICON LIBRARY. Three reasons, and the third is the real one.
 * A CDN is impossible: `default-src 'self'` blocks every external request, and
 * relaxing the CSP to decorate buttons would be a bad trade. An npm icon package
 * would add a dependency and, in most cases, ship a few hundred glyphs to
 * deliver a dozen. And an icon is part of the interface's voice — these are
 * drawn on one grid, with one stroke weight, so the set reads as one hand.
 *
 * All of them are single-path or few-path strokes on a 24×24 grid, 1.75 units
 * wide, round caps and joins, `currentColor` throughout — so an icon inherits
 * the colour of whatever it sits in and needs no dark-mode variant.
 *
 * ACCESSIBILITY. Every icon here is `aria-hidden`. Not one of them carries
 * meaning alone: each sits beside a real text label, which is what a screen
 * reader announces and what makes the interface usable when an icon's metaphor
 * does not land. If an icon ever becomes the only signal, it needs a label —
 * and it would be better to add the text.
 */
import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "home" | "words" | "progress" | "settings"
  | "play" | "stop" | "sound" | "slower"
  | "listening" | "reading" | "speaking" | "writing"
  | "lock" | "check" | "cross" | "question" | "spark" | "cloud" | "shield" | "download" | "trash";

const base: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
};

const PATHS: Record<IconName, ReactNode> = {
  // Navigation
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9.5V21h13V9.5" /><path d="M9.5 21v-6h5v6" /></>,
  words: <><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" /><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" /></>,
  progress: <><path d="M4 19V10M10 19V5M16 19v-6M22 19H2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>,

  // Audio. A speaker with waves; the waves are what distinguishes "sound" from
  // "play", and the count of them from "slower".
  play: <><path d="M8 5.5v13l11-6.5z" /></>,
  stop: <><rect x="7" y="7" width="10" height="10" rx="1.5" /></>,
  sound: <><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" /><path d="M18 7a7 7 0 0 1 0 10" /></>,
  slower: <><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" /><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" /></>,

  // The four skills, each a distinct silhouette so colour is never the only cue.
  listening: <><path d="M5 12a7 7 0 0 1 14 0" /><path d="M5 12v3.5a2.5 2.5 0 0 0 5 0V13H5" /><path d="M19 12v3.5a2.5 2.5 0 0 1-5 0V13h5" /></>,
  reading: <><path d="M3 6.5c3-1.5 6-1.5 9 0 3-1.5 6-1.5 9 0v12c-3-1.5-6-1.5-9 0-3-1.5-6-1.5-9 0z" /><path d="M12 6.5v12" /></>,
  speaking: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 12a6.5 6.5 0 0 0 13 0" /><path d="M12 18.5V21" /></>,
  writing: <><path d="M4 20.5 4.9 17 16.4 5.5a2 2 0 0 1 2.8 2.8L7.7 19.8z" /><path d="M14.8 7.1 17.5 9.8" /></>,

  // States
  lock: <><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /><path d="M12 14.5v2.5" /></>,
  check: <><path d="M4.5 12.5 9.5 17.5 19.5 6.5" /></>,
  cross: <><path d="M6 6l12 12M18 6 6 18" /></>,
  question: <><circle cx="12" cy="12" r="9" /><path d="M9.3 9.3a2.8 2.8 0 0 1 5.4.9c0 1.9-2.7 2.3-2.7 4" /><path d="M12 17.5v.01" /></>,
  spark: <><path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7L4.5 10.9 10.1 9z" /></>,
  cloud: <><path d="M7 18.5a4 4 0 0 1-.3-8A6 6 0 0 1 18 11.4a3.6 3.6 0 0 1-.6 7.1z" /></>,
  shield: <><path d="M12 3l7.5 3v6c0 4.4-3.1 7.9-7.5 9.5C7.6 19.9 4.5 16.4 4.5 12V6z" /></>,
  download: <><path d="M12 4v10" /><path d="M8 10.5 12 14.5l4-4" /><path d="M5 19h14" /></>,
  trash: <><path d="M5 7h14" /><path d="M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7" /><path d="M6.5 7l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" /></>,
};

export interface IconProps {
  name: IconName;
  /** Rendered size in px. The stroke is not rescaled, so the set stays even. */
  size?: number;
  className?: string;
}

export function Icon({ name, size = 22, className }: IconProps) {
  return <svg {...base} width={size} height={size} className={className}>{PATHS[name]}</svg>;
}
