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
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type McpConfig, type McpTransport } from './store.ts';
export type { McpConfig, McpTransport, StoredMcpServer } from './store.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** The skill/MCP center engine (provided by this package's host half). */
        skillMcp: SkillMcpService;
    }
}
/** One skill as the Settings surface exposes it. */
export interface SkillView {
    name: string;
    description: string;
    source: string;
    provider: string;
    modelInvocable: boolean;
    userInvocable: boolean;
    /** Always true — user-level skills are disk-backed and toggleable. */
    writable: boolean;
    /** Absolute SKILL.md path (the toggle target; opaque to the client display). */
    path: string;
}
/** Plugin configuration for the skill/MCP engine. */
export interface SkillConfig {
    /** Additional read-only official/bundled skill roots (e.g. the harness repo's own `.agents/skills`). */
    officialSkillDirs?: string[];
    /** Override of the durable MCP registry path (tests); defaults to `$DSH_HOME/plugins/skill-mcp-center/mcp-servers.json`. */
    storePath?: string;
}
/** One MCP server as the Settings surface exposes it. */
export interface McpServer {
    id: string;
    serverName: string;
    transport: McpTransport;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    disabled: boolean;
    fiberPhase: string | null;
    /**
     * True when this center owns the row in its durable registry. False means a
     * profile config file (e.g. `cordis.patch.yml`) defines the entry, so editing
     * it from here would write back through that file — the client keeps those
     * rows read-only.
     */
    managed: boolean;
}
/** Runtime status of one MCP server (sidebar polling). */
export interface McpServerStatus {
    serverName: string;
    fiberPhase: string | null;
    toolCount: number;
    connected: boolean;
    statusSource: 'seam' | 'derived';
}
export declare class SkillMcpService extends Service {
    static inject: string[];
    private readonly officialSkillDirs;
    private readonly store;
    /** Durable registry, loaded once per process and kept in step with writes. */
    private registryLoad?;
    constructor(ctx: Context, config?: SkillConfig);
    /**
     * Rebuild the live `mcp-client` entries from the durable registry. Runs once
     * as the service initializes, which is what makes a server added in an earlier
     * DSH session come back connected in this one. Never throws: a registry or
     * server that cannot be restored must not fail plugin load.
     */
    [Service.init](): AsyncGenerator<void, void, unknown>;
    /** User-level skills plus, when a workspace is given, its project-level skills. */
    listSkills(cwd?: string): Promise<SkillView[]>;
    /** Flip one disk-backed skill's model invocation by rewriting its SKILL.md frontmatter. */
    toggleSkill(path: string): Promise<SkillView>;
    /**
     * Read one skill's SKILL.md raw text for display. Paths must live under a
     * known skill root — a plain path join against the same roots `listSkills`
     * scans, so the RPC cannot be used to read arbitrary files.
     */
    readSkill(path: string, cwd?: string): Promise<string>;
    /** Every `mcp-client` loader entry as a server card. */
    listMcpServers(): Promise<McpServer[]>;
    /**
     * Add one server: the definition is written to the durable registry first, so
     * a connect failure can never cost the user the row, then the entry is created
     * — which hot-connects it (create → import → start).
     */
    createMcpServer(config: McpConfig): Promise<{
        id: string;
    }>;
    /** Rewrite one server's config — durable row first, then the live fiber. */
    updateMcpServer(id: string, config: McpConfig): Promise<void>;
    /** Remove one server — drops the durable row, then disconnects and unregisters its tools. */
    removeMcpServer(id: string): Promise<void>;
    /** Enable/disable one server without deleting its config. */
    setMcpServerEnabled(id: string, enabled: boolean): Promise<void>;
    /** Runtime status per server: upstream `mcpStatus` seam when present, else derived. */
    mcpStatus(): Promise<McpServerStatus[]>;
    /** Every live `mcp-client` entry, whatever tree owns it. */
    private liveMcpEntries;
    /** One live entry by id, or undefined when it is not mounted. */
    private liveEntry;
    /**
     * Whether this center created the live entry. Only entries in the loader's own
     * root store are ours; an entry inside a nested (file-backed) tree is written
     * back through that file, so the center must never mutate it.
     */
    private ownsLiveEntry;
    /** Refuse to touch a live entry a profile config file owns. */
    private assertOwned;
    /** Create the live entry for one row (id, config, disabled state). */
    private createEntry;
    /** Drop a live entry when it is mounted; a missing entry is already the goal. */
    private removeLiveEntry;
    /** The durable registry: read once per process, cached until a write replaces it. */
    private registry;
    /** Read the registry; an unreadable or corrupt file degrades to empty, never to a failed plugin. */
    private readRegistry;
    /** Persist `next` and keep the cache in step with the file. */
    private writeRegistry;
    /** Load the registry and rebuild every live entry it describes. */
    private restoreRegistry;
    /** Best-effort named logger; logging must never break a management call. */
    private log;
    /** Best-effort named warning; see {@link log}. */
    private warn;
}
export default SkillMcpService;
