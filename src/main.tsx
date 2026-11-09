import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/dm-sans";
import "@fontsource/lora/400.css";
import "@fontsource/lora/500.css";
import "./styles.css";
import "./responsive.css";
import "./setup.css";
import "./workspace.css";
import "./theme.css";
import { App } from "./App";
import { applyTheme, savedTheme } from "./ThemeToggle";
const wallpapers = import.meta.glob<string>("./assets/folio-wallpaper.png", {
  eager: true,
  import: "default",
  query: "?url",
});
const wallpaper = wallpapers["./assets/folio-wallpaper.png"];
if (wallpaper) {
  document.documentElement.dataset.wallpaper = "";
  document.documentElement.style.setProperty("--folio-wallpaper", "url(" + JSON.stringify(wallpaper) + ")");
}
applyTheme(savedTheme());
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
