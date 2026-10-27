import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { platform } from "./platform";
import { installGlide } from "./ui/glide";
import { applyTheme, chosenTheme } from "./ui/theme";
import "./styles.css";

// One page per window (shell.rs): "main" is the capture bar, "overlay" the frame (and countdown)
// over what is recorded, "editor" the full window for the library and takes.
const Bar = lazy(() => import("./ui/Bar"));
const Overlay = lazy(() => import("./ui/Overlay"));
const Editor = lazy(() => import("./App"));
const label = platform.windowLabel();
const Page = label === "overlay" ? Overlay : label === "editor" ? Editor : Bar;
if (label !== "editor") document.documentElement.dataset.overlay = label;
installGlide();
// The chosen theme before the first paint, and later changes made in another window.
applyTheme(chosenTheme());
void platform.theme.onChange((t) => applyTheme(t));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
);
