/** Transport discriminant of an `mcp-client` server. */
export type McpTransport = 'stdio' | 'streamable-http';
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
export type McpScope = 'global' | 'workspace';
/** Placeholder replaced with the bound workspace path in `cwd` and `args`. */
export declare const WORKSPACE_TOKEN = "{workspace}";
/** Client-supplied MCP server config, normalized to the mcp-client shape. */
export interface McpConfig {
    serverName: string;
    transport: McpTransport;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    /** Working-directory policy; see {@link McpScope}. */
    scope?: McpScope;
}
/**
 * One durable server row: the mcp-client config plus its enable/disable state,
 * its working-directory policy, and the workspace it was last bound to.
 */
export interface StoredMcpServer extends McpConfig {
    disabled: boolean;
    /** Host-managed: last workspace a `workspace`-scoped (or `{workspace}`-using) row was spawned for. */
    boundWorkspace?: string;
}
/** Loader entry id of one server — the client surface and the UI both key on it. */
export declare function mcpServerEntryId(serverName: string): string;
/**
 * Absolute path of the durable store: `$DSH_HOME/plugins/skill-mcp-center/`
 * `mcp-servers.json`, with `~/.dsh` as the same fallback the other SSID-family
 * plugins use. DSH Desktop launches the harness with `DSH_HOME` pointing at its
 * own `harness` directory, so the file follows the application.
 */
export declare function mcpStorePath(env?: NodeJS.ProcessEnv): string;
/** Normalize a client MCP config into the full mcp-client config (defaults filled). */
export declare function fullMcpConfig(input: McpConfig): Record<string, unknown>;
/**
 * Validate and normalize one stored or client-supplied row. Throws on a row the
 * `mcp-client` cannot be given — a nameless, over-long, or wrongly-typed name is
 * a caller bug, never something to silently persist.
 */
export declare function normalizeStoredServer(input: unknown): StoredMcpServer;
/**
 * The workspace a row should be spawned for, or undefined when it does not need
 * one. `workspace`-scoped rows always want one; other rows want one only when
 * their `cwd`/`args` carry the `{workspace}` token.
 */
export declare function workspaceBindingOf(row: StoredMcpServer, workspace?: string): string | undefined;
/** Whether the row is tied to a workspace at all (scoped or token-using). */
export declare function isWorkspaceBound(row: StoredMcpServer): boolean;
/**
 * The effective `cwd`/`args` for one row under a workspace, in the stored row's
 * own shape (before {@link fullMcpConfig} fills defaults).
 *
 * A `workspace`-scoped row with no explicit `cwd` is pointed at the workspace
 * itself — that is what makes `codegraph serve --mcp` (no `--path`) find the
 * open project's `.codegraph/` index instead of the launcher's directory.
 */
export declare function effectiveStoredServer(row: StoredMcpServer, workspace?: string): StoredMcpServer;
/**
 * Whether a row can be spawned at all: a workspace-bound row must have a
 * concrete workspace, and no `{workspace}` token may survive into the spawn
 * arguments (a literal token would be handed to the server as a path).
 */
export declare function spawnableRow(row: StoredMcpServer, workspace?: string): boolean;
/**
 * The center's durable MCP server registry. Reads tolerate an absent file;
 * writes are atomic (temp file + rename) so a crash mid-write can never leave a
 * truncated registry behind.
 */
export declare class McpServerStore {
    readonly path: string;
    constructor(path?: string);
    /**
     * Read every stored row. An absent file is an empty registry. A corrupt file
     * is moved aside to `<path>.corrupt-<timestamp>` and reported as empty: the
     * plugin must still boot, and the user keeps the bytes to repair by hand.
     */
    load(): Promise<StoredMcpServer[]>;
    /** Replace the registry with exactly `servers`. */
    save(servers: readonly StoredMcpServer[]): Promise<void>;
    /** Move a registry we cannot parse out of the way, keeping its bytes. */
    private quarantine;
}
/** The subset of a cordis loader entry the reconcile pass reads. */
export interface LiveEntryLike {
    id: string;
    options: {
        name?: string;
    };
}
/** The subset of `ctx.loader` the reconcile pass uses. */
export interface McpLoaderLike {
    entries(): Iterable<LiveEntryLike>;
    create(options: unknown, parent?: string | null): Promise<string>;
}
/** Outcome of one reconcile pass, for diagnostics. */
export interface ReconcileReport {
    created: string[];
    alreadyLive: string[];
    failed: {
        id: string;
        message: string;
    }[];
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
export declare function reconcileStoredServers(servers: readonly StoredMcpServer[], loader: McpLoaderLike, entryName: string, warn?: (format: unknown, ...param: unknown[]) => void, workspace?: string): Promise<ReconcileReport>;
