import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Tests for the fresh + prompt opts added to buildCommand to fix the
// `claude --continue || claude -p '<prompt>'` silent-fail (continue exits
// 0 with "No conversation found", `||` skipped, prompt lost). Companion
// to test/command-simplified.test.ts which covers the post-#541 baseline.

let fakeConfig: any = {
  host: "local",
  port: 3456,
  ghqRoot: "/ghq",
  oracleUrl: "http://localhost",
  env: {},
  commands: { default: "claude --continue --dangerously-skip-permissions" },
  sessions: {},
  agents: {},
  node: "local",
};
let fakeSessionIds: Record<string, string> = {};

mock.module("../src/config/load", () => ({
  loadConfig: () => ({ ...fakeConfig, sessionIds: fakeSessionIds }),
  resetConfig: () => {},
  saveConfig: () => fakeConfig,
  configForDisplay: () => ({ ...fakeConfig, envMasked: {} }),
  cfgInterval: () => 1000,
  cfgTimeout: () => 1000,
  cfgLimit: () => 100,
  cfg: (k: string) => (fakeConfig as any)[k],
}));

const { buildCommand } = await import("../src/config/command");

const origGetuid = process.getuid;
beforeEach(() => {
  fakeConfig = {
    host: "local",
    port: 3456,
    ghqRoot: "/ghq",
    oracleUrl: "http://localhost",
    env: {},
    commands: { default: "claude --continue --dangerously-skip-permissions" },
    sessions: {},
    agents: {},
    node: "local",
  };
  fakeSessionIds = {};
  (process as any).getuid = () => 1000;
});
afterEach(() => {
  (process as any).getuid = origGetuid;
});

describe("buildCommand — fresh option", () => {
  test("fresh=true strips --continue and skips || fallback", () => {
    const out = buildCommand("any-agent", { fresh: true });
    expect(out).not.toContain("--continue");
    expect(out).not.toContain("||");
    expect(out).toBe("claude --dangerously-skip-permissions");
  });

  test("fresh=true also strips --resume", () => {
    fakeSessionIds = { foo: "uuid-x" };
    const out = buildCommand("foo", { fresh: true });
    expect(out).not.toContain("--resume");
    expect(out).not.toContain("||");
    // sessionId is still injected as --session-id so first run creates with that ID
    expect(out).toContain('--session-id "uuid-x"');
  });

  test("fresh=false (default) keeps existing || fallback shape", () => {
    const out = buildCommand("any-agent");
    expect(out).toContain("--continue");
    expect(out).toContain("||");
  });
});

describe("buildCommand — prompt option", () => {
  test("prompt with fresh: appends -p '<prompt>' once, no fallback", () => {
    const out = buildCommand("any-agent", { fresh: true, prompt: "do X" });
    expect(out).not.toContain("||");
    expect(out).toContain("-p 'do X'");
  });

  test("prompt without fresh: bakes prompt into BOTH branches of || fallback", () => {
    const out = buildCommand("any-agent", { prompt: "do X" });
    const branches = out.split(" || ");
    expect(branches.length).toBe(2);
    expect(branches[0]).toContain("--continue");
    expect(branches[0]).toContain("-p 'do X'");
    expect(branches[1]).not.toContain("--continue");
    expect(branches[1]).toContain("-p 'do X'");
  });

  test("prompt: single quotes are escaped", () => {
    const out = buildCommand("any-agent", { fresh: true, prompt: "what's up" });
    expect(out).toContain("-p 'what'\\''s up'");
  });

  test("no prompt: nothing appended, behavior matches pre-fix baseline", () => {
    const out = buildCommand("any-agent");
    expect(out).not.toContain("-p '");
  });

  test("prompt without --continue config: no fallback, single -p", () => {
    fakeConfig.commands = { default: "claude" };
    const out = buildCommand("any-agent", { prompt: "do X" });
    expect(out).toBe("claude -p 'do X'");
  });
});

describe("buildCommand — resume option (Phase 1 worktree-reuse)", () => {
  test("resume strips --continue + emits --resume <sid>, no fallback", () => {
    const out = buildCommand("any-agent", { resume: "abc-123" });
    expect(out).toContain('--resume "abc-123"');
    expect(out).not.toContain("--continue");
    expect(out).not.toContain("||");
  });

  test("resume + prompt: prompt appended once, no fallback", () => {
    const out = buildCommand("any-agent", { resume: "abc-123", prompt: "do X" });
    expect(out).toContain('--resume "abc-123"');
    expect(out).toContain("-p 'do X'");
    expect(out).not.toContain("||");
  });

  test("resume wins over fresh: both set → resume path taken", () => {
    const out = buildCommand("any-agent", { fresh: true, resume: "abc-123" });
    expect(out).toContain('--resume "abc-123"');
    expect(out).not.toContain("--continue");
  });

  test("resume replaces config-baked --continue (does not double-emit)", () => {
    fakeConfig.commands = { default: "claude --continue --dangerously-skip-permissions" };
    const out = buildCommand("any-agent", { resume: "uuid-x" });
    const occurrences = (out.match(/--resume/g) || []).length;
    expect(occurrences).toBe(1);
    expect(out).not.toContain("--continue");
  });
});
