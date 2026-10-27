// Colour theme. Change DEFAULT_THEME to switch the whole app.
export const THEMES = ["onyx", "graphite", "champagne", "blackcard"];
export const DEFAULT_THEME = "onyx";

export function applyTheme() {
  let theme = DEFAULT_THEME;
  try {
    const q = new URLSearchParams(location.search).get("theme");
    if (THEMES.includes(q)) theme = q;
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#111111";
}
