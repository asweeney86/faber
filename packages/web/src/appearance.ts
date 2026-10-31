import { appearanceController, type Appearance } from "@faber/shared";
import { createContext, useContext, useEffect, useState } from "react";

/**
 * The page's appearance. Applies the cached choice before the first render (no
 * flash), then the daemon's saved setting once it loads; follows the OS for "system".
 */
export const appearance = appearanceController({
  root: document.documentElement,
  storage: safeStorage(),
  media: typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null,
});

function safeStorage() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export const AppearanceContext = createContext<{ value: Appearance; set: (a: Appearance) => void }>({
  value: appearance.get(),
  set: (a) => appearance.set(a),
});

export function useAppearanceState() {
  const [value, setValue] = useState(appearance.get());
  useEffect(() => appearance.subscribe(() => setValue(appearance.get())), []);
  return { value, set: (a: Appearance) => appearance.set(a) };
}

export const useAppearance = () => useContext(AppearanceContext);
