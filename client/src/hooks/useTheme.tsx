import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

// Ported from life-archive-app's theme system - see client/src/styles.css for the
// token definitions of each.
export type Theme = "light" | "dark" | "dusk" | "gallery";

export const THEMES: Theme[] = ["light", "dark", "dusk", "gallery"];

const STORAGE_KEY = "memorylane-theme";
const DEFAULT_THEME: Theme = "light";

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return (THEMES as string[]).includes(stored ?? "") ? (stored as Theme) : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage unavailable (private browsing, etc.) - theme still applies for this session.
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
