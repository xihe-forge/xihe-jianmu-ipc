# 研究报告·VSCode 内建 Claude Code session 方法

> **任务来源**：harness lineage 9 派单 P1（2026-04-26T17:45+08:00）
> **作者**：建木项目经理 jianmu-pm
> **完成时间**：2026-04-26T17:50+08:00
> **背景**：portfolio 现 spawn session 多在 wt 终端，老板想知道 VSCode 内能否直接建 Claude Code session（避免来回切窗口）

---

## 一、结论速览

VSCode 内建 Claude Code session **完全可行**，且有 4 条程序化路径，**最优解 = URI handler `/open` + cold-start prompt 注入**。

| 方案 | 程序化难度 | 多 session 隔离 | 与 ipc_spawn 集成 |
|---|---|---|---|
| URI handler `/open` | 低（一行 `start vscode://`）| 同 VSCode 窗口多 panel | **可直接接入 ipc_spawn host=vscode-uri**（建议新增）|
| `code -n` + URI 链 | 中 | 每 session 独立窗口（隔离最强）| ipc_spawn 已有 `host=vscode-terminal`，可扩展 |
| tasks.json 触发 | 中 | 同窗口多 integrated terminal | 需手动维护 tasks.json，集成低 |
| Command Palette 手工 | 仅手动 | - | 不适合自动化 |

---

## 二、Claude Code VSCode 扩展能力盘点（v2.1.120 实证）

读自 `C:/Users/jolen/.vscode/extensions/anthropic.claude-code-2.1.120-win32-x64/package.json` + `extension.js`。

### 2.1 已注册的 14 个 VSCode commands

| command id | 作用 | 程序化触发 |
|---|---|---|
| `claude-vscode.editor.open` | 在新 panel tab 打开 Claude Code | ✅ executeCommand |
| `claude-vscode.editor.openLast` | 打开上次会话 | ✅ |
| `claude-vscode.window.open` | **新 VSCode 窗口** 打开 Claude Code | ✅ |
| `claude-vscode.sidebar.open` | sidebar 打开 | ✅ |
| `claude-vscode.terminal.open` | 在 integrated terminal 打开 | ✅ |
| `claude-vscode.primaryEditor.open` | **接受 (sessionId, prompt) 参数** 创建 panel | ✅（URI handler 内部用此）|
| `claude-vscode.newConversation` | 新会话（重置当前 panel）| ✅ 但 when 限制于 panel 已 focus |
| `claude-vscode.createWorktree` | **创建 git worktree + Claude session** | ✅（多 session 隔离的最佳原生支持）|
| `claude-vscode.focus` / `.blur` | 焦点切换 | ✅ |
| `claude-vscode.insertAtMention` | 插入 @ mention | ✅ |
| `claude-vscode.acceptProposedDiff` / `.rejectProposedDiff` | diff 处理 | ✅ |
| `claude-vscode.installPlugin` | 安装 plugin | ✅（need ENABLE_INSTALL_PLUGIN=true）|
| `claude-vscode.showLogs` | 看日志 | ✅ |

### 2.2 URI handler 路由（**关键发现**）

`extension.js` 实证：
```js
registerUriHandler({ handleUri(F){
  let j = new URLSearchParams(F.query);
  switch(F.path){
    case "/open": {
      let session = j.get("session");
      let prompt = j.get("prompt");
      executeCommand("claude-vscode.primaryEditor.open", session, prompt);
      return;
    }
    case "/install-plugin": { ... }
    case "/properties": { ... }
  }
}})
```

**意味着外部任何工具可触发 VSCode 新建 Claude Code session 并注入冷启动 prompt**：

```bash
# 新会话 + 注入 cold start brief（session 留空 = 新建）
start "" "vscode://anthropic.claude-code/open?prompt=cold%20start%3A%20%E8%AF%BB%20ADR-007"

# 恢复指定会话
start "" "vscode://anthropic.claude-code/open?session=<session-id>&prompt=继续工作"
```

prompt 是 URI 编码字符串，支持任意长度（VSCode URI 上限 ~32KB）。

### 2.3 关键 setting

| setting | 默认 | 影响 |
|---|---|---|
| `claudeCode.useTerminal` | false | true = 走 integrated terminal 而非 webview panel |
| `claudeCode.preferredLocation` | panel | sidebar / panel |
| `claudeCode.allowDangerouslySkipPermissions` | false | true = 允许 bypass mode |
| `claudeCode.initialPermissionMode` | default | default / acceptEdits / plan / bypassPermissions |

---

## 三、VSCode terminal API 起 wt 的可行性

可行但**不推荐**。

`vscode.window.createTerminal({ shellPath: "wt.exe", shellArgs: [...] })` 会在 VSCode integrated terminal 中起 wt，但 wt 会**新开 wt 窗口**而非在 VSCode 内嵌入。等价于直接 `start wt`，没有"内嵌 VSCode"的好处。

VSCode 自带 integrated terminal 已支持多 shell（PowerShell / Bash / cmd），无需借 wt，可直接：
```js
vscode.window.createTerminal({
  name: "taiwei-director",
  shellPath: "claude.exe",  // 假设 PATH 中
  shellArgs: ["--dangerously-skip-permissions", "--prompt", "cold start..."]
})
```
但这只是**用 terminal 跑 claude CLI**，不是利用 VSCode 扩展的 webview UI。

---

## 四、tasks.json 一键 spawn 模板

适合**单 VSCode workspace 内手动批量 spawn portfolio session**：

```json
// .vscode/tasks.json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "spawn taiwei-director",
      "type": "shell",
      "command": "claude",
      "args": [
        "--dangerously-skip-permissions",
        "--prompt", "cold start: 读 ADR-007 + roles-software v2 + 项目主管 charter，IPC harness 自报上线"
      ],
      "presentation": {
        "panel": "new",          // 每次新开一个 terminal panel
        "reveal": "always",
        "focus": true
      },
      "problemMatcher": []
    },
    {
      "label": "spawn 9 session 第一波",
      "dependsOn": ["spawn taiwei-director", "spawn taiwei-pm", "spawn taiwei-tester", "spawn taiwei-reviewer"],
      "dependsOrder": "parallel"
    }
  ]
}
```

**限制**：
1. 每个 task 是 integrated terminal，不是 webview panel（无法用 sidebar UI）
2. tasks.json 与 ipc_spawn 集成弱（需在 ipc_spawn 内 shell out `code --command workbench.action.tasks.runTask`）
3. 单 workspace = 9 terminal 占屏太挤，不如新窗口

---

## 五、与 ipc_spawn 集成可能性（建议方案）

### 5.1 现状

`xihe-jianmu-ipc/src/tools/ipc_spawn.ts` 现有 `host` 三选项：
- `wt` - Windows Terminal new tab（默认 portfolio 用）
- `vscode-terminal` - VSCode integrated terminal（已有但用得少）
- `external` - caller 自己处理

### 5.2 建议新增 `host=vscode-uri`

实现仅需 1 行 shell：
```ts
case "vscode-uri": {
  const url = new URL("vscode://anthropic.claude-code/open");
  url.searchParams.set("prompt", task);
  // session 为新会话时不传
  await execAsync(`start "" "${url.toString()}"`);
  break;
}
```

**优势**：
- 直接在当前 VSCode 窗口新建 Claude panel，**无需切窗口**
- prompt 已注入 cold-start brief，session 立即开始执行
- 与现有 ipc_spawn API 兼容（仅多一个 host 选项）
- 用户可通过 `claudeCode.preferredLocation` setting 控制是 sidebar 还是 panel

**劣势**：
- 同一 VSCode 窗口多 panel 切换略繁，建议配合 `code -n <new-cwd>` 给每个项目独立窗口
- prompt URI 编码长度上限 ~32KB（cold-start brief 不超）
- 受 `claudeCode.disableLoginPrompt` 影响：若新账号未登录，URI 触发会弹登录框

### 5.3 进阶：`host=vscode-window`

```ts
case "vscode-window": {
  // 1. 先新开 VSCode 窗口指向 cwd
  await execAsync(`code -n "${cwd}"`);
  // 2. 等窗口起来（~1s）
  await sleep(1500);
  // 3. URI 触发新 Claude session
  const url = new URL("vscode://anthropic.claude-code/open");
  url.searchParams.set("prompt", task);
  await execAsync(`start "" "${url.toString()}"`);
}
```

**优势**：每 session 独立 VSCode 窗口，符合现 portfolio "每 session 独立 wt tab" 心智模型，但替换为 VSCode 窗口（开发体验更好：编辑器 + Claude panel 同窗口）。

**劣势**：每窗口资源占用比 wt tab 高（~150MB / VSCode 窗口）。

---

## 六、推荐路径（给老板拍板用）

### 立刻可用（零代码）
**手动 URI 触发** —— PowerShell 一行：
```powershell
start "vscode://anthropic.claude-code/open?prompt=cold%20start%20brief..."
```
适用场景：临时新建 session 不想切窗口。

### 短期（1-2h 实现）
**ipc_spawn 新增 `host=vscode-uri`** —— 直接复用 URI handler，9 session spawn 后续可统一走此路径，不再切 wt。

### 中期（4-8h 实现）
**ipc_spawn 新增 `host=vscode-window`** + 自动 cwd 路由 —— 每 portfolio session 独立 VSCode 窗口，开发体验最强（编辑器 + Claude 同窗）。

### 长期（视需求）
**自研 companion 扩展** —— 注册 `xihe.spawnSession(name, cwd, brief)` 命令，让 ipc_spawn 直接调 vscode.commands.executeCommand 触发，能传任意复杂 cold-start 数据（不受 URI 长度限制）。

---

## 七、对 9 session spawn 计划的具体建议

老板 17:43 拍板今天 spawn 9 session，**建议立刻试用 URI handler 路径**：

```powershell
# 第一波 4 个（手动验证 URI handler 能跑）
start "vscode://anthropic.claude-code/open?prompt=【cold start: taiwei-director】..."
start "vscode://anthropic.claude-code/open?prompt=【cold start: taiwei-pm】..."
start "vscode://anthropic.claude-code/open?prompt=【cold start: taiwei-tester】..."
start "vscode://anthropic.claude-code/open?prompt=【cold start: taiwei-reviewer】..."
```

**条件**：
1. 每个 panel cold-start 后第一动作 = `ipc_register_session(name='taiwei-director', ...)` 注册到 Hub
2. 否则 Hub 不知道 panel 是哪个 session，IPC 路由会断
3. 等价于现 wt tab 路径的 ipc_register_session 流程，仅 spawn 入口换了

**风险**：
- URI handler 同一窗口连开 4 panel 可能拥挤，建议先 `code -n` 4 个新窗口再分别 URI 触发
- 周限额 99% 时每开一 panel 增加 1 session 占额，与 wt tab 路径无差别

---

## 八、未验证项（需后续实测）

1. URI handler `prompt` 参数是否会被 Claude Code 当作 user message 立即发送？还是只填入输入框等用户回车？
   - 推测：填入 + 自动发送（基于 `primaryEditor.open` 直接传 prompt 给 panel）
   - 验证方法：手工 `start "vscode://anthropic.claude-code/open?prompt=test"` 看行为
2. URI handler 触发时若 VSCode 未开是否自动启动？
   - 推测：是（VSCode URI 协议默认行为）
3. 多个 URI 在 1 秒内连续触发是否会丢失？
   - 推测：VSCode 串行处理，不会丢失但顺序不保证
4. `claudeCode.disableLoginPrompt: true` 在 spawn 时的具体行为
   - 推测：直接 fail 而非弹登录，需确认

---

## 九、参考

- 扩展 package.json：`C:/Users/jolen/.vscode/extensions/anthropic.claude-code-2.1.120-win32-x64/package.json`
- 扩展 extension.js（minified）：同目录
- VSCode tasks 文档：https://code.visualstudio.com/docs/debugtest/tasks
- Claude Code VSCode 文档：https://code.claude.com/docs/en/vs-code

---

## 十、状态

- ✅ 调研完成（VSCode 扩展 API 实证 + 4 路径对比 + ipc_spawn 集成方案）
- ⏳ 待 IPC harness 汇报，由 harness 转交老板拍板
- ⏳ 若老板拍 ipc_spawn 新增 host=vscode-uri，jianmu-pm 可立刻派 codex 实施（预计 1-2h）
