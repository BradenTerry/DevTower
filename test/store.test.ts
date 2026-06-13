import { describe, it, expect } from "vitest";
import { DevTowerStore, reconstruct, ChangedFile } from "../src/store";

const newStore = () => new DevTowerStore({ subscriptions: [] } as any);

describe("DevTowerStore.apply", () => {
  it("creates an agent with sensible defaults", () => {
    const s = newStore();
    s.apply({ id: "a1" });
    const a = s.get("a1")!;
    expect(a.id).toBe("a1");
    expect(a.name).toBe("a1"); // falls back to id
    expect(a.state).toBe("idle");
    expect(a.worktree).toBe(""); // no silent "." fallback
  });

  it("ignores events without an id", () => {
    const s = newStore();
    s.apply({ id: "" });
    expect(s.list()).toHaveLength(0);
  });

  it("merges partial updates, preserving untouched fields", () => {
    const s = newStore();
    s.apply({ id: "a1", name: "streamer", repo: "api", state: "active" });
    s.apply({ id: "a1", state: "waiting" });
    const a = s.get("a1")!;
    expect(a.name).toBe("streamer"); // preserved
    expect(a.repo).toBe("api"); // preserved
    expect(a.state).toBe("waiting"); // updated
  });

  it("unions skills in first-seen order across polls", () => {
    const s = newStore();
    s.apply({ id: "a1", skills: ["code-review", "verify"] });
    s.apply({ id: "a1", skills: ["verify", "simplify"] });
    expect(s.get("a1")!.skills).toEqual(["code-review", "verify", "simplify"]);
  });

  it("retains the question while waiting but clears it when no longer waiting", () => {
    const s = newStore();
    s.apply({ id: "a1", state: "waiting", question: "Rotate tokens?" });
    expect(s.get("a1")!.question).toBe("Rotate tokens?");
    // a non-waiting state update with no question clears it
    s.apply({ id: "a1", state: "active" });
    expect(s.get("a1")!.question).toBeUndefined();
  });

  it("keeps the question when an update carries no state at all", () => {
    const s = newStore();
    s.apply({ id: "a1", state: "waiting", question: "Pick A or B?" });
    s.apply({ id: "a1", elapsed: "2m ago" }); // metadata-only poll
    expect(s.get("a1")!.question).toBe("Pick A or B?");
  });

  it("fires onChange", () => {
    const s = newStore();
    let fired = 0;
    s.onChange(() => fired++);
    s.apply({ id: "a1" });
    expect(fired).toBe(1);
  });
});

describe("DevTowerStore.batch", () => {
  it("coalesces many mutations into a single onChange", async () => {
    const s = newStore();
    s.apply({ id: "old", worktree: "/repo" });
    let fired = 0;
    s.onChange(() => fired++);
    // a /clear-style swap: new session applied, old removed, in one batch
    await s.batch(async () => {
      s.apply({ id: "new", worktree: "/repo" });
      s.remove("old");
    });
    expect(fired).toBe(1); // one atomic snapshot, not two posts
    expect(s.get("new")).toBeTruthy();
    expect(s.get("old")).toBeUndefined();
  });

  it("emits even when the batch body only removes", async () => {
    const s = newStore();
    s.apply({ id: "a1" });
    let fired = 0;
    s.onChange(() => fired++);
    await s.batch(async () => s.remove("a1"));
    expect(fired).toBe(1);
  });

  it("does not fire when the batch body changes nothing", async () => {
    const s = newStore();
    let fired = 0;
    s.onChange(() => fired++);
    await s.batch(async () => s.remove("missing"));
    expect(fired).toBe(0);
  });

  it("collapses nested batches into one fire (outermost only)", async () => {
    const s = newStore();
    let fired = 0;
    s.onChange(() => fired++);
    await s.batch(async () => {
      s.apply({ id: "a1" });
      await s.batch(async () => s.apply({ id: "a2" }));
      s.apply({ id: "a3" });
    });
    expect(fired).toBe(1);
  });
});

describe("DevTowerStore selection + removal", () => {
  it("tracks and fires selection", () => {
    const s = newStore();
    let selected: string | undefined = "unset";
    s.onDidChangeSelection((id) => (selected = id));
    s.apply({ id: "a1" });
    s.setSelected("a1");
    expect(s.getSelectedId()).toBe("a1");
    expect(s.getSelected()?.id).toBe("a1");
    expect(selected).toBe("a1");
  });

  it("removes an agent", () => {
    const s = newStore();
    s.apply({ id: "a1" });
    s.remove("a1");
    expect(s.get("a1")).toBeUndefined();
    expect(s.list()).toHaveLength(0);
  });

  it("setState updates state and task", () => {
    const s = newStore();
    s.apply({ id: "a1" });
    s.setState("a1", "error", "boom");
    expect(s.get("a1")!.state).toBe("error");
    expect(s.get("a1")!.task).toBe("boom");
  });

  it("repos() returns the distinct set", () => {
    const s = newStore();
    s.apply({ id: "a1", repo: "api" });
    s.apply({ id: "a2", repo: "api" });
    s.apply({ id: "a3", repo: "web" });
    expect(s.repos().sort()).toEqual(["api", "web"]);
  });
});

describe("reconstruct", () => {
  it("rebuilds left/right text from a diff", () => {
    const file: ChangedFile = {
      path: "a.ts",
      add: 1,
      del: 1,
      lines: [
        { kind: "meta", text: "@@ -1,2 +1,2 @@" },
        { kind: "ctx", text: "keep" },
        { kind: "del", text: "old" },
        { kind: "add", text: "new" },
      ],
    };
    const { left, right } = reconstruct(file);
    expect(left).toBe("keep\nold\n");
    expect(right).toBe("keep\nnew\n");
  });
});
