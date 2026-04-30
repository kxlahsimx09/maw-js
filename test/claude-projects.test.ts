import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { encodeCwd, hasContinuableSession } from "../src/core/util/claude-projects";

describe("encodeCwd", () => {
  it("replaces / and . with -", () => {
    expect(encodeCwd("/Users/foo/bar.baz")).toBe("-Users-foo-bar-baz");
  });

  it("handles paths with multiple dots", () => {
    expect(encodeCwd("/a/b.c.d")).toBe("-a-b-c-d");
  });
});

describe("hasContinuableSession", () => {
  it("returns false when project dir does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "maw-projects-test-"));
    expect(await hasContinuableSession("/nonexistent/path", root)).toBe(false);
  });

  it("returns false when project dir exists but has no JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "maw-projects-test-"));
    const cwd = "/Users/test/project";
    const projDir = join(root, encodeCwd(cwd));
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "notes.txt"), "hello");
    expect(await hasContinuableSession(cwd, root)).toBe(false);
  });

  it("returns true when project dir has at least one JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "maw-projects-test-"));
    const cwd = "/Users/test/project";
    const projDir = join(root, encodeCwd(cwd));
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "session-uuid.jsonl"), "{}\n");
    expect(await hasContinuableSession(cwd, root)).toBe(true);
  });

  it("ignores non-JSONL files when scoring continuability", async () => {
    const root = await mkdtemp(join(tmpdir(), "maw-projects-test-"));
    const cwd = "/Users/test/proj-with-junk";
    const projDir = join(root, encodeCwd(cwd));
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "scratch.json"), "{}");
    await writeFile(join(projDir, "log.txt"), "hi");
    expect(await hasContinuableSession(cwd, root)).toBe(false);
  });
});
