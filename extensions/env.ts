import { execSync } from 'node:child_process';
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Reads an "env" key from settings.json and sets the values
 * as process environment variables at startup.
 *
 * Honors pi's settings hierarchy: project-level (.pi/settings.json)
 * overrides global (~/.pi/agent/settings.json). Both are merged.
 *
 * Supports $ENV_VAR and ${ENV_VAR} interpolation to reference
 * pre-existing environment variables, matching pi's own value
 * resolution syntax. $$ escapes to a literal $.
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
 */

const ENV_VAR_PATTERN = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const CONFIG_KEY = "env";
const MESSAGE_TYPE = "pi-env";
const TRACKER_KEY = "_PI_EXT_ENV_KEYS";
const OVERRIDES_KEY = "_PI_EXT_ENV_OVERRIDES";

interface EnvReport {
  source: string;
  variables: Record<string, string>;
}

interface EnvResult {
  reports: EnvReport[];
  unresolvedVars: string[];
  overriddenVars: string[];
  nonScalarKeys: string[];
  blockedCommandKeys: string[];
}

function interpolate(value: string, missing: string[]): string {
  return value.replace(ENV_VAR_PATTERN, (match, braced, bare) => {
    if (match === "$$") return "$";
    const varName = braced ?? bare;
    const resolved = process.env[varName];
    if (resolved === undefined) missing.push(varName);
    return resolved ?? "";
  });
}

function resolveValue(
  value: string,
  allowExec: boolean
): { resolved: string; missing: string[]; blockedCommand?: string } {
  const missing: string[] = [];

  // The leading "!" must be literal in settings — it is checked before
  // interpolation so an interpolated env var value can never become a command.
  if (!value.startsWith("!")) {
    return { resolved: interpolate(value, missing), missing };
  }

  // "!command" execution is only trusted from global settings
  // (~/.pi/agent/settings.json). Project settings (.pi/settings.json) ship
  // inside repositories and are not a trusted execution source, so refuse to
  // run the command and surface it as a warning instead.
  const command = interpolate(value.slice(1), missing);
  if (!allowExec) return { resolved: "", missing, blockedCommand: command };

  try {
    const output = execSync(command, {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return { resolved: output.trim(), missing };
  } catch {
    missing.push(command);
    return { resolved: "", missing };
  }
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
    return process.env[key] ? JSON.parse(process.env[key]) : [];
  } catch {
    return [];
  }
}

function writeTracked(key: string, values: string[]): void {
  if (values.length > 0) process.env[key] = JSON.stringify(values);
  else delete process.env[key];
}

function applyEnv(cwd: string): EnvResult {
  const settingsManager = SettingsManager.create(cwd);
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

  const reports: EnvReport[] = [];
  const unresolvedVars: string[] = [];
  const nonScalarKeys: string[] = [];
  const blockedCommandKeys: string[] = [];
  const appliedKeys: string[] = [];

  // Later sources override earlier ones, so project wins over global.
  for (const source of sources) {
    if (!source.vars) continue;
    const variables: Record<string, string> = {};
    for (const [key, value] of Object.entries(source.vars)) {
      if (!isScalar(value)) {
        nonScalarKeys.push(key);
        continue;
      }
      const { resolved, missing, blockedCommand } = resolveValue(String(value), source.allowExec);
      if (blockedCommand) blockedCommandKeys.push(key);
      unresolvedVars.push(...missing);
      process.env[key] = resolved;
      if (!appliedKeys.includes(key)) appliedKeys.push(key);
      variables[key] = resolved;
    }
    if (Object.keys(variables).length > 0) {
      reports.push({ source: source.name, variables });
    }
  }

  // Clean up stale vars from a previous load (e.g. after /reload with keys removed)
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
    blockedCommandKeys,
  };
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
      text += `    ${theme.fg("success", key)}${theme.fg("dim", "=")}${theme.fg("muted", value)}\n`;
    }
  }
  return text.trimEnd();
}

export default function (pi: ExtensionAPI): void {
  // Apply env vars immediately (before providers initialize)
  const startup = applyEnv(process.cwd());

  // Register styled message renderer
  pi.registerMessageRenderer(MESSAGE_TYPE, (message) => {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part: { type: string }) => part.type === "text")
            .map((part: { type: string; text: string }) => part.text)
            .join("\n");
    return new Text(text, 0, 0);
  });

  // Filter custom messages from LLM context
  pi.on("context", async (event) => ({
    messages: event.messages.filter(
      (message) => message.role !== "custom" || message.customType !== MESSAGE_TYPE
    ),
  }));

  // Register /env command
  pi.registerCommand("env", {
    description: "Show configured environment variables",
    handler: async (_args, ctx) => {
      const { reports } = applyEnv(ctx.cwd);
      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: formatReport(ctx.ui.theme, reports),
        display: true,
      });
    },
  });

  // Show warnings on session start (no values — may contain secrets)
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const warnings: Array<[string, string[]]> = [
      ["ignoring non-scalar values:", startup.nonScalarKeys],
      ["unresolved variables:", startup.unresolvedVars],
      ["overriding existing variables:", startup.overriddenVars],
      ['blocked "!command" execution (project settings are untrusted):', startup.blockedCommandKeys],
    ];
    const lines = warnings
      .filter(([, keys]) => keys.length > 0)
      .map(([label, keys]) => `  ${ctx.ui.theme.fg("warning", label)} ${keys.join(", ")}`);

    if (lines.length > 0) {
      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: ctx.ui.theme.fg("accent", "[env]") + "\n" + lines.join("\n"),
        display: true,
      });
    }
  });
}
