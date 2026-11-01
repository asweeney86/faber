import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** "fake" is deterministic and offline: for tests, demos and CI. */
export type ProviderKind = "ollama" | "openai-compatible" | "anthropic" | "claude-cli" | "fake";

export interface ProviderConfig {
  provider: ProviderKind;
  model: string;
  /** Base URL for ollama / openai-compatible. */
  base_url?: string;
  /** API key for openai-compatible / anthropic. Env var names are also accepted ("$OPENAI_API_KEY"). */
  api_key?: string;
}

export interface Config {
  home: string;
  db_path: string;
  daemon: {
    host: string;
    port: number;
    /** Extension ids pre-approved without pairing; others need approval (core/src/extensions.ts). */
    allowed_extension_ids: string[];
  };
  embed: ProviderConfig;
  enrich: ProviderConfig;
  /** Model used by Ask mode. Defaults to the enrich provider when omitted. */
  ask?: ProviderConfig;
  privacy: {
    /** Hard stop: when false, any provider that is not localhost is refused. */
    allow_remote: boolean;
  };
  enrichment: {
    /** Max characters of document text sent to the enrichment model. */
    max_chars: number;
    /** Concurrent enrichment jobs. Local models want 1. */
    concurrency: number;
  };
  search: {
    /** Characters per embedding chunk. */
    chunk_chars: number;
    /** Max chunks embedded per document (first N). */
    max_chunks_per_doc: number;
    /** Override the embedder's similarity floor for semantic matches (0..1). */
    min_semantic?: number;
  };
}

export const DEFAULT_CONFIG_TOML = `# Faber configuration
# Docs: https://github.com/asweeney86/faber

[daemon]
host = "127.0.0.1"
port = 7777
# Extension ids pre-approved without pairing. Any other extension must be
# approved in Settings → Browser extensions or with: faber extensions approve <id>
allowed_extension_ids = []

# Embeddings power semantic search. Keep this local. Change the model in
# Settings → AI & Processing (or \`faber models\`): documents are then re-indexed
# in the background. "qwen3-embedding" (8B) is more accurate and ~15× slower.
[embed]
provider = "ollama"
model = "qwen3-embedding:0.6b"
base_url = "http://127.0.0.1:11434"

# Enrichment writes the summary, doc type, people, projects and tags.
# Swap providers freely; every enrichment row records which model made it.
# "qwen3:8b" gives a little more detail and is about twice as slow.
[enrich]
provider = "ollama"
model = "qwen3:4b"
base_url = "http://127.0.0.1:11434"

# Examples:
# [enrich]
# provider = "anthropic"
# model = "claude-opus-5-5"
# api_key = "$ANTHROPIC_API_KEY"
#
# [enrich]
# provider = "openai-compatible"      # LM Studio, vLLM, OpenRouter, Groq...
# model = "qwen/qwen3-32b"
# base_url = "https://openrouter.ai/api/v1"
# api_key = "$OPENROUTER_API_KEY"
#
# [enrich]
# provider = "claude-cli"             # uses your Claude Code login, no key needed
# model = "sonnet"

# Ask mode (question answering over your docs) uses the enrich model unless set:
# [ask]
# provider = "anthropic"
# model = "claude-opus-5-5"
# api_key = "$ANTHROPIC_API_KEY"

[privacy]
# When false, the daemon refuses to send document text to any non-localhost provider.
allow_remote = false

[enrichment]
# The start of a document says what it is; reading more mostly costs time.
max_chars = 12000
concurrency = 1

[search]
chunk_chars = 1500
max_chunks_per_doc = 16
# Semantic matches below this cosine similarity are dropped as noise. The
# default is tuned per model (0.47 for qwen3-embedding:0.6b, 0.48 otherwise);
# lower it if search misses things, raise it if unrelated docs show up.
# min_semantic = 0.47
`;

function deepMerge<T extends Record<string, unknown>>(base: T, over: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object") {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function configHome(): string {
  return process.env.FABER_HOME ?? join(homedir(), ".faber");
}

export const DB_FILE = "faber.sqlite";
/** Where data lived before the project was renamed from Power Bookmark to Faber. */
export const LEGACY_HOME = join(homedir(), ".powerbookmark");
const LEGACY_DB_FILE = "powerbookmark.sqlite";

/**
 * Move a pre-rename data directory (~/.powerbookmark, powerbookmark.sqlite) to the
 * new home, once. Runs only when the new home has no database yet, so it never
 * overwrites Faber data. The SQLite -wal/-shm files are renamed with the database.
 * Returns true when something was moved.
 */
export function migrateLegacyHome(home: string, legacy = LEGACY_HOME): boolean {
  if (!existsSync(join(legacy, LEGACY_DB_FILE)) || existsSync(join(home, DB_FILE))) return false;
  mkdirSync(home, { recursive: true });
  for (const name of readdirSync(legacy)) {
    const target = join(home, name.startsWith(LEGACY_DB_FILE) ? DB_FILE + name.slice(LEGACY_DB_FILE.length) : name);
    // A config.toml written by a first run of the new name is just the default: the old one wins.
    const isFreshDefault = name === "config.toml" && existsSync(target) && readFileSync(target, "utf8") === DEFAULT_CONFIG_TOML;
    if (!existsSync(target) || isFreshDefault) renameSync(join(legacy, name), target);
  }
  if (readdirSync(legacy).length === 0) rmdirSync(legacy);
  return true;
}

export function defaultConfig(home: string): Config {
  const defaults = parseToml(DEFAULT_CONFIG_TOML) as unknown as Omit<Config, "home" | "db_path">;
  return { ...defaults, home, db_path: join(home, DB_FILE) };
}

/** Load ~/.faber/config.toml, writing the commented default on first run. */
export function loadConfig(): Config {
  const home = configHome();
  if (!process.env.FABER_HOME && migrateLegacyHome(home)) console.error(`Moved your data from ${LEGACY_HOME} to ${home} (Power Bookmark is now Faber).`);
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const path = join(home, "config.toml");
  if (!existsSync(path)) writeFileSync(path, DEFAULT_CONFIG_TOML);
  let user: Record<string, unknown>;
  try {
    user = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    // smol-toml's errors carry the position; put it where editors and terminals understand it.
    const at = e && typeof e === "object" && "line" in e && "column" in e ? `:${(e as { line: number }).line}:${(e as { column: number }).column}` : "";
    throw new ConfigError(`${path}${at}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  const defaults = defaultConfig(home) as unknown as Record<string, Record<string, unknown>>;
  // A section that switches provider must not inherit the default Ollama base_url.
  for (const section of ["embed", "enrich"]) {
    const u = user[section] as Record<string, unknown> | undefined;
    if (u?.provider && u.provider !== defaults[section]!.provider && u.base_url === undefined) delete defaults[section]!.base_url;
  }
  const cfg = deepMerge(defaults, user) as unknown as Config;
  if (process.env.FABER_DB_PATH) cfg.db_path = process.env.FABER_DB_PATH;
  validateConfig(cfg, path);
  return cfg;
}

export class ConfigError extends Error {}

const PROVIDERS: ProviderKind[] = ["ollama", "openai-compatible", "anthropic", "claude-cli", "fake"];

/** Fail loudly on wrong types: e.g. allow_remote = "false" (a string) must not silently mean true. */
export function validateConfig(cfg: Config, path = "config.toml") {
  const fail = (msg: string) => {
    throw new ConfigError(`${path}: ${msg}`);
  };
  if (typeof cfg.privacy?.allow_remote !== "boolean") fail("privacy.allow_remote must be true or false (no quotes)");
  if (!Number.isInteger(cfg.daemon.port) || cfg.daemon.port < 0 || cfg.daemon.port > 65535) fail("daemon.port must be an integer port");
  if (typeof cfg.daemon.host !== "string") fail("daemon.host must be a string");
  // The API trusts loopback: binding elsewhere would expose every document to the network.
  if (!["127.0.0.1", "localhost", "::1"].includes(cfg.daemon.host)) {
    fail(`daemon.host must be a loopback address (127.0.0.1, localhost or ::1), not "${cfg.daemon.host}": the API has no authentication`);
  }
  if (!Array.isArray(cfg.daemon.allowed_extension_ids) || cfg.daemon.allowed_extension_ids.some((x) => typeof x !== "string")) {
    fail("daemon.allowed_extension_ids must be a list of strings");
  }
  for (const [name, pc] of [["embed", cfg.embed], ["enrich", cfg.enrich], ["ask", cfg.ask]] as const) {
    if (pc === undefined && name === "ask") continue;
    if (!pc || !PROVIDERS.includes(pc.provider)) fail(`${name}.provider must be one of ${PROVIDERS.join(", ")}`);
    if (typeof pc!.model !== "string" || !pc!.model) fail(`${name}.model is required`);
  }
  for (const k of ["max_chars", "concurrency"] as const) {
    if (!Number.isInteger(cfg.enrichment[k]) || cfg.enrichment[k] < 1) fail(`enrichment.${k} must be a positive integer`);
  }
  for (const k of ["chunk_chars", "max_chunks_per_doc"] as const) {
    if (!Number.isInteger(cfg.search[k]) || cfg.search[k] < 1) fail(`search.${k} must be a positive integer`);
  }
  const ms = cfg.search.min_semantic;
  if (ms !== undefined && (typeof ms !== "number" || ms < -1 || ms > 1)) fail("search.min_semantic must be a number between -1 and 1");
}

/** Resolve "$ENV_VAR" style api_key values. */
export function resolveApiKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("$")) return process.env[value.slice(1)];
  return value;
}

export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Set `key = value` in one [section] of a config file, keeping every comment and
 * other line as written. Adds the key (or the section) when it isn't there.
 * Commented-out examples ("# [enrich]") are left alone.
 */
export function setConfigValue(text: string, section: string, key: string, value: string | number | boolean): string {
  const rendered = `${key} = ${typeof value === "string" ? JSON.stringify(value) : String(value)}`;
  const lines = text.split("\n");
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(`^\\s*\\[\\s*${esc(section)}\\s*\\]\\s*(#.*)?$`);
  const header = lines.findIndex((l) => headerRe.test(l));
  if (header === -1) {
    const tail = text.endsWith("\n") || text === "" ? "" : "\n";
    return `${text}${tail}\n[${section}]\n${rendered}\n`;
  }
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*(#.*)?$/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  for (let i = header + 1; i < end; i++) {
    if (keyRe.test(lines[i]!)) {
      lines[i] = rendered;
      return lines.join("\n");
    }
  }
  lines.splice(header + 1, 0, rendered);
  return lines.join("\n");
}
