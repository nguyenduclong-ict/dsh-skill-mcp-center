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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** Loader entry id of one server — the client surface and the UI both key on it. */
export function mcpServerEntryId(serverName) {
    return `mcp-${serverName}`;
}
/** Server names the UI accepts; also what keeps an entry id resolvable. */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
/**
 * Absolute path of the durable store: `$DSH_HOME/plugins/skill-mcp-center/`
 * `mcp-servers.json`, with `~/.dsh` as the same fallback the other SSID-family
 * plugins use. DSH Desktop launches the harness with `DSH_HOME` pointing at its
 * own `harness` directory, so the file follows the application.
 */
export function mcpStorePath(env = process.env) {
    const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
    const home = configured.length > 0 ? configured : join(homedir(), '.dsh');
    return join(home, 'plugins', 'skill-mcp-center', 'mcp-servers.json');
}
/** Normalize a client MCP config into the full mcp-client config (defaults filled). */
export function fullMcpConfig(input) {
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
        };
    }
    return {
        transport: 'streamable-http',
        serverName: input.serverName,
        url: input.url ?? '',
        headers: input.headers ?? {},
        toolCallTimeoutMs: 60_000,
        failOnStartupError: false,
    };
}
/** One string array from an untrusted value (non-strings dropped). */
function stringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}
/** One string map from an untrusted value (non-string entries dropped). */
function stringMap(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return {};
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string')
            out[key] = item;
    }
    return out;
}
/**
 * Validate and normalize one stored or client-supplied row. Throws on a row the
 * `mcp-client` cannot be given — a nameless, over-long, or wrongly-typed name is
 * a caller bug, never something to silently persist.
 */
export function normalizeStoredServer(input) {
    const raw = (input ?? {});
    const serverName = typeof raw.serverName === 'string' ? raw.serverName : '';
    if (!SERVER_NAME_RE.test(serverName))
        throw new Error('mcp-server-name-invalid');
    const transport = raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
    const row = { serverName, transport, disabled: raw.disabled === true };
    if (transport === 'stdio') {
        if (typeof raw.command === 'string')
            row.command = raw.command;
        const args = stringArray(raw.args);
        if (args.length > 0)
            row.args = args;
        if (typeof raw.cwd === 'string' && raw.cwd !== '')
            row.cwd = raw.cwd;
    }
    else {
        if (typeof raw.url === 'string')
            row.url = raw.url;
        const headers = stringMap(raw.headers);
        if (Object.keys(headers).length > 0)
            row.headers = headers;
    }
    return row;
}
/**
 * The center's durable MCP server registry. Reads tolerate an absent file;
 * writes are atomic (temp file + rename) so a crash mid-write can never leave a
 * truncated registry behind.
 */
export class McpServerStore {
    path;
    constructor(path = mcpStorePath()) {
        this.path = path;
    }
    /**
     * Read every stored row. An absent file is an empty registry. A corrupt file
     * is moved aside to `<path>.corrupt-<timestamp>` and reported as empty: the
     * plugin must still boot, and the user keeps the bytes to repair by hand.
     */
    async load() {
        let text;
        try {
            text = await readFile(this.path, 'utf8');
        }
        catch {
            return []; // absent (or unreadable) registry: first run
        }
        let document;
        try {
            document = JSON.parse(text);
        }
        catch (error) {
            await this.quarantine();
            throw new Error(`skill-mcp-center: corrupt MCP registry ${this.path}`, { cause: error });
        }
        const servers = document?.servers;
        if (!Array.isArray(servers)) {
            await this.quarantine();
            throw new Error(`skill-mcp-center: malformed MCP registry ${this.path}`);
        }
        const rows = [];
        for (const entry of servers) {
            try {
                rows.push(normalizeStoredServer(entry));
            }
            catch {
                // One bad row must not cost the user the rest of the registry.
            }
        }
        return rows;
    }
    /** Replace the registry with exactly `servers`. */
    async save(servers) {
        const document = { version: 1, servers: servers.map(row => ({ ...row })) };
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.tmp`;
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
        await rename(temporary, this.path);
    }
    /** Move a registry we cannot parse out of the way, keeping its bytes. */
    async quarantine() {
        try {
            await rename(this.path, `${this.path}.corrupt-${Date.now()}`);
        }
        catch {
            // Best effort: the caller still reports the parse failure.
        }
    }
}
/**
 * Rebuild the live `mcp-client` entries for every stored server.
 *
 * Called once per process, after the loader is mounted: this is what turns the
 * durable registry back into connected MCP servers on a fresh DSH start. An id
 * that is already live is left alone — a row that a profile config file owns
 * keeps its own entry. One server that cannot start never blocks the others.
 */
export async function reconcileStoredServers(servers, loader, entryName, warn = () => { }) {
    const live = new Set();
    for (const entry of loader.entries()) {
        if (entry.options.name === entryName)
            live.add(entry.id);
    }
    const report = { created: [], alreadyLive: [], failed: [] };
    for (const server of servers) {
        const id = mcpServerEntryId(server.serverName);
        if (live.has(id)) {
            report.alreadyLive.push(id);
            continue;
        }
        try {
            await loader.create({
                id,
                name: entryName,
                config: fullMcpConfig(server),
                disabled: server.disabled ? true : null,
            });
            report.created.push(id);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            report.failed.push({ id, message });
            warn(`failed to restore MCP server %C from the durable registry`, id);
            warn(error);
        }
    }
    return report;
}
