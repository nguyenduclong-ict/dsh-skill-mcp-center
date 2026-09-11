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
import { Service } from '@deepseek-ai/cordis';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { parseSkillFrontmatter, setDisableModelInvocation } from "./frontmatter.js";
import { McpServerStore, fullMcpConfig, mcpServerEntryId, mcpStorePath, normalizeStoredServer, reconcileStoredServers, } from "./store.js";
/** Specifier of the official MCP bridge; one loader entry = one MCP server. */
const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client';
/** Runtime mirror of cordis FiberState (a cross-package const enum). */
const FIBER_PHASE = {
    0: 'pending',
    1: 'loading',
    2: 'active',
    3: 'failed',
    4: null,
    5: 'unloading',
};
/** User-level skill roots (host-level filesystem discovery is preset-owned in web). */
const SKILL_ROOTS = [
    { path: join(homedir(), '.dsh', 'skills'), source: 'user-dsh' },
    { path: join(homedir(), '.agents', 'skills'), source: 'user-agents' },
];
/** Absolute SKILL.md path for one directory/file entry, or null. */
function skillPathFor(root, name, isDirectory) {
    if (isDirectory)
        return join(root, name, 'SKILL.md');
    if (name.endsWith('.md'))
        return join(root, name);
    return null;
}
/** Scan one root for SKILL.md entries and parse their frontmatter. */
async function scanSkillRoot(root, source, writable = true, provider = 'filesystem') {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return []; // root absent
    }
    const skills = [];
    for (const entry of entries) {
        const skillPath = skillPathFor(root, entry.name, entry.isDirectory());
        if (skillPath === null)
            continue;
        let text;
        try {
            text = await readFile(skillPath, 'utf8');
        }
        catch {
            continue;
        }
        const fm = parseSkillFrontmatter(text);
        if (fm === null)
            continue;
        skills.push({
            name: fm.name,
            description: fm.description,
            source,
            provider,
            modelInvocable: fm.modelInvocable,
            userInvocable: true,
            writable,
            path: skillPath,
        });
    }
    return skills;
}
export class SkillMcpService extends Service {
    static inject = ['loader', 'tools'];
    officialSkillDirs;
    store;
    /** Durable registry, loaded once per process and kept in step with writes. */
    registryLoad;
    constructor(ctx, config = {}) {
        super(ctx, 'skillMcp');
        this.officialSkillDirs = config.officialSkillDirs ?? [];
        this.store = new McpServerStore(config.storePath ?? mcpStorePath());
    }
    /**
     * Rebuild the live `mcp-client` entries from the durable registry. Runs once
     * as the service initializes, which is what makes a server added in an earlier
     * DSH session come back connected in this one. Never throws: a registry or
     * server that cannot be restored must not fail plugin load.
     */
    async *[Service.init]() {
        try {
            await this.restoreRegistry();
        }
        catch (error) {
            this.warn('failed to restore the MCP registry', error);
        }
    }
    /** User-level skills plus, when a workspace is given, its project-level skills. */
    async listSkills(cwd) {
        const skills = [];
        for (const root of SKILL_ROOTS) {
            skills.push(...await scanSkillRoot(root.path, root.source));
        }
        if (cwd !== undefined && cwd !== '') {
            skills.push(...await scanSkillRoot(join(cwd, '.agents', 'skills'), 'project-agents'));
            skills.push(...await scanSkillRoot(join(cwd, '.dsh', 'skills'), 'project-dsh'));
        }
        for (const dir of this.officialSkillDirs) {
            skills.push(...await scanSkillRoot(dir, 'bundled', false, 'dsh-official'));
        }
        return skills;
    }
    /** Flip one disk-backed skill's model invocation by rewriting its SKILL.md frontmatter. */
    async toggleSkill(path) {
        let text;
        try {
            text = await readFile(path, 'utf8');
        }
        catch {
            throw new Error('skill-not-found');
        }
        const fm = parseSkillFrontmatter(text);
        if (fm === null)
            throw new Error('skill-not-found');
        // Currently model-invocable → disable.
        await writeFile(path, setDisableModelInvocation(text, fm.modelInvocable), 'utf8');
        return {
            name: fm.name,
            description: fm.description,
            source: 'user',
            provider: 'filesystem',
            modelInvocable: !fm.modelInvocable,
            userInvocable: true,
            writable: true,
            path,
        };
    }
    /**
     * Read one skill's SKILL.md raw text for display. Paths must live under a
     * known skill root — a plain path join against the same roots `listSkills`
     * scans, so the RPC cannot be used to read arbitrary files.
     */
    async readSkill(path, cwd) {
        const roots = [...SKILL_ROOTS.map(root => root.path)];
        if (cwd !== undefined && cwd !== '') {
            roots.push(join(cwd, '.agents', 'skills'), join(cwd, '.dsh', 'skills'));
        }
        roots.push(...this.officialSkillDirs);
        // Segment-boundary prefix check: a sibling directory like `skills-notes`
        // must not satisfy a `skills` root. join(root, '') normalizes to root.
        if (!roots.some(root => path === root || path.startsWith(`${root}${sep}`)))
            throw new Error('skill-not-found');
        let text;
        try {
            text = await readFile(path, 'utf8');
        }
        catch {
            throw new Error('skill-not-found');
        }
        return text;
    }
    /** Every `mcp-client` loader entry as a server card. */
    async listMcpServers() {
        const live = new Map();
        for (const entry of this.liveMcpEntries())
            live.set(entry.id, entry);
        const servers = [];
        for (const row of await this.registry()) {
            const id = mcpServerEntryId(row.serverName);
            const entry = live.get(id);
            live.delete(id);
            if (entry === undefined) {
                servers.push({ ...cardOfRow(row), id, managed: true });
                continue;
            }
            // A live entry with this id that the center did not create belongs to a
            // profile config file; report the row it actually serves, read-only.
            const owned = this.ownsLiveEntry(id);
            servers.push({ ...cardOfEntry(entry), managed: owned });
            if (!owned)
                this.warn('profile config entry %C shadows the durable row of the same id', id);
        }
        // Entries this center does not own: rows a profile config file defines.
        for (const entry of live.values()) {
            servers.push({ ...cardOfEntry(entry), managed: false });
        }
        return servers;
    }
    /**
     * Add one server: the definition is written to the durable registry first, so
     * a connect failure can never cost the user the row, then the entry is created
     * — which hot-connects it (create → import → start).
     */
    async createMcpServer(config) {
        const row = normalizeStoredServer({ ...config, disabled: false });
        const id = mcpServerEntryId(row.serverName);
        const registry = await this.registry();
        if (registry.some(server => server.serverName === row.serverName) || this.liveEntry(id) !== undefined) {
            throw new Error('mcp-server-exists');
        }
        await this.writeRegistry([...registry, row]);
        try {
            await this.createEntry(row);
        }
        catch (error) {
            await this.writeRegistry(registry);
            throw error;
        }
        return { id };
    }
    /** Rewrite one server's config — durable row first, then the live fiber. */
    async updateMcpServer(id, config) {
        const registry = await this.registry();
        const index = registry.findIndex(server => mcpServerEntryId(server.serverName) === id);
        if (index < 0)
            throw new Error('mcp-server-file-managed');
        this.assertOwned(id);
        const row = normalizeStoredServer({ ...config, disabled: registry[index].disabled });
        const nextId = mcpServerEntryId(row.serverName);
        if (registry.some((server, at) => at !== index && server.serverName === row.serverName)) {
            throw new Error('mcp-server-exists');
        }
        const next = [...registry];
        next[index] = row;
        await this.writeRegistry(next);
        if (nextId === id) {
            const entry = this.liveEntry(id);
            // The entry can be missing when a previous start failed to connect it.
            if (entry === undefined)
                await this.createEntry(row);
            else
                await this.ctx.loader.update(id, { config: fullMcpConfig(row) });
            return;
        }
        // The entry id is derived from the name, so a rename moves the entry.
        await this.removeLiveEntry(id);
        await this.createEntry(row);
    }
    /** Remove one server — drops the durable row, then disconnects and unregisters its tools. */
    async removeMcpServer(id) {
        const registry = await this.registry();
        const index = registry.findIndex(server => mcpServerEntryId(server.serverName) === id);
        if (index < 0)
            throw new Error('mcp-server-file-managed');
        this.assertOwned(id);
        await this.writeRegistry(registry.filter((_, at) => at !== index));
        await this.removeLiveEntry(id);
    }
    /** Enable/disable one server without deleting its config. */
    async setMcpServerEnabled(id, enabled) {
        const registry = await this.registry();
        const index = registry.findIndex(server => mcpServerEntryId(server.serverName) === id);
        if (index < 0)
            throw new Error('mcp-server-file-managed');
        this.assertOwned(id);
        const row = { ...registry[index], disabled: !enabled };
        const next = [...registry];
        next[index] = row;
        await this.writeRegistry(next);
        if (this.liveEntry(id) === undefined) {
            if (enabled)
                await this.createEntry(row);
            return;
        }
        await this.ctx.loader.update(id, { disabled: enabled ? null : true });
    }
    /** Runtime status per server: upstream `mcpStatus` seam when present, else derived. */
    async mcpStatus() {
        const servers = await this.listMcpServers();
        const seam = this.ctx.get('mcpStatus');
        if (seam !== undefined) {
            const byName = new Map(seam.list().map(s => [s.serverName, s]));
            return servers.map(s => {
                const st = byName.get(s.serverName);
                return {
                    serverName: s.serverName,
                    fiberPhase: s.fiberPhase,
                    toolCount: st?.toolCount ?? 0,
                    connected: st?.phase === 'connected',
                    statusSource: 'seam',
                };
            });
        }
        const toolNames = this.ctx.tools.schemas().map(s => s.name);
        return servers.map(s => {
            const prefix = `mcp__${s.serverName}__`;
            const toolCount = toolNames.filter(n => n.startsWith(prefix)).length;
            return {
                serverName: s.serverName,
                fiberPhase: s.fiberPhase,
                toolCount,
                connected: !s.disabled && s.fiberPhase === 'active' && toolCount > 0,
                statusSource: 'derived',
            };
        });
    }
    /** Every live `mcp-client` entry, whatever tree owns it. */
    liveMcpEntries() {
        const entries = [];
        for (const entry of this.ctx.loader.entries()) {
            if (entry.options.name === MCP_CLIENT_NAME)
                entries.push(entry);
        }
        return entries;
    }
    /** One live entry by id, or undefined when it is not mounted. */
    liveEntry(id) {
        try {
            const entry = this.ctx.loader.resolve(id);
            return entry.options.name === MCP_CLIENT_NAME ? entry : undefined;
        }
        catch {
            return undefined;
        }
    }
    /**
     * Whether this center created the live entry. Only entries in the loader's own
     * root store are ours; an entry inside a nested (file-backed) tree is written
     * back through that file, so the center must never mutate it.
     */
    ownsLiveEntry(id) {
        return this.ctx.loader.store[id] !== undefined;
    }
    /** Refuse to touch a live entry a profile config file owns. */
    assertOwned(id) {
        if (this.liveEntry(id) !== undefined && !this.ownsLiveEntry(id))
            throw new Error('mcp-server-file-managed');
    }
    /** Create the live entry for one row (id, config, disabled state). */
    async createEntry(row) {
        await this.ctx.loader.create({
            id: mcpServerEntryId(row.serverName),
            name: MCP_CLIENT_NAME,
            config: fullMcpConfig(row),
            disabled: row.disabled ? true : null,
        });
    }
    /** Drop a live entry when it is mounted; a missing entry is already the goal. */
    async removeLiveEntry(id) {
        if (this.liveEntry(id) === undefined)
            return;
        await this.ctx.loader.remove(id);
    }
    /** The durable registry: read once per process, cached until a write replaces it. */
    registry() {
        this.registryLoad ??= this.readRegistry();
        return this.registryLoad;
    }
    /** Read the registry; an unreadable or corrupt file degrades to empty, never to a failed plugin. */
    async readRegistry() {
        try {
            return await this.store.load();
        }
        catch (error) {
            this.warn('unreadable MCP registry %C', this.store.path);
            this.warn(error);
            return [];
        }
    }
    /** Persist `next` and keep the cache in step with the file. */
    async writeRegistry(next) {
        await this.store.save(next);
        this.registryLoad = Promise.resolve(next);
    }
    /** Load the registry and rebuild every live entry it describes. */
    async restoreRegistry() {
        const registry = await this.registry();
        if (registry.length === 0)
            return;
        const report = await reconcileStoredServers(registry, this.ctx.loader, MCP_CLIENT_NAME, (format, ...param) => { this.warn(format, ...param); });
        if (report.created.length > 0)
            this.log('restored %C MCP server(s) from the durable registry', report.created.length);
        if (report.failed.length > 0)
            this.warn('%C MCP server(s) could not be restored', report.failed.length);
    }
    /** Best-effort named logger; logging must never break a management call. */
    log(format, ...param) {
        try {
            this.ctx.logger('skill-mcp-center').info(format, ...param);
        }
        catch {
            // The logger service is optional for this plugin's own correctness.
        }
    }
    /** Best-effort named warning; see {@link log}. */
    warn(format, ...param) {
        try {
            this.ctx.logger('skill-mcp-center').warn(format, ...param);
        }
        catch {
            // The logger service is optional for this plugin's own correctness.
        }
    }
}
/** Card fragment for one durable row with no live entry. */
function cardOfRow(row) {
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
    };
}
/** Card fragment for one live loader entry. */
function cardOfEntry(entry) {
    const cfg = entry.options.config;
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
    };
}
export default SkillMcpService;
