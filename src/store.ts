/**
 * Durable half of the MCP surface: the server definitions the center owns.
 *
 * The loader's ROOT tree is in-memory — `Loader.write()` is documented as
 * `// Loader's root tree is in-memory; writes are no-ops.` in
 * `@deepseek-ai/cordis-plugin-loader/src/index.ts` — so an entry created with
 * `ctx.loader.create({ ... })` and no parent lives only in RAM: it hot-connects
 * for the current process and the next DSH start composes the profile afresh
 * with no trace of it. That is why the center keeps the definitions here and
 * rebuilds the live entries from this file on every start.
 *
 * Persisting through the profile config instead is deliberately avoided. The
 * only file-backed tree is the root include (`<profile>/cordis.yml`), and its
 * `write()` stores the whole composed entry list — bundle-patch rows included —
 * which the next boot's `insert` patches would then re-insert as duplicates.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Transport discriminant of an `mcp-client` server. */
export type McpTransport = 'stdio' | 'streamable-http'

/**
 * How a row's working directory is decided.
 *
 * `global` (default) — whatever `cwd` the row carries; an empty `cwd` inherits
 * the harness process directory.
 * `workspace` — the entry is (re)spawned with `cwd` bound to the workspace of
 * the session that is working, so per-project servers (codegraph, language
 * servers, per-repo tooling) look at the project the user actually has open
 * instead of the launcher's directory.
 */
export type McpScope = 'global' | 'workspace'

/** Placeholder replaced with the bound workspace path in `cwd` and `args`. */
export const WORKSPACE_TOKEN = '{workspace}'

/** Client-supplied MCP server config, normalized to the mcp-client shape. */
export interface McpConfig {
  serverName: string
  transport: McpTransport
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  headers?: Record<string, string>
  /** Working-directory policy; see {@link McpScope}. */
  scope?: McpScope
}

/**
 * One durable server row: the mcp-client config plus its enable/disable state,
 * its working-directory policy, and the workspace it was last bound to.
 */
export interface StoredMcpServer extends McpConfig {
  disabled: boolean
  /** Host-managed: last workspace a `workspace`-scoped (or `{workspace}`-using) row was spawned for. */
  boundWorkspace?: string
}

/** On-disk store document. */
interface StoreFile {
  version: 1
  servers: StoredMcpServer[]
}

/** Loader entry id of one server — the client surface and the UI both key on it. */
export function mcpServerEntryId(serverName: string): string {
  return `mcp-${serverName}`
}

/** Server names the UI accepts; also what keeps an entry id resolvable. */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Absolute path of the durable store: `$DSH_HOME/plugins/skill-mcp-center/`
 * `mcp-servers.json`, with `~/.dsh` as the same fallback the other SSID-family
 * plugins use. DSH Desktop launches the harness with `DSH_HOME` pointing at its
 * own `harness` directory, so the file follows the application.
 */
export function mcpStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const home = configured.length > 0 ? configured : join(homedir(), '.dsh')
  return join(home, 'plugins', 'skill-mcp-center', 'mcp-servers.json')
}

/** Normalize a client MCP config into the full mcp-client config (defaults filled). */
export function fullMcpConfig(input: McpConfig): Record<string, unknown> {
  if (input.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName: input.serverName,
      command: input.command ?? '',
      args: input.args ?? [],
      env: {},
      cwd: input.cwd ?? '',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }
  }
  return {
    transport: 'streamable-http',
    serverName: input.serverName,
    url: input.url ?? '',
    headers: input.headers ?? {},
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  }
}

/** One string array from an untrusted value (non-strings dropped). */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** One string map from an untrusted value (non-string entries dropped). */
function stringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

/**
 * Validate and normalize one stored or client-supplied row. Throws on a row the
 * `mcp-client` cannot be given — a nameless, over-long, or wrongly-typed name is
 * a caller bug, never something to silently persist.
 */
export function normalizeStoredServer(input: unknown): StoredMcpServer {
  const raw = (input ?? {}) as Record<string, unknown>
  const serverName = typeof raw.serverName === 'string' ? raw.serverName : ''
  if (!SERVER_NAME_RE.test(serverName)) throw new Error('mcp-server-name-invalid')
  const transport = raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const row: StoredMcpServer = { serverName, transport, disabled: raw.disabled === true }
  if (raw.scope === 'workspace') row.scope = 'workspace'
  if (typeof raw.boundWorkspace === 'string' && raw.boundWorkspace !== '') row.boundWorkspace = raw.boundWorkspace
  if (transport === 'stdio') {
    if (typeof raw.command === 'string') row.command = raw.command
    const args = stringArray(raw.args)
    if (args.length > 0) row.args = args
    if (typeof raw.cwd === 'string' && raw.cwd !== '') row.cwd = raw.cwd
  } else {
    if (typeof raw.url === 'string') row.url = raw.url
    const headers = stringMap(raw.headers)
    if (Object.keys(headers).length > 0) row.headers = headers
  }
  return row
}

/** Replace every {@link WORKSPACE_TOKEN} occurrence in one string. */
function fillToken(value: string, workspace: string): string {
  return value.split(WORKSPACE_TOKEN).join(workspace)
}

/** Whether a row's raw config still asks for a workspace it has not been given. */
function usesWorkspaceToken(row: StoredMcpServer): boolean {
  if (row.cwd?.includes(WORKSPACE_TOKEN) === true) return true
  return (row.args ?? []).some(arg => arg.includes(WORKSPACE_TOKEN))
}

/**
 * The workspace a row should be spawned for, or undefined when it does not need
 * one. `workspace`-scoped rows always want one; other rows want one only when
 * their `cwd`/`args` carry the `{workspace}` token.
 */
export function workspaceBindingOf(row: StoredMcpServer, workspace?: string): string | undefined {
  if (workspace !== undefined && workspace !== '') return workspace
  if (row.boundWorkspace !== undefined) return row.boundWorkspace
  return undefined
}

/** Whether the row is tied to a workspace at all (scoped or token-using). */
export function isWorkspaceBound(row: StoredMcpServer): boolean {
  return row.scope === 'workspace' || usesWorkspaceToken(row)
}

/**
 * The effective `cwd`/`args` for one row under a workspace, in the stored row's
 * own shape (before {@link fullMcpConfig} fills defaults).
 *
 * A `workspace`-scoped row with no explicit `cwd` is pointed at the workspace
 * itself — that is what makes `codegraph serve --mcp` (no `--path`) find the
 * open project's `.codegraph/` index instead of the launcher's directory.
 */
export function effectiveStoredServer(row: StoredMcpServer, workspace?: string): StoredMcpServer {
  const binding = workspaceBindingOf(row, workspace)
  if (binding === undefined) return row
  const next: StoredMcpServer = { ...row }
  if (next.args !== undefined) next.args = next.args.map(arg => fillToken(arg, binding))
  if (next.cwd !== undefined) {
    next.cwd = fillToken(next.cwd, binding)
  } else if (next.scope === 'workspace' && next.transport === 'stdio') {
    next.cwd = binding
  }
  return next
}

/**
 * Whether a row can be spawned at all: a workspace-bound row must have a
 * concrete workspace, and no `{workspace}` token may survive into the spawn
 * arguments (a literal token would be handed to the server as a path).
 */
export function spawnableRow(row: StoredMcpServer, workspace?: string): boolean {
  const effective = effectiveStoredServer(row, workspace)
  if (isWorkspaceBound(row) && workspaceBindingOf(row, workspace) === undefined) return false
  if (effective.cwd?.includes(WORKSPACE_TOKEN) === true) return false
  return (effective.args ?? []).every(arg => !arg.includes(WORKSPACE_TOKEN))
}

/**
 * The center's durable MCP server registry. Reads tolerate an absent file;
 * writes are atomic (temp file + rename) so a crash mid-write can never leave a
 * truncated registry behind.
 */
export class McpServerStore {
  constructor(readonly path: string = mcpStorePath()) {}

  /**
   * Read every stored row. An absent file is an empty registry. A corrupt file
   * is moved aside to `<path>.corrupt-<timestamp>` and reported as empty: the
   * plugin must still boot, and the user keeps the bytes to repair by hand.
   */
  async load(): Promise<StoredMcpServer[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return [] // absent (or unreadable) registry: first run
    }
    let document: unknown
    try {
      document = JSON.parse(text)
    } catch (error) {
      await this.quarantine()
      throw new Error(`skill-mcp-center: corrupt MCP registry ${this.path}`, { cause: error })
    }
    const servers = (document as Partial<StoreFile> | null)?.servers
    if (!Array.isArray(servers)) {
      await this.quarantine()
      throw new Error(`skill-mcp-center: malformed MCP registry ${this.path}`)
    }
    const rows: StoredMcpServer[] = []
    for (const entry of servers) {
      try {
        rows.push(normalizeStoredServer(entry))
      } catch {
        // One bad row must not cost the user the rest of the registry.
      }
    }
    return rows
  }

  /** Replace the registry with exactly `servers`. */
  async save(servers: readonly StoredMcpServer[]): Promise<void> {
    const document: StoreFile = { version: 1, servers: servers.map(row => ({ ...row })) }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, this.path)
  }

  /** Move a registry we cannot parse out of the way, keeping its bytes. */
  private async quarantine(): Promise<void> {
    try {
      await rename(this.path, `${this.path}.corrupt-${Date.now()}`)
    } catch {
      // Best effort: the caller still reports the parse failure.
    }
  }
}

/** The subset of a cordis loader entry the reconcile pass reads. */
export interface LiveEntryLike {
  id: string
  options: { name?: string }
}

/** The subset of `ctx.loader` the reconcile pass uses. */
export interface McpLoaderLike {
  entries(): Iterable<LiveEntryLike>
  create(options: unknown, parent?: string | null): Promise<string>
}

/** Outcome of one reconcile pass, for diagnostics. */
export interface ReconcileReport {
  created: string[]
  alreadyLive: string[]
  failed: { id: string, message: string }[]
}

/**
 * Rebuild the live `mcp-client` entries for every stored server.
 *
 * Called once per process, after the loader is mounted: this is what turns the
 * durable registry back into connected MCP servers on a fresh DSH start. An id
 * that is already live is left alone — a row that a profile config file owns
 * keeps its own entry. A workspace-bound row with no workspace yet is skipped
 * (the first `agent/pre-step` binds it); a row that cannot start never blocks
 * the others.
 *
 * @param workspace - the workspace to bind workspace-scoped rows to, when one is
 * already known (typically the row's own last binding, persisted at shutdown).
 */
export async function reconcileStoredServers(
  servers: readonly StoredMcpServer[],
  loader: McpLoaderLike,
  entryName: string,
  warn: (format: unknown, ...param: unknown[]) => void = () => {},
  workspace?: string,
): Promise<ReconcileReport> {
  const live = new Set<string>()
  for (const entry of loader.entries()) {
    if (entry.options.name === entryName) live.add(entry.id)
  }
  const report: ReconcileReport = { created: [], alreadyLive: [], failed: [] }
  for (const server of servers) {
    const id = mcpServerEntryId(server.serverName)
    if (live.has(id)) {
      report.alreadyLive.push(id)
      continue
    }
    if (!spawnableRow(server, workspace)) continue
    try {
      await loader.create({
        id,
        name: entryName,
        config: fullMcpConfig(effectiveStoredServer(server, workspace)),
        disabled: server.disabled ? true : null,
      })
      report.created.push(id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      report.failed.push({ id, message })
      warn(`failed to restore MCP server %C from the durable registry`, id)
      warn(error)
    }
  }
  return report
}
