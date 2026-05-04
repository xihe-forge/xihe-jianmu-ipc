# reaper v6 blacklist reverse

## Before v5 whitelist snippet

```js
const QUERY_COMMAND_PATTERNS = [
  /\brev-parse\b/i,
  /\bremote\s+-v\b/i,
  /\bstatus\b/i,
  /\bfor-each-ref\b/i,
  /\bsymbolic-ref\b/i,
  /\bshow-ref\b/i,
  /\bconfig\s+(?:--get|--get-all|--list|-l)\b/i,
];

export function isGitQueryCommand(cmdline) {
  const text = String(cmdline ?? '');
  if (!QUERY_COMMAND_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }
  return !MUTATING_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}
```

## After v6 blacklist snippet

```js
const MUTATING_COMMAND_PATTERNS = [
  /\bgit(?:\.exe)?["']?\s+(push|pull|fetch|merge|rebase|commit|stash|checkout|reset|clean|am|cherry-pick|revert|gc|repack|pack-objects|fsck|prune|filter-branch|update-server-info|update-ref|tag|branch|notes|submodule|worktree|init|clone|add|rm|mv|apply|format-patch|send-email)\b/i,
];

export function isMutatingGitCommand(cmdline) {
  const text = String(cmdline ?? '');
  return MUTATING_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

// isOrphanGitCandidate tail
return !isMutatingGitCommand(info.cmdline);
```

## Dogfood test truth

- `git remote get-url origin`: `isMutatingGitCommand=false`, old orphan candidate `true`, run cycle reaps pid 5302.
- `git push origin master`: `isMutatingGitCommand=true`, old orphan candidate `false`, run cycle does not reap.
- `git pull`: `isMutatingGitCommand=true`, old orphan candidate `false`, run cycle does not reap.
- `git commit -m fix`: `isMutatingGitCommand=true`, old orphan candidate `false`, run cycle does not reap.

Additional query truth:

- `git rev-parse HEAD`: old orphan candidate `true`.
- `git status --short`: old orphan candidate `true`.
- `git log --oneline -1`: old orphan candidate `true`.

## Verification

- `node --test test/orphan-git-reaper.test.mjs`: FAIL in this sandbox before test assertions with `Error: spawn EPERM`.
- `node --test --test-isolation=none test/orphan-git-reaper.test.mjs`: PASS, 4/4.
- `node --test --test-isolation=none tests/watchdog-orphan-git-reaper.test.mjs`: PASS, 8/8.
- `node test/orphan-git-reaper.test.mjs`: PASS, 4/4.
- `node tests/watchdog-orphan-git-reaper.test.mjs`: PASS, 8/8.

## ship-tier

ship-tier: e2e-partial 4/28

Covered: B1, S1, V1, V2.

真打通待补 ETA: 第二十波孤儿监控验证（下次孤儿出现 watchdog log 真值）

## Commit and push

- commit hash: N/A, local git metadata write blocked.
- push status: NOT RUN, because `git add` could not create `.git/index.lock`.
- `git config user.name 'Xihe'`: FAIL, `.git/config` lock permission denied.
- `git config user.email 'xihe-ai@lumidrivetech.com'`: FAIL, `.git/config` lock permission denied.
- `git add lib/watchdog/orphan-git-reaper.mjs tests/watchdog-orphan-git-reaper.test.mjs test/orphan-git-reaper.test.mjs`: FAIL, `.git/index.lock` permission denied.

## EXIT

EXIT 1
