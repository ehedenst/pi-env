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

function resolveValue(
  value: string,
  allowExec: boolean
): { resolved: string; missing: string[]; blockedCommand?: string } {
  const missing: string[] = [];
  let resolved = value.replace(ENV_VAR_PATTERN, (match, braced, bare) => {
    if (match === "$$") return "$";
    const varName = braced ?? bare;
    const val = process.env[varName];
    if (val === undefined) missing.push(varName);
    return val ?? "";
  });
  if (resolved.startsWith('!')) {
    const command = resolved.slice(1);
    if (!allowExec) {
      // "!command" execution is only trusted from global settings
      // (~/.pi/agent/settings.json). Project settings (.pi/settings.json)
      // ship inside repositories and are not a trusted execution source,
      // so refuse to run the command and surface it as a warning instead.
      return { resolved: "", missing, blockedCommand: command };
    }
    try {
      resolved = execSync(command, {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }).trim();
    } catch (error) {
      missing.push(command);
    }
  }
  return { resolved, missing };
}

function extractEnv(settings: object): Record<string, unknown> | undefined {
  const vars = Reflect.get(settings, CONFIG_KEY);
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return undefined;
  return Object.keys(vars).length > 0 ? (vars as Record<string, unknown>) : undefined;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function applyEnv(cwd: string): {
  reports: EnvReport[];
  unresolvedVars: string[];
  overriddenVars: string[];
  nonScalarKeys: string[];
  blockedCommandKeys: string[];
} {
  const settingsManager = SettingsManager.create(cwd);
  const globalEnvRaw = extractEnv(settingsManager.getGlobalSettings());
  const projectEnvRaw = extractEnv(settingsManager.getProjectSettings());

  // Merge: project overrides global
  const merged = { ...globalEnvRaw, ...projectEnvRaw };

  const nonScalarKeys = Object.keys(merged).filter((k) => !isScalar(merged[k]));
  const scalarKeys = Object.keys(merged).filter((k) => isScalar(merged[k]));

  // Clean up stale vars from a previous load (e.g. after /reload with keys removed)
  const previousKeys: string[] = process.env[TRACKER_KEY]
    ? JSON.parse(process.env[TRACKER_KEY])
    : [];
  const previousOverrides: string[] = process.env[OVERRIDES_KEY]
    ? JSON.parse(process.env[OVERRIDES_KEY])
    : [];
  const removedKeys = previousKeys.filter((k) => !scalarKeys.includes(k));
  for (const key of removedKeys) {
    delete process.env[key];
  }

  const unresolvedVars: string[] = [];
  const overriddenVars: string[] = [];
  const blockedCommandKeys: string[] = [];
  const reports: EnvReport[] = [];

  // Process global (trusted source: "!command" execution is allowed)
  if (globalEnvRaw) {
    const vars: Record<string, string> = {};
    for (const [key, value] of Object.entries(globalEnvRaw)) {
      if (!isScalar(value)) continue;
      const strValue = String(value);
      const { resolved, missing, blockedCommand } = resolveValue(strValue, true);
      if (blockedCommand) blockedCommandKeys.push(key);
      unresolvedVars.push(...missing);
      if (
        (process.env[key] !== undefined && !previousKeys.includes(key)) ||
        previousOverrides.includes(key)
      ) {
        overriddenVars.push(key);
      }
      process.env[key] = resolved;
      vars[key] = resolved;
    }
    if (Object.keys(vars).length > 0) {
      reports.push({ source: "global", variables: vars });
    }
  }

  // Process project (overrides global). Project settings ship inside
  // repositories and are not a trusted execution source, so "!command"
  // values are refused here (see resolveValue's allowExec=false).
  if (projectEnvRaw) {
    const vars: Record<string, string> = {};
    for (const [key, value] of Object.entries(projectEnvRaw)) {
      if (!isScalar(value)) continue;
      const strValue = String(value);
      const { resolved, missing, blockedCommand } = resolveValue(strValue, false);
      if (blockedCommand) blockedCommandKeys.push(key);
      unresolvedVars.push(...missing);
      if (
        (process.env[key] !== undefined &&
          !previousKeys.includes(key) &&
          !overriddenVars.includes(key) &&
          !globalEnvRaw?.[key]) ||
        (previousOverrides.includes(key) && !overriddenVars.includes(key))
      ) {
        overriddenVars.push(key);
      }
      process.env[key] = resolved;
      vars[key] = resolved;
    }
    if (Object.keys(vars).length > 0) {
      reports.push({ source: "project", variables: vars });
    }
  }

  // Track current keys and overrides for reload persistence
  if (scalarKeys.length > 0) {
    process.env[TRACKER_KEY] = JSON.stringify(scalarKeys);
  } else {
    delete process.env[TRACKER_KEY];
  }
  if (overriddenVars.length > 0) {
    process.env[OVERRIDES_KEY] = JSON.stringify(overriddenVars);
  } else {
    delete process.env[OVERRIDES_KEY];
  }

  return { reports, unresolvedVars, overriddenVars, nonScalarKeys, blockedCommandKeys };
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
  const { reports, unresolvedVars, overriddenVars, nonScalarKeys, blockedCommandKeys } =
    applyEnv(process.cwd());

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
      const { reports: currentReports } = applyEnv(ctx.cwd);
      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: formatReport(ctx.ui.theme, currentReports),
        display: true,
      });
    },
  });

  // Show warnings on session start (no values — may contain secrets)
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const warnings: string[] = [];
    if (nonScalarKeys.length > 0) {
      warnings.push(`${ctx.ui.theme.fg("warning", "ignoring non-scalar values:")} ${nonScalarKeys.join(", ")}`);
    }
    if (unresolvedVars.length > 0) {
      warnings.push(`${ctx.ui.theme.fg("warning", "unresolved variables:")} ${[...new Set(unresolvedVars)].join(", ")}`);
    }
    if (overriddenVars.length > 0) {
      warnings.push(`${ctx.ui.theme.fg("warning", "overriding existing variables:")} ${overriddenVars.join(", ")}`);
    }
    if (blockedCommandKeys.length > 0) {
      warnings.push(
        `${ctx.ui.theme.fg("warning", "blocked \"!command\" execution (project settings are untrusted):")} ${blockedCommandKeys.join(", ")}`
      );
    }

    if (warnings.length > 0) {
      const text = ctx.ui.theme.fg("accent", "[env]") + "\n" + warnings.map((w) => `  ${w}`).join("\n");
      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: text,
        display: true,
      });
    }
  });
}
