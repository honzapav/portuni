export type Theme = "dark" | "light";

// The 16 ANSI colors xterm uses for SGR-colored output (diffs, agent
// spinners, syntax). xterm's built-in defaults are tuned for a dark
// background; on the light theme's near-white bg the bright defaults
// vanish. We supply an explicit palette per mode so diff +/- lines and
// code stay readable in both. Keys match xterm's ITheme exactly.
export type AnsiPalette = {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export type ThemeColors = {
  bg: string;
  text: string;
  textMuted: string;
  accent: string;
  edgeBase: string;
  edgeStructural: string;
  orgFill: string;
  orgFillOpacity: number;
  labelBgOpacity: number;
  nodeColors: Record<string, string>;
  nodeColorDefault: string;
  ansi: AnsiPalette;
};

const DARK_THEME: ThemeColors = {
  bg: "#0a0b0d",
  text: "#e8e9eb",
  textMuted: "#9ca0a8",
  accent: "#76d9ff",
  edgeBase: "#8b8f97",
  edgeStructural: "#c7cbd1",
  orgFill: "#141518",
  orgFillOpacity: 0.5,
  labelBgOpacity: 0.78,
  nodeColors: {
    organization: "#76d9ff",
    project: "#a78bfa",
    process: "#fbbf24",
    area: "#f472b6",
    principle: "#34d399",
  },
  nodeColorDefault: "#94a3b8",
  ansi: {
    black: "#1e2127",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#d1d5db",
    brightBlack: "#6b7280",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#f9fafb",
  },
};

const LIGHT_THEME: ThemeColors = {
  bg: "#f8fafc",
  text: "#0f172a",
  textMuted: "#475569",
  accent: "#0284c7",
  edgeBase: "#64748b",
  edgeStructural: "#334155",
  orgFill: "#ffffff",
  orgFillOpacity: 0.85,
  labelBgOpacity: 0,
  nodeColors: {
    organization: "#0891b2",
    project: "#7c3aed",
    process: "#d97706",
    area: "#db2777",
    principle: "#059669",
  },
  nodeColorDefault: "#64748b",
  ansi: {
    black: "#0f172a",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#b45309",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#475569",
    brightBlack: "#334155",
    brightRed: "#b91c1c",
    brightGreen: "#15803d",
    brightYellow: "#a16207",
    brightBlue: "#1d4ed8",
    brightMagenta: "#7e22ce",
    brightCyan: "#0e7490",
    brightWhite: "#1e293b",
  },
};

export const THEMES: Record<Theme, ThemeColors> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
};

const STORAGE_KEY = "portuni:theme";

export function loadTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return "dark";
}

export function saveTheme(theme: Theme): void {
  window.localStorage.setItem(STORAGE_KEY, theme);
}
