export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** Shared with the inline script in index.html, which applies the theme before React boots. */
const STORAGE_KEY = "arnifi.theme";

const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: "#e7e7f4",
  dark: "#0b0b1a",
};

/**
 * Reading and writing the choice is wrapped because storage throws in private
 * windows and when site data is blocked. A phone that cannot remember the
 * preference should still render, just on the system default.
 */
export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* storage unavailable */
  }
}

export function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLOR[theme]);
}
