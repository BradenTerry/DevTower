import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readTasks } from "../src/claude";

describe("readTasks", () => {
  let tasksRoot: string;

  beforeEach(() => {
    tasksRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devtower-tasks-"));
  });
  afterEach(() => {
    fs.rmSync(tasksRoot, { recursive: true, force: true });
  });

  const write = (session: string, files: Record<string, unknown>) => {
    const dir = path.join(tasksRoot, session);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
    }
  };

  it("counts completed vs total across a session's task files", async () => {
    write("s1", {
      "1.json": { id: "1", status: "completed" },
      "2.json": { id: "2", status: "in_progress" },
      "3.json": { id: "3", status: "pending" },
    });
    expect(await readTasks(tasksRoot, "s1")).toEqual({ done: 1, total: 3 });
  });

  it("returns undefined for a single-task list (not worth the TV)", async () => {
    write("s2", { "1.json": { id: "1", status: "in_progress" } });
    expect(await readTasks(tasksRoot, "s2")).toBeUndefined();
  });

  it("returns undefined when the session has no tasks dir", async () => {
    expect(await readTasks(tasksRoot, "missing")).toBeUndefined();
  });

  it("ignores non-json and unparseable files without throwing", async () => {
    write("s3", {
      "1.json": { id: "1", status: "completed" },
      "2.json": { id: "2", status: "completed" },
    });
    fs.writeFileSync(path.join(tasksRoot, "s3", ".lock"), "");
    fs.writeFileSync(path.join(tasksRoot, "s3", "half.json"), "{ broken");
    expect(await readTasks(tasksRoot, "s3")).toEqual({ done: 2, total: 2 });
  });

  it("skips files missing a status field", async () => {
    write("s4", {
      "1.json": { id: "1", status: "completed" },
      "2.json": { id: "2", status: "pending" },
      "3.json": { id: "3", subject: "no status here" },
    });
    expect(await readTasks(tasksRoot, "s4")).toEqual({ done: 1, total: 2 });
  });
});
