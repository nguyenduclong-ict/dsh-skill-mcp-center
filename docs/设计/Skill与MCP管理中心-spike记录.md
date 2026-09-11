# Skill & MCP 管理中心 — Spike 记录

> 日期：2026-08-17
> 关联：`Skill与MCP管理中心-前置设计.md` §八
> 结论：三点假设**全部验证通过**，其中 `create` 的热启动路径比文档 D4 的表述更精确（见 §1.3）。
>
> ⚠️ **2026-09-12 更正（v0.4.3）**：§1.2 里 `└─ group.tree.write()   // 持久化回 cordis.yml` 这一行**不成立**，见下方 §1.5。

---

## 1. `ctx.loader.create` 热连接 MCP —— ✅ 通过

### 1.1 验证方法

读 `@deepseek-ai/cordis-plugin-loader` 源码（`lib/index.js`），追踪 `EntryTree.create` 的完整调用链。

### 1.2 代码路径

```
ctx.loader.create({ id, name:'mcp-client', config })
  └─ EntryTree.create (index.js:215)
       ├─ group.create(options)           (index.js:48)
       │    └─ entry.update(options, /*create*/true, /*force*/true)   (index.js:55)
       │         └─ 新 entry 无 fiber → `!previous?.uid` 成立
       │              └─ await this.init()  (index.js:416)
       │                   └─ _init() → import + start（热连接 MCP）
       └─ group.tree.write()              // 持久化回 cordis.yml
```

### 1.3 结论（比 D4 更精确）

- **新增 server 热生效** ✅：`create()` 会立即 `init()` → import + start 新的 `mcp-client`，**免重启、免手动 init**。
- **修改 config 热生效** ✅：`update(id, { config })` → `Entry.update` 只改 config 时（diff 不含 name/inject/group）走 `_patchContext` → `fiber.update(config)`，**热更新配置，不重启 fiber**。
- **删除 server 热下线** ✅：`remove(id)` → `entry._dispose()` → 断开连接 + 卸载工具。

三者都通过 `tree.write()` 持久化回 cordis.yml，所以「热生效 + 跨重启保留」都成立。

### 1.4 边界（写入实现注意）

`mcp-client` 的 `failOnStartupError` 默认 `false`：新增时如果 MCP server 连不上，**`create()` 仍返回成功**（fiber 是 active，进 reconnect loop）。所以 UI 不能用「create 成功」判断「已连接」，必须靠 §2 的工具数做二次确认——状态点绿/灰的判定依据不变。

### 1.5 更正：根 entry 不落盘（缺陷「退出 DSH 后 MCP 配置被清空」的根因，v0.4.3 修复）

上面那句「都通过 `tree.write()` 持久化回 cordis.yml」**是错的**——`tree.write()` 被调用不等于写了盘。`EntryTree.create(options, parent = null)` → `resolveGroup(null)` → **loader 自己的 root group**，其 `tree` 就是 `Loader` 实例，而 `@deepseek-ai/cordis-plugin-loader/src/index.ts` 写得很明确：

```ts
write() {
  // Loader's root tree is in-memory; writes are no-ops.
}
```

所以 v0.4.2 里 `ctx.loader.create({ ... })`（不传 parent）只产生**内存 entry**：当次进程内热连接可用，进程一退就彻底消失。DSH Desktop 每次启动都用 `dsh web --patch …` 重新组合 profile，磁盘上没有任何 MCP 行可以恢复——用户报告的「退出 DSH Desktop 再进来，MCP server 配置全没了」正是这个原因。

**为什么不能改成往 include 树里写**：唯一 file-backed 的树是根 include（`<profile>/cordis.yml`），而 `Include.write()` 写的是 `root.data` —— `applyEntryPatches` **已经把 bundle patch 行合并进同一份列表**，一次写入就会把整棵组合树摊平进 `cordis.yml`；下次启动时 bundle patch 的 `insert`（list 形式、无 id 去重）会再插一遍同样的 id，触发 `duplicate loader entry id`，Harness 直接起不来。桌面端自己也因此只改 `cordis.patch.yml`（文本级 patch 层），不碰 `cordis.yml`。

**v0.4.3 的修法**：插件自己持有 durable registry（`$DSH_HOME/plugins/skill-mcp-center/mcp-servers.json`，原子写入），`[Service.init]` 时用 `reconcileStoredServers()` 把每一行重建为 live entry，增删改一律「先写 registry，再热生效」。`managed` 标记把 registry 拥有的行与 `cordis.patch.yml` 定义的行分开：后者在设置页只读，避免经 include 树回写。

## 2. `ctx.tools` 枚举 MCP 工具数 —— ✅ 通过

`ctx.tools` 是 `ToolRuntime extends Service`（`packages/core/tools/src/index.ts:787`），公开 `schemas(scope?)` 返回 `ToolSchema[]`（`index.ts:1234`）：

```ts
schemas(scope?: ScopeKey): ToolSchema[] {
  return [...this.view(scope).visible.values()].map(d => this.schemaOf(d, true))
}
```

- 每个 MCP 工具以 `mcp__<serverName>__<rawName>` 注册（`dsh-mcp-client` 的命名契约）。
- 结论：`ctx.tools.schemas()` 过滤 `name.startsWith('mcp__' + serverName + '__')` 即可得每个 server 的工具数。**无需侵入 mcp-client**。

## 3. `dsh-better-sidebar.registerTab` 的 `visible` 语义 —— ✅ 通过

参考 `dsh-ssid-panels/src/client/index.tsx`（`apply`）：

```ts
ctx.inject(['betterSidebar'], (sidebarCtx) => {
  const service = sidebarCtx.betterSidebar
  sidebarCtx.effect(() => service.registerTab({
    id, title: () => '状态', icon, order, single: true,
    component: ({ visible }) => createElement(GuardianView, { visible }),  // ← visible prop
  }))
})
```

- `registerTab` 的 `component` 接收 `{ visible }`，`GuardianView` 在 `visible` 为 true 时才开 1s 轮询、不可见时 cleanup 停轮询。
- `single: true` 表示单例 tab。
- `betterSidebar` 是 optional peer（未装时 `ctx.inject(['betterSidebar'], …)` 不执行，设置页仍可用）。
- 结论：MCP 状态侧边栏 tab 完全复用此范式，零新机制。

---

## 结论汇总

| # | 假设 | 结果 | 依据 |
|---|---|---|---|
| 1 | `ctx.loader.create` 热连接 MCP | ✅ | `create → group.create → entry.update(true,true) → init()` |
| 2 | `ctx.tools.schemas()` 枚举 `mcp__` 工具数 | ✅ | `ToolRuntime.schemas()` 返回全量 `ToolSchema[]` |
| 3 | `registerTab` 的 `visible` 语义 | ✅ | `dsh-ssid-panels` 已用的 `component({visible})` |

**额外确认**：`update` 改 config 走 `fiber.update(config)` 热更新（不重启 fiber）；`remove` 走 `_dispose()` 热下线。三条路径都调用 `tree.write()`——但 root tree 的 `write()` 是 no-op（见 §1.5），持久化由 v0.4.3 起的 durable registry 负责。

**无阻塞项**，可直接进入实现（host SkillService / McpService + loopback RPC + client 设置分区 + 侧边栏 tab）。
