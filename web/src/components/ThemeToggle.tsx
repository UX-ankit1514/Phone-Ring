import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import {
  applyTheme,
  prefersDark,
  readThemePreference,
  writeThemePreference,
  type ResolvedTheme,
} from "../theme";

/**
 * Light/dark switch.
 *
 * Until someone picks a side the page follows the operating system and keeps
 * following it, so a phone that flips to dark at sunset takes this page with it.
 * The first explicit choice pins the theme and is remembered per browser.
 */
export function ThemeToggle() {
  const [preference, setPreference] = useState(readThemePreference);
  const [systemIsDark, setSystemIsDark] = useState(prefersDark);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolved: ResolvedTheme =
    preference === "system" ? (systemIsDark ? "dark" : "light") : preference;

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  function toggle() {
    const next: ResolvedTheme = resolved === "dark" ? "light" : "dark";
    setPreference(next);
    writeThemePreference(next);
  }

  const label = resolved === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button className="theme-toggle" onClick={toggle} title={label} aria-label={label}>
      {resolved === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </button>
  );
}
