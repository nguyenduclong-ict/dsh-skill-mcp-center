# dsh-skill-mcp-center

本插件属于 **`@max-null/*` 插件系列**——这一系列共同构成 **[SSID（思灵 · Seek Soul in Darkness）](https://github.com/Max-Null/seek-soul-in-darkness)** 桌面体验。SSID 是整合它们的盒：`dsh-capture` · `dsh-chat-rail` · `dsh-chinese-thinking` · `dsh-draft-polish` · `dsh-guardian` · `dsh-habit` · `dsh-memory` · `dsh-node-appearance` · `dsh-plugin-center` · `dsh-quick-toolbar` · `dsh-skill-mcp-center` · `dsh-ssid-panels` · `dsh-ssid-zh-ui` · `dsh-achievements`。

This plugin belongs to the **`@max-null/*` family** — a set of plugins that together form the **[SSID (思灵 · Seek Soul in Darkness)](https://github.com/Max-Null/seek-soul-in-darkness)** desktop experience.

Skill & MCP management center for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — manage skills and MCP servers in Settings, with live MCP status in the sidebar.

Skill 与 MCP 管理中心：在设置里管理 skills 与 MCP 服务器，右侧边栏查看 MCP 实时状态。

## Features / 功能

- **Skill management / Skill 管理** — browse every skill by tier (system / user / workspace / runtime), toggle model invocation via the `disable-model-invocation` frontmatter (disk-backed skills only).
- **MCP management / MCP 管理** — add / edit / remove `mcp-client` servers, enable/disable without deleting config, all **hot-applied** through `ctx.loader` (no restart) **and persisted**: the definitions live in a durable registry and are rebuilt as live entries at every start, so they survive an app restart (v0.4.3 fix — a root loader entry alone is in-memory only).
- **Workspace-scoped servers / 跟随 workspace** — a server can follow the project the session is working in: set its working directory to *follow workspace* (or put the `{workspace}` placeholder in `cwd`/`args`) and its entry is respawned with that path whenever the active project changes. This is what makes per-project servers such as `codegraph serve --mcp` look at the open project instead of the launcher's directory (v0.4.4).
- **Live status / 实时状态** — a sidebar "MCP" tab (via `dsh-better-sidebar`) showing per-server connection state + tool count, polled while visible and following the session.
- **Skin-compatible / 皮肤兼容** — every color uses `var(--dsw-*)` tokens.

## MCP persistence / MCP 持久化

The loader's root entry tree is in-memory (`Loader.write()` is a no-op), so MCP servers are stored by this plugin instead:

| Item | Path |
|---|---|
| Durable registry | `$DSH_HOME/plugins/skill-mcp-center/mcp-servers.json` (`$DSH_HOME` = `~/.dsh`, or the app's own `harness` dir under DSH Desktop) |
| Live entries | `mcp-client` loader entries created at start by `reconcileStoredServers()` |

Every add / edit / remove / enable writes the registry first, then hot-applies the entry — a failed connect never loses the row, and a corrupt registry file is moved aside as `mcp-servers.json.corrupt-<ts>` instead of being silently dropped. Servers defined by a profile config file (`cordis.patch.yml`) are shown as read-only, because writing them back would rewrite that file.

### Workspace binding / 绑定 workspace

| Row field | Meaning |
|---|---|
| `scope: 'workspace'` | The entry is (re)spawned with `cwd` = the workspace of the session that is working |
| `{workspace}` in `cwd` or `args` | Replaced with that same path (works on any row, e.g. `args: ["serve", "--mcp", "--path", "{workspace}"]`) |
| `boundWorkspace` | Host-managed: the workspace the row was last bound to, reused on the next start |
| `scope: 'global'` (default) | Unchanged behaviour: the row keeps its own `cwd` |

The binding follows the session through the `agent/pre-step` waterfall (`agent.session.header.cwd`), so switching projects respawns the server against the new project. A workspace-scoped row that has never been bound is not started at all until the first step picks a project — that is deliberate, since starting it against the launcher's directory is what made `codegraph` report "No CodeGraph project is loaded for this session". Example:

```json
{ "serverName": "codegraph", "transport": "stdio", "scope": "workspace",
  "command": "codegraph", "args": ["serve", "--mcp"], "disabled": false }
```

## Install / 安装

```sh
dsh plugin --profile web add github:Max-Null/dsh-skill-mcp-center
# or from npm, once published / 或通过 npm（发布后）
dsh plugin --profile web add @max-null/dsh-skill-mcp-center
```

Restart `dsh web`, then open Settings → Skill & MCP. The sidebar "MCP" tab appears only when `dsh-better-sidebar` is installed (optional peer).

## Development / 开发

```sh
pnpm install
pnpm build   # tsc (host) + esbuild (browser bundle)
```

## License / 许可

[MIT](./LICENSE)

## SSID 系列

