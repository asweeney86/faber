import { appearanceController } from "@faber/shared";

/**
 * Extension pages (popup, options, launcher) share one origin, so they share the
 * localStorage cache: the theme paints immediately, then follows the daemon's setting.
 */
export const appearance = appearanceController({
  root: document.documentElement,
  storage: (() => {
    try {
      return localStorage;
    } catch {
      return null;
    }
  })(),
  media: typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null,
});
