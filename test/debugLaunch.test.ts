import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import { parseJsonc, resolveVars } from "../src/debugLaunch";

describe("parseJsonc", () => {
  it("parses launch.json with comments and trailing commas", () => {
    const text = `{
      // the configs
      "version": "0.2.0",
      "configurations": [
        {
          "type": "node",
          "request": "launch",
          "name": "Run", /* inline */
          "program": "\${workspaceFolder}/index.js",
        },
      ],
    }`;
    const parsed = parseJsonc(text) as any;
    expect(parsed.configurations).toHaveLength(1);
    expect(parsed.configurations[0].name).toBe("Run");
  });

  it("leaves // and /* inside strings alone", () => {
    const parsed = parseJsonc(`{ "url": "https://x/*y*/z", "p": "a//b" }`) as any;
    expect(parsed.url).toBe("https://x/*y*/z");
    expect(parsed.p).toBe("a//b");
  });
});

describe("resolveVars", () => {
  const cwd = "/tmp/worktree-a";

  it("substitutes the workspaceFolder family deeply", () => {
    const out = resolveVars(
      {
        program: "${workspaceFolder}/index.js",
        cwd: "${workspaceFolder}",
        args: ["--root", "${workspaceFolderBasename}"],
        env: { HOME: "${userHome}" },
      },
      cwd
    );
    expect(out.program).toBe(`${cwd}/index.js`);
    expect(out.cwd).toBe(cwd);
    expect(out.args).toEqual(["--root", path.basename(cwd)]);
    expect(out.env.HOME).toBe(os.homedir());
  });

  it("handles the multi-root ${workspaceFolder:Name} form", () => {
    const out = resolveVars({ p: "${workspaceFolder:other}/x" }, cwd);
    expect(out.p).toBe(`${cwd}/x`);
  });

  it("leaves variables it does not own for VS Code to resolve", () => {
    const out = resolveVars({ p: "${env:FOO}", q: "${file}" }, cwd);
    expect(out.p).toBe("${env:FOO}");
    expect(out.q).toBe("${file}");
  });
});
