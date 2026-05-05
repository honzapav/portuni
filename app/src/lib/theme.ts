export type Theme = "dark" | "light";

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
