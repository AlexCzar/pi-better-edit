/**
 * `/pi-better-edit` — the command surface for the pi-lens bridge.
 *
 * WHY this lives beside the extension boundary: it is the only place where user input, UI dialogs
 * and the config file meet, so every branch here is either "answer with text" or "write one
 * setting". Nothing in this module is imported by the editing path, and an absent UI degrades to
 * the same text output a headless host can print.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  isLensBridgeMode,
  isLensBridgeScope,
  LENS_BRIDGE_ENV_VAR,
  LENS_CONFIG_REL,
  readLensBridgeConfig,
  resolveEffectiveLensModeWithSource,
  saveLensBridgeConfig,
  type LensBridgeMode,
  type LensBridgeScope,
} from "./config.js";
import { configDirOverride, hashStorePath, STORE_CONFIG_DIR_ENV_VAR } from "../../hash-store.js";
import {
  resolveStoreJanitorSettingsWithSources,
  STORE_JANITOR_KEY_NAMES,
} from "../../store-config.js";

const COMMAND_NAME = "pi-better-edit";
const IO_BRIDGE_SYMBOL_KEY = "pi-lens:io-bridge";

const USAGE = [
  `${COMMAND_NAME} — configure the pi-lens bridge`,
  `Usage: /${COMMAND_NAME} lens [auto|on|off|status] [project|global]`,
  `  /${COMMAND_NAME} lens                    pick a mode interactively`,
  `  /${COMMAND_NAME} lens auto global        write the global default`,
  `  /${COMMAND_NAME} lens status             show effective mode and config sources`,
].join("\n");

const LENS_COMPLETIONS: readonly string[] = [
  "lens",
  "lens auto",
  "lens on",
  "lens off",
  "lens status",
];

type LensPickerChoice =
  | {
      readonly label: string;
      readonly kind: "set-mode";
      readonly mode: LensBridgeMode;
      readonly scope: LensBridgeScope;
    }
  | { readonly label: string; readonly kind: "status" };

const LENS_PICKER_CHOICES: readonly LensPickerChoice[] = [
  { label: "Auto (Project)", kind: "set-mode", mode: "auto", scope: "project" },
  { label: "Auto (Global)", kind: "set-mode", mode: "auto", scope: "global" },
  { label: "On (Project)", kind: "set-mode", mode: "on", scope: "project" },
  { label: "On (Global)", kind: "set-mode", mode: "on", scope: "global" },
  { label: "Off (Project)", kind: "set-mode", mode: "off", scope: "project" },
  { label: "Off (Global)", kind: "set-mode", mode: "off", scope: "global" },
  { label: "Status", kind: "status" },
];

/** SAFETY: presence-only probe — the io bridge is mounted on globalThis by the extension that
 * owns it, and this command reports whether that mount point exists without ever calling into it. */
function isIOBridgeMounted(): boolean {
  const key: symbol = Symbol.for(IO_BRIDGE_SYMBOL_KEY);
  return key in globalThis;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Notify when a dialog-capable UI exists, otherwise print — a headless host still sees the text. */
function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  // SAFETY: print and json modes expose no notify surface, so the console is the only channel that
  // SAFETY: reaches the caller; the message carries the command's entire output.
  console.log(message);
}

function statusText(cwd: string): string {
  const config = readLensBridgeConfig(cwd);
  const effective = resolveEffectiveLensModeWithSource(cwd);
  const envRaw = process.env[LENS_BRIDGE_ENV_VAR];
  const envValue = envRaw === undefined || envRaw.trim().length === 0 ? "unset" : envRaw.trim();
  const lensLines = [
    `${COMMAND_NAME} lens bridge`,
    `  effective: ${effective.mode}`,
    `  effective source: ${effective.source}`,
    `  io bridge detected: ${isIOBridgeMounted() ? "yes" : "no"}`,
    `  project (${LENS_CONFIG_REL}): ${config.project ?? "unset"}`,
    `  global (~/${LENS_CONFIG_REL}): ${config.global ?? "unset"}`,
    `  env ${LENS_BRIDGE_ENV_VAR}: ${envValue}`,
    "  precedence: env > project > global > auto",
  ];
  // WHY: a blank line between the two blocks — they are two subjects, the bridge and the store, and
  // WHY: each one keeps the shape the other taught the reader.
  return [lensLines.join("\n"), "", storeStatusText(cwd)].join("\n");
}

/**
 * The store's half of the status output, in the lens block's own layout: the settings, then the
 * override, then a precedence line.
 *
 * WHY each key carries its rung: the ladder resolves PER KEY, so "the project file is set" says
 * nothing about which value the store will actually use, and the rung is what says which file to
 * edit next.
 *
 * WHY the store path is printed with its override: `PI_BETTER_EDIT_CONFIG_DIR` is the ONLY thing that
 * can move the store, and no config file key can (there is deliberately no `store.dir`), which is
 * worth saying where a reader is looking for the setting that moved it.
 *
 * WHY a warning is repeated here: an unusable config file degrades to the defaults, and a display
 * that showed those defaults with no reason would be the silent drop this ladder refuses to make.
 */
function storeStatusText(cwd: string): string {
  const warnings: string[] = [];
  const settings = resolveStoreJanitorSettingsWithSources(cwd, (reason) => warnings.push(reason));
  // WHY: verbatim and never trimmed — this is the value the store will USE (see configDirOverride),
  // WHY: so a display that trimmed it would name a directory the store does not open.
  const override = configDirOverride();
  return [
    `${COMMAND_NAME} store`,
    `  store.${STORE_JANITOR_KEY_NAMES.mode}: ${settings.mode.value} (${settings.mode.source})`,
    `  store.${STORE_JANITOR_KEY_NAMES.intervalMs}: ${settings.intervalMs.value} (${settings.intervalMs.source})`,
    `  store.${STORE_JANITOR_KEY_NAMES.batchSize}: ${settings.batchSize.value} (${settings.batchSize.source})`,
    `  store path: ${hashStorePath()}`,
    `  override ${STORE_CONFIG_DIR_ENV_VAR}: ${override ?? "unset"}`,
    "  precedence: env > project > global > default",
    `  store path is set by ${STORE_CONFIG_DIR_ENV_VAR} alone: no config file key can move it`,
    ...warnings.map((reason) => `  warning: ${reason}`),
  ].join("\n");
}

function applyMode(mode: LensBridgeMode, scope: LensBridgeScope, cwd: string): string {
  const configPath = saveLensBridgeConfig(mode, scope, cwd).path;
  return `${COMMAND_NAME} lens bridge set to ${mode} (${scope}) — ${configPath}`;
}

async function pickInteractively(ctx: ExtensionCommandContext): Promise<void> {
  const labels = LENS_PICKER_CHOICES.map((choice) => choice.label);
  const picked = await ctx.ui.select(`${COMMAND_NAME} lens bridge`, labels);
  // WHY: an undefined result is the user cancelling the dialog, so nothing is written and no
  // WHY: confirmation is printed — silence is the correct response to Esc.
  if (picked === undefined) return;
  const choice = LENS_PICKER_CHOICES.find((candidate) => candidate.label === picked);
  if (choice === undefined) {
    notify(ctx, `Unrecognized choice "${picked}".`, "warning");
    return;
  }
  if (choice.kind === "status") {
    notify(ctx, statusText(ctx.cwd));
    return;
  }
  notify(ctx, applyMode(choice.mode, choice.scope, ctx.cwd));
}

async function handleLens(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length > 3) {
    notify(ctx, `Too many arguments.\n${USAGE}`, "warning");
    return;
  }
  if (tokens[0] !== "lens") {
    notify(ctx, USAGE);
    return;
  }

  const sub = tokens[1] ?? "interactive";
  let scope: LensBridgeScope = "project";
  const scopeToken = tokens[2];
  if (scopeToken !== undefined) {
    if (!isLensBridgeScope(scopeToken)) {
      notify(ctx, `Unknown scope "${scopeToken}".\n${USAGE}`, "warning");
      return;
    }
    scope = scopeToken;
  }

  if (sub === "status") {
    notify(ctx, statusText(ctx.cwd));
    return;
  }
  if (isLensBridgeMode(sub)) {
    notify(ctx, applyMode(sub, scope, ctx.cwd));
    return;
  }
  if (sub !== "interactive") {
    notify(ctx, `Unknown option "${sub}".\n${USAGE}`, "warning");
    return;
  }
  if (!ctx.hasUI) {
    notify(ctx, statusText(ctx.cwd));
    return;
  }
  await pickInteractively(ctx);
}

/**
 * Register `/pi-better-edit`. Registration is the extension's only side effect here; every
 * handler path reports through notify/console and never rejects into the host.
 */
export function registerLensCommand(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND_NAME, {
    description:
      "Configure pi-better-edit. Usage: /pi-better-edit lens [auto|on|off|status] [project|global]",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
      LENS_COMPLETIONS.filter((candidate) => candidate.startsWith(prefix.trim())).map(
        (candidate) => ({
          label: candidate,
          value: candidate,
        }),
      ),
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      try {
        await handleLens(args, ctx);
      } catch (error: unknown) {
        // SAFETY: a command handler must never reject into the host's event loop — the failure is
        // SAFETY: reported to the user (typed DomainError payloads included) and the command ends.
        notify(ctx, `${COMMAND_NAME}: ${errorText(error)}`, "error");
      }
    },
  });
}
