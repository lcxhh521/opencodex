import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { repoPath } from "../helpers/repo-root";

/**
 * Local push validation ("bun run prepush") typechecks the root project only:
 * tsconfig.json has no project references, so "bun x tsc --noEmit" never parses
 * gui/. A gui compile error therefore ships silently and first surfaces in CI's
 * gates "GUI build" step — which a fork pull request never runs (no repository
 * CI on forks), so it reached ready-for-review as #6471 before any maintainer
 * build. lint/doctor already gate local pushes with the same if-changed shape,
 * so the gui type gate reuses it and the tests below pin the checked-in files
 * rather than copies of them.
 */
const rootPkg = readFileSync(repoPath("package.json"), "utf8");
const prepush = rootPkg.match(/"prepush": "([^"]+)"/)![1]!;
const typecheckGuiIfChangedScript = fileURLToPath(new URL("../../scripts/typecheck-gui-if-changed.ts", import.meta.url));

describe("prepush GUI typecheck", () => {
  test("root exposes the gui typecheck gate script", () => {
    expect(rootPkg).toContain('"typecheck:gui:if-changed": "bun scripts/typecheck-gui-if-changed.ts"');
  });

  test("prepush runs the gui typecheck gate after the root typecheck", () => {
    expect(prepush).toContain("bun run typecheck:gui:if-changed");
    expect(prepush.indexOf("bun run typecheck")).toBeLessThan(prepush.indexOf("bun run typecheck:gui:if-changed"));
  });

  test("the if-changed gate runs on gui/ changes, skips otherwise, and fails the push on a compile error", () => {
    const dryRun = (files: string): string => {
      const probe = Bun.spawnSync([process.execPath, typecheckGuiIfChangedScript], {
        env: { ...process.env, TYPECHECK_DRY_RUN: "1", TYPECHECK_FILES: files },
      });
      return probe.stdout.toString().trim();
    };
    expect(dryRun("gui/src/App.tsx\nscripts/x.ts")).toBe("typecheck:run");
    expect(dryRun("scripts/x.ts\nREADME.md")).toBe("typecheck:skip");

    // A fake compiler makes the failure path deterministic without depending on
    // the real tsc output; `false` always exits 1, exactly like a compile
    // failure, and the script's exit must propagate to fail the push.
    const failing = Bun.spawnSync([process.execPath, typecheckGuiIfChangedScript], {
      env: {
        ...process.env,
        TYPECHECK_FILES: "gui/src/App.tsx",
        TYPECHECK_CMD: "false",
      },
    });
    expect(failing.exitCode).not.toBe(0);

    const skipping = Bun.spawnSync([process.execPath, typecheckGuiIfChangedScript], {
      env: {
        ...process.env,
        TYPECHECK_FILES: "scripts/x.ts\nREADME.md",
        TYPECHECK_CMD: "false",
      },
    });
    expect(skipping.exitCode).toBe(0);
  });

  test("ci gates keeps the GUI build step under the gui path filter", () => {
    const workflow = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8")) as {
      jobs: Record<string, { steps?: Array<{ name?: string; if?: string; run?: string }> }>;
    };
    const gatesSteps = workflow.jobs.gates?.steps ?? [];
    const guiBuild = gatesSteps.find(step => step.name === "GUI build");
    expect(guiBuild).toBeDefined();
    expect(guiBuild!.if).toBe("needs.changes.outputs.gui == 'true'");
    expect((guiBuild!.run ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean)).toEqual(["cd gui", "bun run build"]);
  });
});
