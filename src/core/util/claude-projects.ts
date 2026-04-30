import { readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Encode a project cwd to claude's `~/.claude/projects/` directory name.
 * Claude Code stores per-project session JSONLs under a name produced by
 * replacing `/` and `.` with `-` (e.g. /Users/foo/bar → -Users-foo-bar).
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Whether the given cwd has at least one prior claude conversation —
 * a `*.jsonl` under `~/.claude/projects/<encoded-cwd>/`.
 *
 * `claude --continue` exits **0** with the message "No conversation found
 * to continue" when the cwd has no JSONL, so the `cmd || fallback` shell
 * template historically used by maw never fires its fallback in that case
 * (silent-fail). Callers that want a deterministic command should probe
 * with this helper and pass `{ fresh: true }` to `buildCommand` when the
 * cwd has no continuable session.
 */
export async function hasContinuableSession(
  cwd: string,
  projectsDir: string = PROJECTS_DIR,
): Promise<boolean> {
  const dir = join(projectsDir, encodeCwd(cwd));
  try {
    const files = await readdir(dir);
    return files.some(f => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}
