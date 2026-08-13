import { createContext, useContext, useState, useCallback } from "react";

type Theme = "dark" | "light";
type Ctx = { theme: Theme; toggle: () => void };

const ThemeCtx = createContext<Ctx>({ theme: "dark", toggle: () => {} });
export const useTheme = () => useContext(ThemeCtx);

function apply(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = (localStorage.getItem("apm-theme") as Theme) || "dark";
    apply(saved);
    return saved;
  });
  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      apply(next);
      localStorage.setItem("apm-theme", next);
      return next;
    });
  }, []);
  return <ThemeCtx.Provider value={{ theme, toggle }}>{children}</ThemeCtx.Provider>;
}
