import { createRoot } from "react-dom/client";
import "../lib/appearance"; // paints the cached theme before the first render
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
