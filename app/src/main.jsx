import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// Restore a saved light/dark choice before the first paint (?theme= previews one).
try {
  const q = new URLSearchParams(location.search).get("theme");
  const saved = q || localStorage.getItem("arra.theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {
  /* storage can be unavailable */
}


createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
