import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Reads an "env" key from settings.json and sets the values
 * as process environment variables at startup.
 *
 * Honors pi's settings hierarchy: project-level (.pi/settings.json)
 * overrides global (~/.pi/agent/settings.json). Both are merged.
 * Global settings are applied at load; project settings only once pi
 * has resolved project trust (session_start), never for untrusted repos.
 *
 * Supports $ENV_VAR and ${ENV_VAR} interpolation to reference
 * pre-existing environment variables, matching pi's own value
 * resolution syntax. $$ escapes to a literal $, $! to a literal !
 * (so a value may start with "!" without being run as a command).
 *
 * Example settings.json:
 * {
 *   "env": {
 *     "ANTHROPIC_API_KEY": "$MY_SECRET_KEY",
 *     "OPENROUTER_API_KEY": "!secret_manager openrouter/key",
 *     "OPENAI_API_KEY": "sk-...",
 *     "GOOGLE_CLOUD_PROJECT": "my-project",
 *     "GOOGLE_CLOUD_LOCATION": "us-central1",
 *     "PORT": 8080
 *   }
 * }
 *
 * Values may be strings, numbers, or booleans. Non-string
 * scalars are coerced via String(). Objects/arrays are ignored
 * with a warning.
 *
 * All "!command" values run in parallel, so startup waits for the slowest
 * one rather than the sum. Consequence: a command may reference variables
 * from the shell environment, but not keys defined in the same "env" block.
 */

const execAsync = promisify(exec);

const ENV_VAR_PATTERN = /\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONFIG_KEY = "env";
const MESSAGE_TYPE = "pi-env";
const TRACKER_KEY = "_PI_EXT_ENV_KEYS";
const OVERRIDES_KEY = "_PI_EXT_ENV_OVERRIDES";
// Never settable from project scope: code loaders, shell startup hooks, and
// network/TLS redirection give a repo code execution or credential exfil even
// without "!command". Global settings are unaffected.
const PROJECT_DENYLIST =
  /^(HOME|USERPROFILE|XDG_.*|PI_.*|.*_CODING_AGENT_DIR|EDITOR|VISUAL|GCE_METADATA_.*|AWS_(CONFIG_FILE|SHARED_CREDENTIALS_FILE)|GOOGLE_APPLICATION_CREDENTIALS|OPENSSL_(CONF|MODULES)|SSLKEYLOGFILE|GIT_ASKPASS|SSH_ASKPASS|PATH|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|LD_(PRELOAD|LIBRARY_PATH|AUDIT)|DYLD_.*|BASH_ENV|ENV|ZDOTDIR|SHELL|PERL5OPT|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|JAVA_TOOL_OPTIONS|GIT_(SSH_COMMAND|SSH|EXEC_PATH|CONFIG.*)|SSL_CERT_(FILE|DIR)|.*_PROXY|.*_BASE_URL|.*_ENDPOINT_URL.*|_PI_EXT_ENV_.*)$/i;

// "!command" outcomes (success or failure) are cached for the process
// lifetime, matching pi's own resolver. Without this, load + session_start
// would run every command twice and non-idempotent ones (e.g. `!openssl rand`)
// would yield different values. /reload re-evaluates the module and so resets it.
interface CommandOutcome {
  resolved?: string;
  failed?: string;
}
const commandCache = new Map<string, CommandOutcome>();

interface EnvReport {
  source: string;
  variables: Record<string, string>;
}

interface EnvResult {
  reports: EnvReport[];
  unresolvedVars: string[];
  overriddenVars: string[];
  nonScalarKeys: string[];
  invalidKeys: string[];
  blockedCommandKeys: string[];
  failedCommandKeys: string[];
  deniedKeys: string[];
}

// `hidden` keys read as unset: they hold values from a previous load that must
// not feed into this one (see applyEnv).
function interpolate(value: string, missing: string[], hidden: Set<string>): string {
  return value.replace(ENV_VAR_PATTERN, (match, braced, bare) => {
    if (match === "$$") return "$";
    if (match === "$!") return "!";
    const varName = braced ?? bare;
    const resolved = hidden.has(varName) ? undefined : process.env[varName];
    if (resolved === undefined) missing.push(varName);
    return resolved ?? "";
  });
}

// Runs one "!command" with an explicit environment. Resolves to { resolved }
// on success or { failed } with a short reason. Never rejects.
async function runCommand(command: string, env: NodeJS.ProcessEnv): Promise<CommandOutcome> {
  const cached = commandCache.get(command);
  if (cached) return cached;
  let outcome: CommandOutcome;
  try {
    const pending = execAsync(command, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, env });
    // No stdin: a command that prompts would otherwise hang until the timeout.
    pending.child.stdin?.end();
    const { stdout } = await pending;
    outcome = { resolved: stdout.trim() };
  } catch (err) {
    // Report by key, not command: the interpolated command may contain secrets.
    outcome = { failed: failureReason(err) };
  }
  commandCache.set(command, outcome);
  return outcome;
}

// Short, single-line, control-char-free reason for a failed "!command".
function failureReason(err: unknown): string {
  const e = err as { code?: string | number; signal?: string | null; stderr?: string | Buffer };
  // exec() puts the exit status in `code` (number) and spawn errors as a string.
  let head = typeof e.code === "string" ? e.code : "error";
  if (e.signal) head = "timed out";
  else if (typeof e.code === "number") head = `exit ${e.code}`;
  const stderr = String(e.stderr ?? "")
    .split("\n")[0]
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 120);
  return stderr ? `${head}: ${stderr}` : head;
}

function extractEnv(settings: unknown): Record<string, unknown> | undefined {
  // Settings come from untyped JSON, so narrow before reading the "env" key.
  if (!settings || typeof settings !== "object") return undefined;
  const vars = (settings as Record<string, unknown>)[CONFIG_KEY];
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return undefined;
  return Object.keys(vars).length > 0 ? (vars as Record<string, unknown>) : undefined;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function readTracked(key: string): string[] {
  try {
    const parsed: unknown = process.env[key] ? JSON.parse(process.env[key]) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string" && KEY_PATTERN.test(k)) : [];
  } catch {
    return [];
  }
}

function writeTracked(key: string, values: string[]): void {
  if (values.length > 0) process.env[key] = JSON.stringify(values);
  else delete process.env[key];
}

// Resolved once at load, before any settings are applied. Later calls must not
// re-derive it from process.env (HOME, PI_CODING_AGENT_DIR), or a project could
// redirect the "global" scope, which is allowed to run "!command".
const AGENT_DIR = getAgentDir();

async function applyEnv(cwd: string, projectTrusted: boolean): Promise<EnvResult> {
  // SettingsManager.create() defaults projectTrusted to true and would read
  // .pi/settings.json before pi's own trust prompt. Pass the real decision so
  // an untrusted repo cannot set PATH/NODE_OPTIONS/*_BASE_URL in this process.
  const settingsManager = SettingsManager.create(cwd, AGENT_DIR, { projectTrusted });
  const sources = [
    { name: "global", vars: extractEnv(settingsManager.getGlobalSettings()), allowExec: true },
    { name: "project", vars: extractEnv(settingsManager.getProjectSettings()), allowExec: false },
  ];

  const previousKeys = readTracked(TRACKER_KEY);
  const previousOverrides = readTracked(OVERRIDES_KEY);

  // Snapshot before mutating: a key already present in the environment was put
  // there by something else, unless we set it on a previous load.
  const preExisting = new Set(
    sources
      .flatMap((source) => Object.keys(source.vars ?? {}))
      .filter((key) => process.env[key] !== undefined && !previousKeys.includes(key))
  );

  // Keys we set on a previous load are hidden from interpolation and from
  // command children until this pass re-applies them, so a project value from
  // the last pass can never feed a global "!command" (shell injection) or a
  // global $VAR reference. They stay in process.env meanwhile: deleting them up
  // front left every command-derived key unset for the duration of the pass.
  const hidden = new Set(previousKeys);

  const unresolvedVars: string[] = [];
  const nonScalarKeys: string[] = [];
  const invalidKeys: string[] = [];
  const blockedCommandKeys: string[] = [];
  const failedCommandKeys: string[] = [];
  const deniedKeys: string[] = [];
  const appliedKeys: string[] = [];
  const variablesBySource = sources.map(() => ({} as Record<string, string>));
  const commands: Array<{ key: string; command: string; variables: Record<string, string> }> = [];

  const apply = (key: string, resolved: string, variables: Record<string, string>) => {
    process.env[key] = resolved;
    hidden.delete(key);
    if (!appliedKeys.includes(key)) appliedKeys.push(key);
    variables[key] = resolved;
  };

  // Plain values apply synchronously, before any await, so other extensions'
  // deferred work sees them at the same moment it did with the sync code.
  // "!command" values are only collected. Later sources override earlier ones,
  // so project wins over global.
  const collect = (source: (typeof sources)[number], variables: Record<string, string>) => {
    if (!source.vars) return;
    for (const [key, value] of Object.entries(source.vars)) {
      if (!KEY_PATTERN.test(key)) {
        // Not identifier-shaped, so escape before it reaches the TUI/session file.
        invalidKeys.push(JSON.stringify(key));
        continue;
      }
      if (!isScalar(value)) {
        nonScalarKeys.push(key);
        continue;
      }
      if (!source.allowExec && PROJECT_DENYLIST.test(key)) {
        deniedKeys.push(key);
        continue;
      }
      const raw = String(value);
      const missing: string[] = [];
      // The leading "!" must be literal in settings: it is checked before
      // interpolation so an interpolated value can never become a command.
      if (!raw.startsWith("!")) {
        apply(key, interpolate(raw, missing, hidden), variables);
      } else if (!source.allowExec) {
        // Project settings ship inside repositories and are not a trusted
        // execution source. Leave the key untouched and warn.
        blockedCommandKeys.push(key);
      } else {
        commands.push({ key, command: interpolate(raw.slice(1), missing, hidden), variables });
      }
      unresolvedVars.push(...missing);
    }
  };

  // Phase 1: global values. Phase 2: spawn every global "!command" now, before
  // any project value touches process.env, with previous-load keys stripped, so
  // a project can never steer a global command through its environment (e.g.
  // VAULT_ADDR). Deduplicated by command string. Phase 1b: project values.
  collect(sources[0], variablesBySource[0]);
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !hidden.has(key)));
  const runs = new Map<string, Promise<CommandOutcome>>();
  for (const { command } of commands) {
    if (!runs.has(command)) runs.set(command, runCommand(command, childEnv));
  }
  collect(sources[1], variablesBySource[1]);
  await Promise.all(runs.values());

  // Phase 3: apply command results in settings order. A key a later source
  // already set keeps that value (project wins over global).
  for (const { key, command, variables } of commands) {
    const outcome = await runs.get(command);
    if (!outcome) continue;
    const { resolved, failed } = outcome;
    if (failed) {
      failedCommandKeys.push(`${key} (${failed})`);
      continue;
    }
    if (resolved === undefined) continue;
    variables[key] = resolved;
    if (!appliedKeys.includes(key)) apply(key, resolved, variables);
  }

  const reports: EnvReport[] = sources
    .map((source, i) => ({ source: source.name, variables: variablesBySource[i] }))
    .filter((report) => Object.keys(report.variables).length > 0);

  // Keys removed from settings since the last load.
  for (const key of previousKeys) {
    if (!appliedKeys.includes(key)) delete process.env[key];
  }

  const overriddenVars = appliedKeys.filter(
    (key) => preExisting.has(key) || previousOverrides.includes(key)
  );

  // Track current keys and overrides for reload persistence
  writeTracked(TRACKER_KEY, appliedKeys);
  writeTracked(OVERRIDES_KEY, overriddenVars);

  return {
    reports,
    unresolvedVars: [...new Set(unresolvedVars)],
    overriddenVars,
    nonScalarKeys: [...new Set(nonScalarKeys)],
    invalidKeys: [...new Set(invalidKeys)],
    blockedCommandKeys,
    failedCommandKeys,
    deniedKeys,
  };
}

// Values may be secrets and /env output is persisted in the session file.
function mask(value: string): string {
  return value.length > 8 ? "••••" + value.slice(-4) : "•".repeat(value.length);
}

function formatReport(
  theme: { fg(color: string, text: string): string },
  reports: EnvReport[]
): string {
  if (reports.length === 0) {
    return theme.fg("dim", "[env] No environment variables configured.");
  }

  let text = theme.fg("accent", "[env]") + "\n";
  for (const report of reports) {
    text += theme.fg("muted", `  ${report.source}`) + "\n";
    for (const [key, value] of Object.entries(report.variables)) {
      text += `    ${theme.fg("success", key)}${theme.fg("dim", "=")}${theme.fg("muted", mask(value))}\n`;
    }
  }
  return text.trimEnd();
}

// Async so "!command"s can run in parallel; pi awaits the factory before
// loading the next extension, so later extensions still see the final env.
export default async function (pi: ExtensionAPI): Promise<void> {
  // Apply global env vars immediately (before providers initialize). Project
  // settings are applied in session_start, once pi has resolved project trust.
  let startup = await applyEnv(process.cwd(), false);

  // Register styled message renderer
  pi.registerMessageRenderer(MESSAGE_TYPE, (message) => {
    let text = message.content;
    if (Array.isArray(text)) text = text.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    return new Text(text, 0, 0);
  });

  // Filter custom messages from LLM context
  pi.on("context", async (event) => ({
    messages: event.messages.filter(
      (message) => message.role !== "custom" || message.customType !== MESSAGE_TYPE
    ),
  }));

  // Register /env command. Read-only: shows the last applied state instead of
  // re-running "!command"s and re-mutating the environment. /reload re-applies.
  pi.registerCommand("env", {
    description: "Show configured environment variables",
    handler: async (_args, ctx) => {
      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: formatReport(ctx.ui.theme, startup.reports),
        display: true,
      });
    },
  });

  // Show warnings on session start (no values — may contain secrets)
  pi.on("session_start", async (_event, ctx) => {
    // Second pass adds project values; global "!command"s hit the cache.
    if (ctx.isProjectTrusted()) startup = await applyEnv(ctx.cwd, true);
    // Headless (-p, json, rpc): no theme, so fall back to plain stderr.
    const fg = ctx.hasUI ? ctx.ui.theme.fg.bind(ctx.ui.theme) : (_c: string, t: string) => t;

    const warnings: Array<[string, string[]]> = [
      ["ignoring non-scalar values:", startup.nonScalarKeys],
      ["ignoring invalid variable names:", startup.invalidKeys],
      ["unresolved variables:", startup.unresolvedVars],
      ["overriding existing variables:", startup.overriddenVars],
      ['blocked "!command" execution (project settings are untrusted):', startup.blockedCommandKeys],
      ['"!command" failed (left unset):', startup.failedCommandKeys],
      ["refused from project settings (loader/network variable):", startup.deniedKeys],
    ];
    const lines = warnings.flatMap(([label, keys]) =>
      keys.length > 0 ? [`  ${fg("warning", label)} ${keys.join(", ")}`] : []
    );
    if (lines.length === 0) return;

    const content = fg("accent", "[env]") + "\n" + lines.join("\n");
    if (!ctx.hasUI) {
      process.stderr.write(content + "\n");
      return;
    }
    pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true });
  });
}
