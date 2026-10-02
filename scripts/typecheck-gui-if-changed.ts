/**
 * Run the GUI TypeScript build when this push includes gui/ changes.
 * Used by "bun run prepush".
 *
 * Mirrors "scripts/lint-gui-if-changed.ts" so local push validation stays in
 * one shape: root "typecheck" cannot see gui/ (no project references), so the
 * gui compile check must run separately or a gui compile error ships silently
 * to a fork pull request where no CI lane would catch it (#6471).
 * "tsc -b" is local and deterministic, so a failure always fails the push —
 * there is no soft-skip path.
 *
 * Test hooks: TYPECHECK_DRY_RUN=1 prints the run/skip decision without
 * spawning; TYPECHECK_FILES (newline-separated) overrides git-derived changed
 * files; TYPECHECK_CMD overrides the spawned command. The default command runs
 * via process.execPath so the gate uses the same bun that launched it instead
 * of trusting PATH.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

/** True when any changed path is the gui directory or inside it (slash-guarded). */
function guiPathsChanged(files: string[]): boolean {
  return files.some(f => f === "gui" || f.startsWith("gui/"));
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dirname, "..");
  const guiDir = join(repoRoot, "gui");

  const hasRef = (ref: string): boolean => {
    try {
      const probe = spawnSync("git", ["rev-parse", "--verify", ref], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      return probe.status === 0;
    } catch {
      return false;
    }
  };

  const diffNames = (range: string): string[] => {
    try {
      const diff = spawnSync("git", ["diff", "--name-only", range], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (diff.status !== 0) return [];
      return (diff.stdout ?? "")
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  let files: string[];
  let hadBase = true;
  if (process.env.TYPECHECK_FILES !== undefined) {
    files = process.env.TYPECHECK_FILES.split(/\r?\n/).map(f => f.trim()).filter(Boolean);
  } else {
    let range: string | null = null;
    if (hasRef("@{u}")) range = "@{u}...HEAD";
    else if (hasRef("origin/main")) range = "origin/main...HEAD";
    else if (hasRef("main")) range = "main...HEAD";
    hadBase = range !== null;
    files = range ? diffNames(range) : [];
  }

  // No usable base — run the check so GUI pushes still get one.
  const shouldRun = hadBase ? guiPathsChanged(files) : true;

  if (process.env.TYPECHECK_DRY_RUN === "1") {
    console.log(shouldRun ? "typecheck:run" : "typecheck:skip");
    process.exit(0);
  }

  if (!shouldRun) {
    console.log("typecheck:gui: skip (no gui/ changes in push range)");
    process.exit(0);
  }

  console.log("typecheck:gui: gui/ changed — running tsc -b (trigger=gui-changed, scope=gui project)");
  const [cmd, ...args] = process.env.TYPECHECK_CMD
    ? process.env.TYPECHECK_CMD.split(" ")
    : [process.execPath, "x", "tsc", "-b"];

  const result = spawnSync(cmd!, args, {
    cwd: guiDir,
    encoding: "utf8",
    stdio: "inherit",
  });

  // The compiler is local and deterministic: a compile error fails the push,
  // and a failed spawn is a real error, not an infrastructure soft-skip.
  if (result.error) {
    console.error("typecheck:gui: could not run tsc -b: " + result.error.message);
    process.exit(1);
  }

  process.exit(result.status === null ? 1 : result.status);
}
