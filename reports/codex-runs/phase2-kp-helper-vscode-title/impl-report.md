Phase 2 K.P implementation report
=================================

P1.A VSCode blank-line root-cause evidence
------------------------------------------
1. Source stream used for root-cause probe:
   `temp/codex-runs/phase2-ko-multi-prompt-smoke/smoke-untrusted/auto.stdout.raw`.
2. That stream was captured from the real helper plus real Claude Code v2.1.123
   in a real PTY, cwd `D:\tmp\untrusted-ko-smoke-1777475`.
3. Trusted cwd control stream:
   `temp/codex-runs/phase2-ko-multi-prompt-smoke/smoke-trusted/auto.stdout.raw`.
4. Trusted stream ANSI counts: OSC title 2, `CSI H` 2, absolute cursor 18,
   erase-display 1, erase-line 1, sync-update 6, scroll-region 0, cursor-up 0,
   cursor-down 0.
5. Trusted stream longest `CSI H` immediate space run: 1 byte.
6. Untrusted stream ANSI counts: OSC title 2, `CSI H` 3, absolute cursor 32,
   erase-display 1, erase-line 2, sync-update 14, scroll-region 0, cursor-up 0,
   cursor-down 0.
7. Untrusted stream has one prompt-clear sequence matching
   `CSI H` + large spaces + `CRLF` + `CSI K` + `CSI 120C`.
8. The immediate space run after that `CSI H` is 2040 bytes.
9. This sequence appears after the trust prompt is accepted and before the
   development-channel prompt is redrawn.
10. The sequence is not a scroll-region or cursor-up/down issue; the probe found
    no `CSI <n>A`, `CSI <n>B`, or `CSI <top>;<bottom>r` in the relevant stream.
11. xterm-headless 6.0.0 probe used cols=120 rows=30 to emulate VSCode xterm.js
    parsing for the problematic segment.
12. Feeding the raw segment into xterm-headless leaves cursorX=119 cursorY=17
    and the visible buffer is space-filled/blank.
13. Feeding the sanitized segment leaves cursorX=0 cursorY=0 with no large
    printed-space clear.
14. This matches the boss-observed symptom: VSCode xterm.js visibly refreshes
    a large blank region, while Windows PowerShell console host did not show the
    same persistent artifact in manual testing.
15. Selected P1.A fix: helper-side output sanitizer, not VSCode/xterm patching.
16. The sanitizer only rewrites `CSI H` followed by 160+ spaces and optional
    `CRLF`/`CSI K`/`CSI <n>C` into `CSI 2J` + `CSI H`.
17. This preserves normal Claude cursor positioning and avoids filtering
    inquirer prompt text or the main Claude UI.
18. Post-fix trusted smoke has `homeBlankFillCount=0`.
19. Post-fix untrusted smoke has `homeBlankFillCount=0`.
20. Post-fix untrusted smoke has `clearHomeCount=1`, confirming the old
    printed-space clear was replaced with a real clear-screen sequence.

P1.B tab title implementation
-----------------------------
- `IPC_NAME` is read once from `process.env.IPC_NAME.trim()`.
- Startup emits `OSC 0;${IPC_NAME} BEL` when `IPC_NAME` is non-empty.
- All child `OSC 0`, `OSC 1`, and `OSC 2` title updates are rewritten to the
  same `OSC 0;${IPC_NAME} BEL` sequence.
- BEL and ST terminated OSC title sequences are both covered.
- Prompt detection still runs against raw child data; output rewrite/sanitize
  happens only for `process.stdout.write`.
- Empty `IPC_NAME` skips title injection and passes Claude title OSC through.

Implementation
--------------
- RED commit: `5b388c0 test(ipc): cover helper title and blank fill polish`.
- Helper changed: `bin/claude-stdin-auto-accept.mjs`.
- Tests added: `tests/claude-stdin-auto-accept-tab-title.test.mjs`.
- Test harness env isolation added for existing helper tests so ambient
  `IPC_NAME` does not change old exact-stdout assertions.

Verification
------------
- RED: `node --test tests\claude-stdin-auto-accept-tab-title.test.mjs`
  EXIT=1, 1/5 pass and 4/5 fail as expected.
- Targeted GREEN: helper/title suites
  `node --test tests\claude-stdin-auto-accept-tab-title.test.mjs ... tests\spawn-stdin-auto-accept.test.mjs`
  EXIT=0, 29/29 pass.
- Full `pnpm test`: EXIT=0.
- Post-fix trusted smoke:
  `titleTestKpCount=3`, `rawClaudeOscTitleCount=0`, `homeBlankFillCount=0`,
  `listeningCount=2`, `autoAcceptEnterCount=1`.
- Post-fix untrusted smoke:
  `titleTestKpCount=3`, `rawClaudeOscTitleCount=0`, `homeBlankFillCount=0`,
  `clearHomeCount=1`, `listeningCount=1`, `autoAcceptEnterCount=2`.
- Smoke artifacts:
  `temp/codex-runs/phase2-kp-helper-vscode-title/smoke-summary.json`,
  `temp/codex-runs/phase2-kp-helper-vscode-title/p1a-xterm-probe.json`.
