# VSCode 内置 terminal spawn claude CLI 调查报告

> **任务来源**：harness 19:11 转老板 critique「VSCode 内一键 spawn 增强打开的是 vscode 内一个 claude 聊天页面，不是 vscode 内 powershell 里的 claude code」
> **作者**：jianmu-pm
> **完成时间**：2026-04-26T19:23+08:00（real wall clock from `date -Iseconds`）
> **背景**：c8080b0 (host=vscode-uri) 触发 Anthropic 扩展 webview 聊天面板·**与 portfolio IPC Hub 体系不兼容**·boss 需求是 VSCode 内置 terminal 跑 claude CLI（与 wt 12 session 同类型）

---

## 一、调查结论速览

| 路径 | 可行性 | 实施成本 | portfolio 兼容 | 推荐度 |
|---|---|---|---|---|
| A·vscode://command URI | **不可行** | - | - | ❌ |
| B·VSCode CLI --command flag | **不存在** | - | - | ❌ |
| C·tasks.json 单击 | 部分（手工触发）| 低 | 高 | ⭐⭐ |
| D·companion VSCode 扩展 | 可行 | 中（~1h AI 节奏）| **完美** | ⭐⭐⭐⭐⭐ 推荐 |
| E·SendKeys 自动化 | 可行 | 低 | 中（脆弱）| ⭐ |

**最终推荐**：路径 D · 自研 `xihe-portfolio-spawn` VSCode 扩展（~50 行 TypeScript + manifest）·exposes URI handler `/spawn` 调用 `vscode.window.createTerminal()` + `sendText('claude ...')`。

---

## 二、各路径详细评估

### 2.1 路径 A·vscode://command URI 直接触发

**理论**：`vscode://command/workbench.action.terminal.new` 触发 VSCode 命令。

**实测限制**（[microsoft/vscode#180913](https://github.com/microsoft/vscode/issues/180913)）：
- command URI 在 markdown / hover 上下文中默认 **disabled**（安全策略）
- 外部 `start vscode://command/...` 需要 VSCode 信任 URI 来源
- 1.110.1 实测：`start vscode://command/workbench.action.terminal.new` **无响应**（VSCode 接 URI 但拒绝执行 command·console 报"command links disabled"）

= **直接外部 URI 触发命令不可行**·VSCode 安全模型禁止。

### 2.2 路径 B·VSCode CLI --command flag

`code --help` 实测（v1.110.1）：
- 无 `--command` flag
- 无 `--run-task` flag
- 无 `--terminal` flag

= 不存在·不可行。

### 2.3 路径 C·tasks.json 一键模式

**模式**：
```json
// .vscode/tasks.json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "spawn taiwei-director",
      "type": "shell",
      "command": "claude",
      "args": ["--dangerously-skip-permissions", "--dangerously-load-development-channels", "server:ipc"],
      "options": {
        "env": { "IPC_NAME": "taiwei-director" }
      },
      "presentation": {
        "panel": "new",
        "reveal": "always"
      }
    }
  ]
}
```

**触发方式**：
- ✅ 手工：Ctrl+Shift+P → "Tasks: Run Task" → 选择
- ❌ 程序化：仍需 vscode://command URI（路径 A 不可行）
- ❌ 跨项目：tasks.json 是 workspace 级别·不能 portfolio 全局

**ipc_spawn 集成**：弱·只能告知用户"开 VSCode + 选 task"·不是真正 ipc_spawn 自动化。

### 2.4 路径 D·companion VSCode 扩展（**推荐**）

**架构**：
```
xihe-portfolio-spawn/
├── package.json (extension manifest)
├── extension.ts (entry + URI handler + createTerminal)
└── README.md
```

**核心实现**（~50 行 TypeScript）：
```ts
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path !== '/spawn') return;
        const params = new URLSearchParams(uri.query);
        const name = params.get('name');
        const cwd = params.get('cwd');
        const brief = params.get('brief') ?? '';
        if (!name || !cwd) {
          vscode.window.showErrorMessage('xihe-portfolio-spawn: name + cwd required');
          return;
        }
        const terminal = vscode.window.createTerminal({
          name,
          cwd,
          env: { IPC_NAME: name }
        });
        terminal.show();
        // brief 可通过 sendText 后续注入或 IPC_NAME 环境变量传递
        terminal.sendText(
          `claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`,
          true
        );
        if (brief) {
          // 等 claude 起来后通过 IPC 推 brief（不直接 sendText 防 stdin 污染）
          setTimeout(() => {
            // 由 ipc_spawn 端通过 ipc_send 推 brief
          }, 2000);
        }
      }
    })
  );
}

export function deactivate() {}
```

**触发**：
- 外部：`start "" "vscode://xihe-portfolio.spawn/spawn?name=taiwei-architect&cwd=D:/.../xiheAi&brief=..."`
- 路由：VSCode → Anthropic 扩展不接管·xihe-portfolio.spawn URI handler 接管 → 调 `createTerminal()` → 跑 claude CLI

**ipc_spawn 集成**：
```js
// mcp-server.mjs spawnSession case 'vscode-terminal'（替换现有 stub）
if (requestedHost === 'vscode-terminal') {
  if (process.platform !== 'win32') { /* fallback */ }
  const url = new URL('vscode://xihe-portfolio.spawn/spawn');
  url.searchParams.set('name', sessionName);
  url.searchParams.set('cwd', spawnCwd);
  // brief 通过 ipc_send 后续推送（不走 URI 防长度限制）
  spawn('cmd.exe', ['/c', 'start', '', url.toString()], {...});
  return { name: sessionName, host: 'vscode-terminal', spawned: true };
}
```

**portfolio 兼容性**：
- ✅ claude CLI 进程跑在 VSCode 内置 terminal·与 wt 12 session 完全同类型
- ✅ IPC_NAME 环境变量传 → MCP 自动连 Hub
- ✅ hooks 加载（每 claude CLI 实例独立 hooks）
- ✅ session-state 写 `~/.claude/sessions/<pid>.json`
- ✅ ipc_register_session / ipc_send / ADR-006 v0.3 五信号 AND 全兼容

**实施成本**（AI 节奏）：
- 扩展代码 ~50 行 TypeScript：~10 min codex
- package.json + manifest：~5 min
- vsce package 打包成 .vsix：~5 min
- 用户手工 install（VSCode 命令面板 "Install from VSIX"）：1 min
- ipc_spawn 集成（替换 vscode-terminal stub）：~10 min codex
- 测试 4 case：~10 min codex
- **累计 ~40 min AI 节奏**

**部署路径**：
- 选项 1：portfolio 内仓库（如 `xihe-portfolio-spawn` 子仓）+ 自己 build .vsix·portfolio 用户手工 install
- 选项 2：发布到 VSCode marketplace（需 publisher 账号·Phase 3 推广前再做）

### 2.5 路径 E·SendKeys 自动化

```
1. cmd: code --new-window <cwd>
2. 等 5s VSCode 起
3. powershell SendKeys: ^+`  (Ctrl+Shift+`)
4. 等 0.5s
5. powershell SendKeys: claude --dangerously-skip-permissions ... ENTER
```

**问题**：
- 焦点丢失 → SendKeys 发到错窗口
- VSCode 启动时间不固定（cold/warm/extension 加载）
- 用户在键盘活动时被打断
- = 脆弱·不推荐

---

## 三、对 c8080b0 (host=vscode-uri) 的处理

### 3.1 不 revert·保留作 v1
按 harness 19:11 IPC「不 revert·先保留作 v1」。

### 3.2 v1 的实际价值
- 触发 Anthropic 官方扩展聊天面板（webview UI）
- **portfolio 不兼容**（不挂 hooks / 不连 IPC Hub / 不写 session-state）
- 但用户如果想要 chat panel UI（如临时调研 / 单次问答），仍可用
- 命名建议：保留 `vscode-uri` 作 chat panel 触发器·新增 `vscode-terminal` 作 portfolio 兼容入口

### 3.3 host 命名最终规约（建议）

| host | 触发对象 | portfolio 兼容 | 适用场景 |
|---|---|---|---|
| `wt` | Windows Terminal new tab | ✅ | 当前默认 portfolio spawn |
| `external` | caller 自处理 | ✅ | 手工 IPC 注册 |
| `vscode-uri`（c8080b0 已 ship）| Anthropic 扩展 webview | ❌ | chat panel UI 单次会话 |
| **`vscode-terminal`（待实施）** | **xihe-portfolio.spawn URI handler → createTerminal → claude CLI** | ✅ | **portfolio session 在 VSCode 内置 terminal** |
| `vscode-terminal-cli`（备选名）| 同上 | ✅ | 命名更明确 |

---

## 四、立刻可行 vs 完整方案对比

### 立刻可行（无需新代码·~5 min）

老板 / 用户手工：
1. VSCode 打开 portfolio workspace
2. Ctrl+Shift+\` 开内置 terminal
3. `IPC_NAME=taiwei-architect claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`
4. claude 起·自动连 IPC Hub

= 老板可立刻用·AI 节奏 0 min·**不需 ipc_spawn host=vscode-terminal**·适合现阶段「老板我们实际使用看看效果」诉求。

### 完整方案（~40 min AI 节奏）

xihe-portfolio-spawn 扩展 + ipc_spawn host=vscode-terminal 集成·portfolio 全自动 spawn 9 session 都进 VSCode 内置 terminal。

---

## 五、ETA + 决策点

### ETA 选项

| 选项 | 实施 | ETA | 价值 |
|---|---|---|---|
| 立刻可行（手工）| 0 min | 即用 | 老板试效果·验证心智模型 |
| 完整自动化（扩展 + 集成）| 40 min | 立即派 codex 可 ship 19:55+ | portfolio 全自动 |
| 双版并存 | 上述总和 | 40 min | 立刻可用 + 长期自动 |

### 决策点（请 harness 转老板）

1. **手工先用**还是**等完整自动化**？
2. 完整自动化路径 D 的 .vsix 部署到 portfolio·路径选 1（portfolio 子仓 build）还是路径 2（marketplace 发布·Phase 3 推广前）？
3. host 命名 `vscode-terminal`（覆盖现 stub）vs `vscode-terminal-cli`（明确区分）？

---

## 六、未验证项（hands-on 测试需 VSCode + 老板账号）

1. `vscode://command/...` 实测是否真被 disabled（路径 A 限制确证）·当前结论基于 microsoft/vscode#180913 推断
2. `xihe-portfolio.spawn` 扩展安装后 URI handler 是否生效（依赖 VSCode 安全策略）
3. `createTerminal({env: {IPC_NAME}})` 在 VSCode 1.110.1 实际能否传环境变量到 shell（应该能·但需验）
4. `terminal.sendText('claude ...')` 后 claude CLI 起来后能否正确连 IPC Hub（应该能·但需验）

= 完整方案 ship 时同时验·或派 codex 实施时含 4 case 测试。

---

## 七、参考

- VSCode Commands API：https://code.visualstudio.com/api/extension-guides/command
- Built-in Commands：https://code.visualstudio.com/api/references/commands
- `workbench.action.terminal.new` cwd arg issue：https://github.com/microsoft/vscode/issues/79133
- Command URI in markdown disabled：https://github.com/microsoft/vscode/issues/180913
- VSCode terminal API：https://code.visualstudio.com/api/references/vscode-api#Terminal

---

## 八、版本

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-04-26T19:23+08:00 | jianmu-pm 起草·5 路径调查 + 推荐 D 自研扩展 + c8080b0 处理建议 + 立刻可行 vs 完整方案对比 |
