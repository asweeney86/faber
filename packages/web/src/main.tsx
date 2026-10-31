import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./appearance"; // applies the theme before the first paint
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
