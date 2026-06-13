import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

/** A throwaway git repo in the OS temp dir, with deterministic config so the
 *  same assertions hold on Linux, macOS, and Windows CI runners. */
export interface TempRepo {
  dir: string;
  git(...args: string[]): string;
  write(rel: string, contents: string): void;
  cleanup(): void;
}

export function makeTempRepo(prefix = "devtower-test-"): TempRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      // isolate from the developer's global git config so author / default
      // branch / autocrlf are identical everywhere
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: path.join(dir, ".gitconfig-none"),
        GIT_CONFIG_SYSTEM: path.join(dir, ".gitconfig-none-sys"),
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

  // init.defaultBranch via -b keeps the branch name stable across git versions
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");

  const write = (rel: string, contents: string): void => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  };

  const cleanup = (): void => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  return { dir, git, write, cleanup };
}

/** Make an initial commit so HEAD exists. */
export function seedCommit(repo: TempRepo, file = "README.md", body = "hello\n"): void {
  repo.write(file, body);
  repo.git("add", "-A");
  repo.git("commit", "-m", "init");
}
