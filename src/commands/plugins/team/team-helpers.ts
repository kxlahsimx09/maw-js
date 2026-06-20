import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// Exported for testing — override with _setDirs
export let TEAMS_DIR = join(homedir(), ".claude/teams");
export let TASKS_DIR = join(homedir(), ".claude/tasks");

/** @internal — for tests only */
export function _setDirs(teams: string, tasks: string) {
  TEAMS_DIR = teams;
  TASKS_DIR = tasks;
}

export interface TeamMember {
  name: string;
  agentId?: string;
  agentType?: string;
  tmuxPaneId?: string;
  color?: string;
  model?: string;
  backendType?: string;
}

export interface TeamConfig {
  name: string;
  description?: string;
  members: TeamMember[];
  createdAt?: number;
  // Who created/leads this team — the dispatcher's tmux pane (%NN) and Claude
  // session id, captured from the env at create time. Lets consumers (e.g. the
  // fleet visualizer) group a team under the orchestrator that spawned it, since
  // the team↔dispatcher link isn't otherwise persisted.
  createdByPane?: string;
  createdBySession?: string;
}

/** Snapshot the creating agent's identity from the environment (best-effort). */
export function creatorEnv(): { createdByPane?: string; createdBySession?: string } {
  const pane = process.env.TMUX_PANE;
  const session = process.env.CLAUDE_SESSION_ID;
  return {
    ...(pane ? { createdByPane: pane } : {}),
    ...(session ? { createdBySession: session } : {}),
  };
}

// ── Account inheritance ──────────────────────────────────────────────────────
// A teammate should run on the SAME pinned Claude account as the orchestrator that
// spawns it. We can't trust process.env (Claude may scrub CLAUDE_CODE_OAUTH_TOKEN
// from Bash-tool subprocess envs), so we walk UP the process ancestry from this
// `maw` process to the nearest `claude` (the orchestrator) and read its frozen
// account vars straight from /proc/<pid>/environ. Returns a shell env-prefix to
// prepend to the teammate launch command, or '' (→ default account, unchanged).
const ACCOUNT_ENV_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];

/** Build a single-quoted shell env-prefix from a NUL-joined /proc environ buffer. */
export function accountEnvPrefix(environ: string): string {
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  const out: string[] = [];
  for (const kv of environ.split("\0")) {
    const eq = kv.indexOf("=");
    if (eq < 1) continue;
    const k = kv.slice(0, eq), v = kv.slice(eq + 1);
    if (ACCOUNT_ENV_KEYS.includes(k) && v) out.push(`${k}=${q(v)}`);
  }
  return out.join(" ");
}

/** A pid's account env-prefix read from /proc (Linux); '' if unreadable. */
export function accountEnvFromPid(pid: number): string {
  try { return accountEnvPrefix(readFileSync(`/proc/${pid}/environ`, "utf-8")); }
  catch { return ""; }
}

/** Walk the process ancestry to the nearest `claude` (the spawning orchestrator)
 *  and return its account env-prefix, or '' if none is found / not pinned. */
export function inheritedAccountEnv(startPpid: number = process.ppid): string {
  const ppidOf = (pid: number): number => {
    try {
      const m = readFileSync(`/proc/${pid}/status`, "utf-8").match(/^PPid:\s*(\d+)/m);
      return m ? Number(m[1]) : 0;
    } catch { return 0; }
  };
  let pid = startPpid;
  for (let hop = 0; hop < 16 && pid > 1; hop++) {
    let comm = "";
    try { comm = readFileSync(`/proc/${pid}/comm`, "utf-8").trim(); } catch { return ""; }
    if (comm === "claude") return accountEnvFromPid(pid);
    pid = ppidOf(pid);
  }
  return "";
}

export function loadTeam(name: string): TeamConfig | null {
  const configPath = join(TEAMS_DIR, name, "config.json");
  if (!existsSync(configPath)) return null;
  try { return JSON.parse(readFileSync(configPath, "utf-8")); }
  catch { return null; }
}

/**
 * Resolve ψ/ directory by walking UP from cwd looking for an oracle root
 * (marked by CLAUDE.md + ψ/). Falls back to cwd/ψ for backward compat when
 * no marker is found. Prevents rogue nested vaults when the CLI is run from
 * a sub-directory (#393 — Bug A).
 */
export function resolvePsi(): string {
  let dir = process.cwd();
  // Walk up looking for an oracle root (CLAUDE.md + ψ/ both present)
  while (true) {
    const psi = join(dir, "ψ");
    if (existsSync(psi) && existsSync(join(dir, "CLAUDE.md"))) return psi;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  // Fallback: legacy behavior — cwd/ψ, callers mkdir as needed
  return join(process.cwd(), "ψ");
}

/**
 * Write a shutdown_request message to a teammate's inbox file.
 * This is the same protocol Claude Code uses internally via SendMessage.
 */
export function writeShutdownRequest(teamName: string, memberName: string, reason: string): void {
  const inboxPath = join(TEAMS_DIR, teamName, "inboxes", `${memberName}.json`);
  let messages: any[] = [];
  if (existsSync(inboxPath)) {
    try { messages = JSON.parse(readFileSync(inboxPath, "utf-8")); } catch { messages = []; }
  }
  const requestId = `shutdown-${Date.now()}@${memberName}`;
  messages.push({
    from: "maw-team-shutdown",
    text: JSON.stringify({ type: "shutdown_request", reason, request_id: requestId }),
    summary: `Shutdown request: ${reason}`,
    timestamp: new Date().toISOString(),
    read: false,
  });
  // lgtm[js/file-system-race] — PRIVATE-PATH: inbox under ~/.maw/teams/<team>/inboxes/, see docs/security/file-system-race-stance.md
  writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
}

/**
 * Write a generic message to a teammate's inbox file.
 * Same protocol as writeShutdownRequest but with type: "message".
 */
export function writeMessage(teamName: string, memberName: string, from: string, text: string): void {
  const inboxPath = join(TEAMS_DIR, teamName, "inboxes", `${memberName}.json`);
  let messages: any[] = [];
  if (existsSync(inboxPath)) {
    try { messages = JSON.parse(readFileSync(inboxPath, "utf-8")); } catch { messages = []; }
  }
  messages.push({
    from,
    text: JSON.stringify({ type: "message", content: text }),
    summary: text.slice(0, 80),
    timestamp: new Date().toISOString(),
    read: false,
  });
  mkdirSync(join(TEAMS_DIR, teamName, "inboxes"), { recursive: true });
  // lgtm[js/file-system-race] — PRIVATE-PATH: inbox under ~/.maw/teams/<team>/inboxes/, see docs/security/file-system-race-stance.md
  writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
}

export function cleanupTeamDir(name: string) {
  const teamDir = join(TEAMS_DIR, name);
  const tasksDir = join(TASKS_DIR, name);
  if (existsSync(teamDir)) { try { rmSync(teamDir, { recursive: true }); } catch {} }
  if (existsSync(tasksDir)) { try { rmSync(tasksDir, { recursive: true }); } catch {} }
}
