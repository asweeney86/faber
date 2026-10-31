/**
 * The daemon listens on localhost and holds confidential document text, so any
 * web page the user visits must not be able to read or change it. Two checks:
 *
 * - Host header must be a loopback name. Defeats DNS rebinding, where evil.com
 *   is re-pointed at 127.0.0.1 so the browser treats our API as same-origin.
 * - Browser requests must come from the web UI itself or a Chrome extension.
 *   Cross-site requests carry an Origin (or Sec-Fetch-Site) header we reject.
 *   Extensions must additionally be paired (approved by the user), since any
 *   installed extension can reach localhost — see core/src/extensions.ts.
 *
 * Requests without either header (curl, the CLI, tests) are allowed: anything
 * that can make them already runs on this machine.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface SecurityOptions {
  port: number;
}

/** The extension id from a chrome-extension:// origin, else null. */
export function extensionIdOf(origin: string | null): string | null {
  if (!origin?.startsWith("chrome-extension://")) return null;
  try {
    return new URL(origin).hostname || null;
  } catch {
    return null;
  }
}

function hostOf(hostHeader: string): string {
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0]!;
}

export function hostAllowed(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return true;
  return LOOPBACK.has(hostOf(host).toLowerCase());
}

export function originAllowed(origin: string, opts: SecurityOptions): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  // Extensions pass this check; whether a given extension may use the API is decided by pairing.
  if (u.protocol === "chrome-extension:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname) && Number(u.port || 80) === opts.port;
}

export type Verdict = { ok: true; origin: string | null } | { ok: false; reason: string };

export function checkRequest(req: Request, opts: SecurityOptions): Verdict {
  if (!hostAllowed(req)) return { ok: false, reason: "host not allowed" };
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    return originAllowed(origin, opts) ? { ok: true, origin } : { ok: false, reason: `origin ${origin} not allowed` };
  }
  if (origin === "null") return { ok: false, reason: "opaque origin not allowed" };
  // A privileged browser context (an extension page or worker with host permission for
  // 127.0.0.1) sends GETs with no Origin and Sec-Fetch-Site: none. We couldn't tell which
  // extension it is, so it could read everything without being approved: refuse. Our own
  // extension sends reads as POST + x-faber-method: GET, which carries its Origin.
  // (Typing an API URL in the address bar is a navigation and still works.)
  if (req.headers.get("sec-fetch-site") === "none" && req.headers.get("sec-fetch-mode") !== "navigate") {
    return { ok: false, reason: "browser extensions must identify themselves with an Origin (send reads as POST with x-faber-method: GET)" };
  }
  // No Origin: same-origin GET navigations, curl, or a cross-site no-cors GET (which can't read the response).
  // Still refuse explicit cross-site fetches.
  if (req.headers.get("sec-fetch-site") === "cross-site" && req.method !== "GET") return { ok: false, reason: "cross-site request" };
  return { ok: true, origin: null };
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-faber-method",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

/** Header that turns a POST into the GET it stands for (see checkRequest). */
export const METHOD_OVERRIDE_HEADER = "x-faber-method";

/** The method to route by: a POST carrying x-faber-method: GET is a read. Nothing else can be overridden. */
export function effectiveMethod(req: Request): string {
  if (req.method === "POST" && req.headers.get(METHOD_OVERRIDE_HEADER)?.toUpperCase() === "GET") return "GET";
  return req.method;
}
