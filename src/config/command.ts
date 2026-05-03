import { loadConfig } from "./load";

function matchGlob(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.startsWith("*") && name.endsWith(pattern.slice(1))) return true;
  if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

export interface BuildCommandOptions {
  /**
   * Strip `--continue`/`--resume` and skip the `||` shell-fallback template.
   * The wake plugin sets this when the caller asked for `--fresh`, OR when
   * the target cwd has no continuable claude session (probed via
   * `hasContinuableSession`) — without it, `claude --continue` exits 0 with
   * "No conversation found to continue" and the fallback never fires.
   */
  fresh?: boolean;
  /**
   * Resume a specific Claude session by id (UUID matching the JSONL filename
   * under `~/.claude/projects/<encoded-cwd>/<id>.jsonl`). Wins over `fresh`
   * if both are set; emits `claude … --resume "<id>"` with no `||` fallback.
   * Used by the directed-inbox watcher (Phase 2a) to pin a follow-up wake on
   * thread N to the same session that handled the prior wake on thread N —
   * keeps worktree count proportional to (oracle × thread) pairs instead of
   * ballooning per wake (#worktree-sprawl).
   */
  resume?: string;
  /**
   * First-message prompt for claude. Appended as `-p '<escaped>'`. When the
   * `||` fallback is emitted, the prompt is baked into BOTH branches so it
   * lands regardless of which one runs.
   */
  prompt?: string;
}

function appendPrompt(cmd: string, prompt?: string): string {
  if (!prompt) return cmd;
  const escaped = prompt.replace(/'/g, "'\\''");
  return `${cmd} -p '${escaped}'`;
}

export function buildCommand(agentName: string, opts?: BuildCommandOptions): string {
  const config = loadConfig();
  let cmd = config.commands.default || "claude";

  // Strip --dangerously-skip-permissions when running as root (#181)
  if (process.getuid?.() === 0) {
    cmd = cmd.replace(/\s*--dangerously-skip-permissions\b/, "");
  }

  // Match specific patterns first (skip "default")
  for (const [pattern, command] of Object.entries(config.commands)) {
    if (pattern === "default") continue;
    if (matchGlob(pattern, agentName)) { cmd = command; break; }
  }

  // Inject --session-id if configured for this agent
  const sessionIds: Record<string, string> = (config as any).sessionIds || {};
  const sessionId = sessionIds[agentName]
    || Object.entries(sessionIds).find(([p]) => p !== "default" && matchGlob(p, agentName))?.[1];
  if (sessionId) {
    if (cmd.includes("--continue")) {
      cmd = cmd.replace(/\s*--continue\b/, ` --resume "${sessionId}"`);
    } else {
      cmd += ` --resume "${sessionId}"`;
    }
  }

  // --resume <sid>: caller has told us EXACTLY which session to resume. Strip
  // any --continue / --resume baked into config (we replace it), drop the `||`
  // fallback (we trust the caller knows the session is valid), and pass the
  // explicit session id. Wins over `fresh` so the watcher's resume path is
  // unconditional.
  if (opts?.resume) {
    cmd = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+"[^"]*"/, "");
    cmd += ` --resume "${opts.resume}"`;
    return appendPrompt(cmd, opts.prompt);
  }

  // --fresh: strip --continue/--resume, no fallback emitted. Caller is asking for a
  // clean session — either explicitly via `--fresh`, or because filesystem probe
  // confirmed no continuable session exists for the target cwd.
  if (opts?.fresh) {
    cmd = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+"[^"]*"/, "");
    if (sessionId) cmd += ` --session-id "${sessionId}"`;
    return appendPrompt(cmd, opts.prompt);
  }

  // Fallback for --continue/--resume: retry without it (fresh worktree / expired session).
  // Keep --session-id (if set) so the first run creates the session with that ID.
  // Bake the prompt (if any) into BOTH branches so it lands regardless of which wins —
  // the prior shape (`prompt only on the fallback`) silently dropped the prompt whenever
  // continue succeeded.
  if (cmd.includes("--continue") || cmd.includes("--resume")) {
    let fallback = cmd.replace(/\s*--continue\b/, "").replace(/\s*--resume\s+"[^"]*"/, "");
    if (sessionId) fallback += ` --session-id "${sessionId}"`;
    return `${appendPrompt(cmd, opts?.prompt)} || ${appendPrompt(fallback, opts?.prompt)}`;
  }

  return appendPrompt(cmd, opts?.prompt);
}

/**
 * Previously wrapped buildCommand with `cd '<cwd>' && { ... }` to survive tmux
 * server reboots that reset pane pwd. Dropped in #541 — tmux newWindow(cwd:)
 * already sets the initial pane cwd, and the scrollback noise wasn't worth
 * the reboot-recovery edge case. `cwd` param kept for API compat + future use.
 */
export function buildCommandInDir(
  agentName: string,
  _cwd: string,
  opts?: BuildCommandOptions,
): string {
  return buildCommand(agentName, opts);
}

export function getEnvVars(): Record<string, string> {
  return loadConfig().env || {};
}
