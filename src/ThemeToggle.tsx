import { useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "dark" | "light";
const storageKey = "folio-theme";

export function savedTheme(): Theme {
  try {
    if (localStorage.getItem(storageKey) === "light") return "light";
  } catch {
    // Theme switching still works when storage is unavailable.
  }
  return "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0e0e0f" : "#faf9f5");
}

export function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme !== "light",
  );
  return (
    <button
      type="button"
      className="icon theme-toggle"
      aria-label="黑色主题"
      aria-pressed={dark}
      title={dark ? "切换到浅色主题" : "切换到黑色主题"}
      onClick={() => {
        const next = dark ? "light" : "dark";
        applyTheme(next);
        setDark(!dark);
        try {
          localStorage.setItem(storageKey, next);
        } catch {
          // The change still applies to this page.
        }
      }}
    >
      {dark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
