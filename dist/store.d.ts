/** Transport discriminant of an `mcp-client` server. */
export type McpTransport = 'stdio' | 'streamable-http';
/** Client-supplied MCP server config, normalized to the mcp-client shape. */
export interface McpConfig {
    serverName: string;
    transport: McpTransport;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
}
/** One durable server row: the mcp-client config plus its enable/disable state. */
export interface StoredMcpServer extends McpConfig {
    disabled: boolean;
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
 * keeps its own entry. One server that cannot start never blocks the others.
 */
export declare function reconcileStoredServers(servers: readonly StoredMcpServer[], loader: McpLoaderLike, entryName: string, warn?: (format: unknown, ...param: unknown[]) => void): Promise<ReconcileReport>;
