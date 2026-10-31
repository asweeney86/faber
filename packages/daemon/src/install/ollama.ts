/** Getting Ollama running and the default models pulled, for `faber setup`. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { totalmem } from "node:os";

export const DEFAULT_ENRICH_MODEL = "qwen3:8b";
/** For machines with under 16 GB of memory, where qwen3:8b would swap. */
export const SMALL_ENRICH_MODEL = "qwen3:4b";

/** The enrichment model that suits this much memory (bytes). */
export function recommendedEnrichModel(memBytes = totalmem()): string {
  return memBytes < 15.5 * 1024 ** 3 ? SMALL_ENRICH_MODEL : DEFAULT_ENRICH_MODEL;
}

export type OllamaInstall =
  | { kind: "app" } // Ollama.app (the download from ollama.com, or the Homebrew cask)
  | { kind: "brew"; brew: string } // the Homebrew formula
  | { kind: "cli" } // an `ollama` binary from somewhere else
  | { kind: "missing"; brew: string | null };

function which(cmd: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

export function findBrew(): string | null {
  for (const p of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"]) if (existsSync(p)) return p;
  return which("brew");
}

export function detectOllama(): OllamaInstall {
  const brew = findBrew();
  if (process.platform === "darwin" && (existsSync("/Applications/Ollama.app") || existsSync(`${process.env.HOME}/Applications/Ollama.app`))) return { kind: "app" };
  if (brew && spawnSync(brew, ["list", "--formula", "ollama"], { stdio: "ignore" }).status === 0) return { kind: "brew", brew };
  if (which("ollama")) return { kind: "cli" };
  return { kind: "missing", brew };
}

/** Start an installed Ollama in the background. Returns false when we can't do it for the user. */
export function startOllama(install: OllamaInstall): boolean {
  switch (install.kind) {
    case "app":
      return spawnSync("open", ["-g", "-a", "Ollama"], { stdio: "ignore" }).status === 0;
    case "brew":
      return spawnSync(install.brew, ["services", "start", "ollama"], { stdio: "ignore" }).status === 0;
    default:
      return false;
  }
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, everyMs = 500): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await Bun.sleep(everyMs);
  }
  return check();
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/** Pull a model through Ollama's API, reporting progress as it streams. */
export async function pullModel(baseUrl: string, model: string, onProgress: (p: PullProgress) => void): Promise<void> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama couldn't pull ${model}: ${res.status} ${await res.text().catch(() => "")}`);
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as PullProgress & { error?: string };
      if (msg.error) throw new Error(`Ollama couldn't pull ${model}: ${msg.error}`);
      onProgress(msg);
    }
  }
}

export const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
