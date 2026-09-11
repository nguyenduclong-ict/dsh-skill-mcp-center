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
import { Service, type Context } from '@deepseek-ai/cordis';
import { type McpConfig, type McpScope, type McpTransport } from './store.ts';
export type { McpConfig, McpScope, McpTransport, StoredMcpServer } from './store.ts';
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
    /**
     * Apply the durable `boundWorkspace` of a workspace-bound row at startup.
     * The desktop keeps it on so a restart comes back on the project last used;
     * tests turn it off to exercise the "wait for the first session" path.
     */
    restoreWorkspaceBinding?: boolean;
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
    /** Working-directory policy of the row. */
    scope: McpScope;
    /** Workspace a workspace-bound row is (or was last) spawned for. */
    boundWorkspace?: string;
    /**
     * The workspace the row currently follows, when it is bound to one. Undefined
     * for a plain `global` row that carries no `{workspace}` token.
     */
    workspace?: string;
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
    private readonly restoreBinding;
    /** Durable registry, loaded once per process and kept in step with writes. */
    private registryLoad?;
    /** Workspace of the session that most recently started a step. */
    private workspace?;
    /** Serializes workspace rebinds so two sessions cannot interleave spawns. */
    private bindings;
    constructor(ctx: Context, config?: SkillConfig);
    /**
     * Rebuild the live `mcp-client` entries from the durable registry and start
     * following the working session's workspace. This is what makes a server added
     * in an earlier DSH session come back connected in this one. Never throws: a
     * registry or server that cannot be restored must not fail plugin load.
     */
    [Service.init](): AsyncGenerator<() => void, void, unknown>;
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
    private observeSessions;
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
    /** Point one server at a workspace without waiting for the UI (RPC/`agent` seam). */
    setMcpServerWorkspace(id: string, workspace: string): Promise<void>;
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
    /**
     * Make the live entry match one durable row under `workspace`.
     *
     * A changed `cwd`/`args` needs a respawn, not a config patch: the loader
     * hot-applies a config-only update through `fiber.update(config)`, which never
     * restarts the MCP child, so the old working directory would stay in force. A
     * disabled row keeps its entry — config intact, fiber unloaded — so enabling it
     * stays a hot toggle; a row that cannot be spawned at all has no entry.
     */
    private syncEntry;
    /** Drop a live entry when it is mounted; a missing entry is already the goal. */
    private removeLiveEntry;
    /**
     * Bind every workspace-bound row to `workspace`.
     *
     * Serialized through {@link bindings} so two sessions starting steps at once
     * cannot interleave a remove with the other one's create.
     */
    private bindWorkspace;
    /** Rebind the given rows to one workspace, persisting the binding as it goes. */
    private bindWorkspaceRows;
    /** Store one updated row, leaving the rest of the registry untouched. */
    private replaceRow;
    /** The durable registry: read once per process, cached until a write replaces it. */
    private registry;
    /** Read the registry; an unreadable or corrupt file degrades to empty, never to a failed plugin. */
    private readRegistry;
    /** Persist `next` and keep the cache in step with the file. */
    private writeRegistry;
    /**
     * Load the registry and rebuild every live entry it describes, then remember
     * which workspace the workspace-bound rows are on so the first step of the
     * next session does not respawn them for nothing.
     */
    private restoreRegistry;
    /**
     * Forget a binding whose directory is gone (a deleted or moved project), so
     * the row waits for the next session instead of spawning against a stale path.
     */
    private dropMissingBindings;
    /** Best-effort named logger; logging must never break a management call. */
    private log;
    /** Best-effort named warning; see {@link log}. */
    private warn;
}
export default SkillMcpService;
