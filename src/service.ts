/**
 * `SkillMcpService` — the process-local composition of skill and MCP
 * management. Skills are read straight off disk (host-level skill-filesystem
 * is disabled in web-app — presets own discovery — so `ctx.skills` has no
 * global layer to list); MCP servers are the `mcp-client` loader entries,
 * managed hot through `ctx.loader` and observed through a feature-detected
 * `ctx.mcpStatus` seam with a derived fallback.
 *
 * Server definitions are durable: the loader's root tree is in-memory, so a
 * root entry alone would hot-connect for this process and vanish on the next
 * start. `McpServerStore` owns the definitions on disk and
 * `reconcileStoredServers` rebuilds the entries from them at every start —
 * see the store module for why the profile config cannot carry them.
 *
 * Rows may be bound to a workspace (`scope: 'workspace'`, or a `{workspace}`
 * token in `cwd`/`args`). The binding follows the session that is working —
 * observed through the `agent/pre-step` waterfall — so a per-project server
 * like `codegraph serve --mcp` reads the project the user actually has open
 * rather than the directory the harness was launched from.
 */
import { Service, type Context, type FiberState } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-tools'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { parseSkillFrontmatter, setDisableModelInvocation } from './frontmatter.ts'
import {
  McpServerStore,
  effectiveStoredServer,
  fullMcpConfig,
  isWorkspaceBound,
  mcpServerEntryId,
  mcpStorePath,
  normalizeStoredServer,
  reconcileStoredServers,
  spawnableRow,
  workspaceBindingOf,
  type McpConfig,
  type McpScope,
  type McpTransport,
  type StoredMcpServer,
} from './store.ts'

export type { McpConfig, McpScope, McpTransport, StoredMcpServer } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The skill/MCP center engine (provided by this package's host half). */
    skillMcp: SkillMcpService
  }
}

/** Specifier of the official MCP bridge; one loader entry = one MCP server. */
const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client'

/** Runtime mirror of cordis FiberState (a cross-package const enum). */
const FIBER_PHASE: Record<FiberState, string | null> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

/** One skill as the Settings surface exposes it. */
export interface SkillView {
  name: string
  description: string
  source: string
  provider: string
  modelInvocable: boolean
  userInvocable: boolean
  /** Always true — user-level skills are disk-backed and toggleable. */
  writable: boolean
  /** Absolute SKILL.md path (the toggle target; opaque to the client display). */
  path: string
}

/** Plugin configuration for the skill/MCP engine. */
export interface SkillConfig {
  /** Additional read-only official/bundled skill roots (e.g. the harness repo's own `.agents/skills`). */
  officialSkillDirs?: string[]
  /** Override of the durable MCP registry path (tests); defaults to `$DSH_HOME/plugins/skill-mcp-center/mcp-servers.json`. */
  storePath?: string
  /**
   * Apply the durable `boundWorkspace` of a workspace-bound row at startup.
   * The desktop keeps it on so a restart comes back on the project last used;
   * tests turn it off to exercise the "wait for the first session" path.
   */
  restoreWorkspaceBinding?: boolean
}

/** One MCP server as the Settings surface exposes it. */
export interface McpServer {
  id: string
  serverName: string
  transport: McpTransport
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  headers?: Record<string, string>
  disabled: boolean
  fiberPhase: string | null
  /**
   * True when this center owns the row in its durable registry. False means a
   * profile config file (e.g. `cordis.patch.yml`) defines the entry, so editing
   * it from here would write back through that file — the client keeps those
   * rows read-only.
   */
  managed: boolean
  /** Working-directory policy of the row. */
  scope: McpScope
  /** Workspace a workspace-bound row is (or was last) spawned for. */
  boundWorkspace?: string
  /**
   * The workspace the row currently follows, when it is bound to one. Undefined
   * for a plain `global` row that carries no `{workspace}` token.
   */
  workspace?: string
}

/** Runtime status of one MCP server (sidebar polling). */
export interface McpServerStatus {
  serverName: string
  fiberPhase: string | null
  toolCount: number
  connected: boolean
  statusSource: 'seam' | 'derived'
}

/** User-level skill roots (host-level filesystem discovery is preset-owned in web). */
const SKILL_ROOTS: readonly { path: string; source: string }[] = [
  { path: join(homedir(), '.dsh', 'skills'), source: 'user-dsh' },
  { path: join(homedir(), '.agents', 'skills'), source: 'user-agents' },
]

/** Absolute SKILL.md path for one directory/file entry, or null. */
function skillPathFor(root: string, name: string, isDirectory: boolean): string | null {
  if (isDirectory) return join(root, name, 'SKILL.md')
  if (name.endsWith('.md')) return join(root, name)
  return null
}

/** Scan one root for SKILL.md entries and parse their frontmatter. */
async function scanSkillRoot(root: string, source: string, writable = true, provider = 'filesystem'): Promise<SkillView[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return [] // root absent
  }
  const skills: SkillView[] = []
  for (const entry of entries) {
    const skillPath = skillPathFor(root, entry.name, entry.isDirectory())
    if (skillPath === null) continue
    let text
    try {
      text = await readFile(skillPath, 'utf8')
    } catch {
      continue
    }
    const fm = parseSkillFrontmatter(text)
    if (fm === null) continue
    skills.push({
      name: fm.name,
      description: fm.description,
      source,
      provider,
      modelInvocable: fm.modelInvocable,
      userInvocable: true,
      writable,
      path: skillPath,
    })
  }
  return skills
}

export class SkillMcpService extends Service {
  static inject = ['loader', 'tools']

  private readonly officialSkillDirs: readonly string[]
  private readonly store: McpServerStore
  private readonly restoreBinding: boolean
  /** Durable registry, loaded once per process and kept in step with writes. */
  private registryLoad?: Promise<StoredMcpServer[]>
  /** Workspace of the session that most recently started a step. */
  private workspace?: string
  /** Serializes workspace rebinds so two sessions cannot interleave spawns. */
  private bindings: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: SkillConfig = {}) {
    super(ctx, 'skillMcp')
    this.officialSkillDirs = config.officialSkillDirs ?? []
    this.store = new McpServerStore(config.storePath ?? mcpStorePath())
    this.restoreBinding = config.restoreWorkspaceBinding !== false
  }

  /**
   * Rebuild the live `mcp-client` entries from the durable registry and start
   * following the working session's workspace. This is what makes a server added
   * in an earlier DSH session come back connected in this one. Never throws: a
   * registry or server that cannot be restored must not fail plugin load.
   */
  async *[Service.init](): AsyncGenerator<() => void, void, unknown> {
    yield this.observeSessions()
    try {
      await this.restoreRegistry()
    } catch (error) {
      this.warn('failed to restore the MCP registry', error)
    }
  }

  /**
   * Follow the workspace of the session that is working.
   *
   * `agent/pre-step` fires before every model step with the agent, whose session
   * header carries the absolute workspace (`agent.session.header.cwd`) — the same
   * source the built-in instruction loader reads. Workspace-bound rows are
   * (re)spawned for it, which is how a per-project MCP server ends up looking at
   * the project the user has open instead of the harness launcher's directory.
   *
   * The rebind is awaited: `loader.create` resolves as soon as the entry's fiber
   * starts (`failOnStartupError` is false, so a slow server keeps connecting in
   * the background), which keeps the swap well inside one step and makes the
   * step's tool set match the workspace it is about to see. The hook is
   * feature-detected — a host without an agent loop simply never fires it.
   */
  private observeSessions(): () => void {
    const onEvent = (this.ctx as unknown as {
      on?: (name: string, handler: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => (() => void) | void
    }).on
    if (typeof onEvent !== 'function') return () => {}
    const dispose = onEvent.call(this.ctx, 'agent/pre-step', async (payload, next) => {
      const decision = await next()
      const cwd = sessionWorkspace(payload)
      if (cwd !== undefined && cwd !== this.workspace) {
        try {
          await this.bindWorkspace(cwd)
        } catch (error) {
          this.warn('failed to bind MCP servers to workspace %C', cwd)
          this.warn(error)
        }
      }
      return decision
    })
    return typeof dispose === 'function' ? dispose : () => {}
  }

  /** User-level skills plus, when a workspace is given, its project-level skills. */
  async listSkills(cwd?: string): Promise<SkillView[]> {
    const skills: SkillView[] = []
    for (const root of SKILL_ROOTS) {
      skills.push(...await scanSkillRoot(root.path, root.source))
    }
    if (cwd !== undefined && cwd !== '') {
      skills.push(...await scanSkillRoot(join(cwd, '.agents', 'skills'), 'project-agents'))
      skills.push(...await scanSkillRoot(join(cwd, '.dsh', 'skills'), 'project-dsh'))
    }
    for (const dir of this.officialSkillDirs) {
      skills.push(...await scanSkillRoot(dir, 'bundled', false, 'dsh-official'))
    }
    return skills
  }

  /** Flip one disk-backed skill's model invocation by rewriting its SKILL.md frontmatter. */
  async toggleSkill(path: string): Promise<SkillView> {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch {
      throw new Error('skill-not-found')
    }
    const fm = parseSkillFrontmatter(text)
    if (fm === null) throw new Error('skill-not-found')
    // Currently model-invocable → disable.
    await writeFile(path, setDisableModelInvocation(text, fm.modelInvocable), 'utf8')
    return {
      name: fm.name,
      description: fm.description,
      source: 'user',
      provider: 'filesystem',
      modelInvocable: !fm.modelInvocable,
      userInvocable: true,
      writable: true,
      path,
    }
  }

  /**
   * Read one skill's SKILL.md raw text for display. Paths must live under a
   * known skill root — a plain path join against the same roots `listSkills`
   * scans, so the RPC cannot be used to read arbitrary files.
   */
  async readSkill(path: string, cwd?: string): Promise<string> {
    const roots = [...SKILL_ROOTS.map(root => root.path)]
    if (cwd !== undefined && cwd !== '') {
      roots.push(join(cwd, '.agents', 'skills'), join(cwd, '.dsh', 'skills'))
    }
    roots.push(...this.officialSkillDirs)
    // Segment-boundary prefix check: a sibling directory like `skills-notes`
    // must not satisfy a `skills` root. join(root, '') normalizes to root.
    if (!roots.some(root => path === root || path.startsWith(`${root}${sep}`))) throw new Error('skill-not-found')
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch {
      throw new Error('skill-not-found')
    }
    return text
  }

  /** Every `mcp-client` loader entry as a server card. */
  async listMcpServers(): Promise<McpServer[]> {
    const live = new Map<string, Entry>()
    for (const entry of this.liveMcpEntries()) live.set(entry.id, entry)
    const servers: McpServer[] = []
    for (const row of await this.registry()) {
      const id = mcpServerEntryId(row.serverName)
      const entry = live.get(id)
      live.delete(id)
      const bound = isWorkspaceBound(row)
      const workspace = bound ? workspaceBindingOf(row, this.workspace) : undefined
      if (entry === undefined) {
        servers.push({ ...cardOfRow(row, workspace), id, managed: true })
        continue
      }
      // A live entry with this id that the center did not create belongs to a
      // profile config file; report the row it actually serves, read-only.
      const owned = this.ownsLiveEntry(id)
      servers.push({
        ...cardOfEntry(entry, { scope: bound ? 'workspace' : 'global', boundWorkspace: row.boundWorkspace, workspace }),
        managed: owned,
      })
      if (!owned) this.warn('profile config entry %C shadows the durable row of the same id', id)
    }
    // Entries this center does not own: rows a profile config file defines.
    for (const entry of live.values()) {
      servers.push({ ...cardOfEntry(entry, { scope: 'global' }), managed: false })
    }
    return servers
  }

  /**
   * Add one server: the definition is written to the durable registry first, so
   * a connect failure can never cost the user the row, then the entry is created
   * — which hot-connects it (create → import → start).
   */
  async createMcpServer(config: McpConfig): Promise<{ id: string }> {
    const row = normalizeStoredServer({ ...config, disabled: false })
    const id = mcpServerEntryId(row.serverName)
    const registry = await this.registry()
    if (registry.some(server => server.serverName === row.serverName) || this.liveEntry(id) !== undefined) {
      throw new Error('mcp-server-exists')
    }
    await this.writeRegistry([...registry, row])
    try {
      await this.syncEntry(row)
    } catch (error) {
      await this.writeRegistry(registry)
      throw error
    }
    return { id }
  }

  /** Rewrite one server's config — durable row first, then the live fiber. */
  async updateMcpServer(id: string, config: McpConfig): Promise<void> {
    const registry = await this.registry()
    const index = registry.findIndex(server => mcpServerEntryId(server.serverName) === id)
    if (index < 0) throw new Error('mcp-server-file-managed')
    this.assertOwned(id)
    const previous = registry[index]!
    const row = normalizeStoredServer({
      ...config,
      disabled: previous.disabled,
      // The binding is host-managed state, not part of what the form submits.
      boundWorkspace: previous.boundWorkspace,
    })
    const nextId = mcpServerEntryId(row.serverName)
    if (registry.some((server, at) => at !== index && server.serverName === row.serverName)) {
      throw new Error('mcp-server-exists')
    }
    const next = [...registry]
    next[index] = row
    await this.writeRegistry(next)
    if (nextId !== id) {
      // The entry id is derived from the name, so a rename moves the entry.
      await this.removeLiveEntry(id)
      this.warn('renamed MCP server %C', id)
    }
    await this.syncEntry(row)
  }

  /** Remove one server — drops the durable row, then disconnects and unregisters its tools. */
  async removeMcpServer(id: string): Promise<void> {
    const registry = await this.registry()
    const index = registry.findIndex(server => mcpServerEntryId(server.serverName) === id)
    if (index < 0) throw new Error('mcp-server-file-managed')
    this.assertOwned(id)
    await this.writeRegistry(registry.filter((_, at) => at !== index))
    await this.removeLiveEntry(id)
  }

  /** Enable/disable one server without deleting its config. */
  async setMcpServerEnabled(id: string, enabled: boolean): Promise<void> {
    const registry = await this.registry()
    const index = registry.findIndex(server => mcpServerEntryId(server.serverName) === id)
    if (index < 0) throw new Error('mcp-server-file-managed')
    this.assertOwned(id)
    const row: StoredMcpServer = { ...registry[index]!, disabled: !enabled }
    const next = [...registry]
    next[index] = row
    await this.writeRegistry(next)
    await this.syncEntry(row)
  }

  /** Point one server at a workspace without waiting for the UI (RPC/`agent` seam). */
  async setMcpServerWorkspace(id: string, workspace: string): Promise<void> {
    const registry = await this.registry()
    const row = registry.find(s => mcpServerEntryId(s.serverName) === id)
    if (row === undefined) throw new Error('mcp-server-file-managed')
    this.assertOwned(id)
    await this.bindWorkspaceRows(workspace, [row])
  }

  /** Runtime status per server: upstream `mcpStatus` seam when present, else derived. */
  async mcpStatus(): Promise<McpServerStatus[]> {
    const servers = await this.listMcpServers()
    const seam = (this.ctx as Context).get(
      'mcpStatus',
    ) as { list(): { serverName: string; phase: string; toolCount: number }[] } | undefined
    if (seam !== undefined) {
      const byName = new Map(seam.list().map(s => [s.serverName, s]))
      return servers.map(s => {
        const st = byName.get(s.serverName)
        return {
          serverName: s.serverName,
          fiberPhase: s.fiberPhase,
          toolCount: st?.toolCount ?? 0,
          connected: st?.phase === 'connected',
          statusSource: 'seam',
        }
      })
    }
    const toolNames = this.ctx.tools.schemas().map(s => s.name)
    return servers.map(s => {
      const prefix = `mcp__${s.serverName}__`
      const toolCount = toolNames.filter(n => n.startsWith(prefix)).length
      return {
        serverName: s.serverName,
        fiberPhase: s.fiberPhase,
        toolCount,
        connected: !s.disabled && s.fiberPhase === 'active' && toolCount > 0,
        statusSource: 'derived',
      }
    })
  }

  /** Every live `mcp-client` entry, whatever tree owns it. */
  private liveMcpEntries(): Entry[] {
    const entries: Entry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.name === MCP_CLIENT_NAME) entries.push(entry)
    }
    return entries
  }

  /** One live entry by id, or undefined when it is not mounted. */
  private liveEntry(id: string): Entry | undefined {
    try {
      const entry = this.ctx.loader.resolve(id)
      return entry.options.name === MCP_CLIENT_NAME ? entry : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Whether this center created the live entry. Only entries in the loader's own
   * root store are ours; an entry inside a nested (file-backed) tree is written
   * back through that file, so the center must never mutate it.
   */
  private ownsLiveEntry(id: string): boolean {
    return this.ctx.loader.store[id] !== undefined
  }

  /** Refuse to touch a live entry a profile config file owns. */
  private assertOwned(id: string): void {
    if (this.liveEntry(id) !== undefined && !this.ownsLiveEntry(id)) throw new Error('mcp-server-file-managed')
  }

  /** Create the live entry for one row (id, config, disabled state). */
  private async createEntry(row: StoredMcpServer, workspace: string | undefined = this.workspace): Promise<void> {
    await this.ctx.loader.create({
      id: mcpServerEntryId(row.serverName),
      name: MCP_CLIENT_NAME,
      config: fullMcpConfig(effectiveStoredServer(row, workspace)),
      disabled: row.disabled ? true : null,
    } as never)
  }

  /**
   * Make the live entry match one durable row under `workspace`.
   *
   * A changed `cwd`/`args` needs a respawn, not a config patch: the loader
   * hot-applies a config-only update through `fiber.update(config)`, which never
   * restarts the MCP child, so the old working directory would stay in force. A
   * disabled row keeps its entry — config intact, fiber unloaded — so enabling it
   * stays a hot toggle; a row that cannot be spawned at all has no entry.
   */
  private async syncEntry(row: StoredMcpServer, workspace: string | undefined = this.workspace): Promise<void> {
    const id = mcpServerEntryId(row.serverName)
    if (!spawnableRow(row, workspace)) {
      await this.removeLiveEntry(id)
      return
    }
    const entry = this.liveEntry(id)
    const desired = fullMcpConfig(effectiveStoredServer(row, workspace))
    const disabled = row.disabled === true
    if (entry !== undefined && sameMcpConfig(entry.options.config, desired)) {
      // Same process target: only the enable state can still differ.
      if (entry.disabled !== disabled) await this.ctx.loader.update(id, { disabled: disabled ? true : null })
      return
    }
    await this.removeLiveEntry(id)
    await this.createEntry(row, workspace)
  }

  /** Drop a live entry when it is mounted; a missing entry is already the goal. */
  private async removeLiveEntry(id: string): Promise<void> {
    if (this.liveEntry(id) === undefined) return
    await this.ctx.loader.remove(id)
  }

  /**
   * Bind every workspace-bound row to `workspace`.
   *
   * Serialized through {@link bindings} so two sessions starting steps at once
   * cannot interleave a remove with the other one's create.
   */
  private bindWorkspace(workspace: string): Promise<void> {
    const rebind = async () => {
      // The new workspace is current before the rows are touched: `syncEntry`
      // resolves each row's effective config against it.
      this.workspace = workspace
      const registry = await this.registry()
      await this.bindWorkspaceRows(workspace, registry.filter(row => isWorkspaceBound(row)))
    }
    const run = this.bindings.then(rebind, rebind)
    this.bindings = run.then(() => {}, () => {})
    return run
  }

  /** Rebind the given rows to one workspace, persisting the binding as it goes. */
  private async bindWorkspaceRows(workspace: string, rows: readonly StoredMcpServer[]): Promise<void> {
    for (const row of rows) {
      const id = mcpServerEntryId(row.serverName)
      const bound: StoredMcpServer = { ...row, boundWorkspace: workspace }
      if (row.disabled === true) {
        // Nothing is running, so there is no process to re-point: record the
        // binding and let the enable path spawn against the freshest one.
        if (row.boundWorkspace !== workspace) await this.replaceRow(bound)
        continue
      }
      const desired = fullMcpConfig(effectiveStoredServer(bound, workspace))
      const entry = this.liveEntry(id)
      const inPlace = entry !== undefined && sameMcpConfig(entry.options.config, desired)
      if (inPlace) {
        // Nothing to respawn; only remember the binding for the next start.
        if (row.boundWorkspace !== workspace) await this.replaceRow(bound)
        continue
      }
      await this.replaceRow(bound)
      await this.syncEntry(bound, workspace)
      this.log('bound MCP server %C to workspace %C', id, workspace)
    }
  }

  /** Store one updated row, leaving the rest of the registry untouched. */
  private async replaceRow(row: StoredMcpServer): Promise<void> {
    const registry = await this.registry()
    const index = registry.findIndex(server => server.serverName === row.serverName)
    if (index < 0) return
    const next = [...registry]
    next[index] = row
    await this.writeRegistry(next)
  }

  /** The durable registry: read once per process, cached until a write replaces it. */
  private registry(): Promise<StoredMcpServer[]> {
    this.registryLoad ??= this.readRegistry()
    return this.registryLoad
  }

  /** Read the registry; an unreadable or corrupt file degrades to empty, never to a failed plugin. */
  private async readRegistry(): Promise<StoredMcpServer[]> {
    try {
      return await this.store.load()
    } catch (error) {
      this.warn('unreadable MCP registry %C', this.store.path)
      this.warn(error)
      return []
    }
  }

  /** Persist `next` and keep the cache in step with the file. */
  private async writeRegistry(next: StoredMcpServer[]): Promise<void> {
    await this.store.save(next)
    this.registryLoad = Promise.resolve(next)
  }

  /**
   * Load the registry and rebuild every live entry it describes, then remember
   * which workspace the workspace-bound rows are on so the first step of the
   * next session does not respawn them for nothing.
   */
  private async restoreRegistry(): Promise<void> {
    const rows = await this.registry()
    if (rows.length === 0) return
    if (!this.restoreBinding && rows.some(row => row.boundWorkspace !== undefined)) {
      // Tests (and hosts that prefer a clean slate) drop stale bindings first.
      await this.writeRegistry(rows.map(({ boundWorkspace: _dropped, ...row }) => row))
      return
    }
    await this.dropMissingBindings()
    const report = await reconcileStoredServers(
      await this.registry(),
      this.ctx.loader,
      MCP_CLIENT_NAME,
      (format, ...param) => { this.warn(format, ...param) },
    )
    this.workspace = (await this.registry()).find(row => row.boundWorkspace !== undefined)?.boundWorkspace
    if (report.created.length > 0) this.log('restored %C MCP server(s) from the durable registry', report.created.length)
    if (report.failed.length > 0) this.warn('%C MCP server(s) could not be restored', report.failed.length)
  }

  /**
   * Forget a binding whose directory is gone (a deleted or moved project), so
   * the row waits for the next session instead of spawning against a stale path.
   */
  private async dropMissingBindings(): Promise<void> {
    const rows = await this.registry()
    const stale = new Set<string>()
    for (const row of rows) {
      if (row.boundWorkspace === undefined) continue
      try {
        await stat(row.boundWorkspace)
      } catch {
        stale.add(row.serverName)
      }
    }
    if (stale.size === 0) return
    await this.writeRegistry(rows.map(row => stale.has(row.serverName) ? { ...row, boundWorkspace: undefined } : row))
    this.warn('forgot %C workspace binding(s) whose directory no longer exists', stale.size)
  }

  /** Best-effort named logger; logging must never break a management call. */
  private log(format: unknown, ...param: unknown[]): void {
    try {
      this.ctx.logger('skill-mcp-center').info(format, ...param)
    } catch {
      // The logger service is optional for this plugin's own correctness.
    }
  }

  /** Best-effort named warning; see {@link log}. */
  private warn(format: unknown, ...param: unknown[]): void {
    try {
      this.ctx.logger('skill-mcp-center').warn(format, ...param)
    } catch {
      // The logger service is optional for this plugin's own correctness.
    }
  }
}

/** Card fragment for one durable row with no live entry. */
function cardOfRow(row: StoredMcpServer, workspace?: string): ServerCard {
  return {
    serverName: row.serverName,
    transport: row.transport,
    command: row.command,
    args: row.args,
    cwd: row.cwd,
    url: row.url,
    headers: row.headers,
    disabled: row.disabled,
    fiberPhase: null,
    scope: row.scope ?? 'global',
    boundWorkspace: row.boundWorkspace,
    workspace,
  }
}

/** Working-directory facts a card needs, which the entry config itself cannot carry. */
interface CardScope {
  scope: McpScope
  boundWorkspace?: string
  workspace?: string
}

/** Card fragment for one live loader entry. */
function cardOfEntry(entry: Entry, scope: CardScope): EntryCard {
  const cfg = entry.options.config as Partial<McpConfig> | undefined
  return {
    id: entry.id,
    serverName: cfg?.serverName ?? entry.id,
    transport: cfg?.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    command: cfg?.command,
    args: cfg?.args,
    cwd: cfg?.cwd,
    url: cfg?.url,
    headers: cfg?.headers,
    disabled: entry.disabled,
    fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
    scope: scope.scope,
    boundWorkspace: scope.boundWorkspace,
    workspace: scope.workspace,
  }
}

/** Everything a durable-row card carries except the id its caller supplies. */
type ServerCard = Omit<McpServer, 'id' | 'managed'>

/** Everything a live-entry card carries except the ownership flag. */
type EntryCard = Omit<McpServer, 'managed'>

/** Workspace path of the agent behind one `agent/pre-step` payload, if any. */
function sessionWorkspace(payload: unknown): string | undefined {
  const agent = (payload as { agent?: { session?: { header?: { cwd?: unknown } } } } | undefined)?.agent
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** Whether two resolved mcp-client configs describe the same server process. */
function sameMcpConfig(current: unknown, desired: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(current) === JSON.stringify(desired)
  } catch {
    return false
  }
}

export default SkillMcpService
