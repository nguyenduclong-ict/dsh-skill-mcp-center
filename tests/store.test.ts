import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  McpServerStore,
  fullMcpConfig,
  mcpServerEntryId,
  mcpStorePath,
  normalizeStoredServer,
  reconcileStoredServers,
  type StoredMcpServer,
} from '../src/store.ts'

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'skill-mcp-store-'))
}

const stdioRow: StoredMcpServer = {
  serverName: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem'],
  cwd: 'C:\\work',
  disabled: false,
}

describe('mcpStorePath', () => {
  it('DSH_HOME 优先（DSH Desktop 指向自己的 harness 目录）', () => {
    expect(mcpStorePath({ DSH_HOME: 'C:\\home\\harness' })).toBe(join('C:\\home\\harness', 'plugins', 'skill-mcp-center', 'mcp-servers.json'))
  })

  it('未设置 DSH_HOME → ~/.dsh（CLI/其他宿主）', () => {
    expect(mcpStorePath({})).toMatch(/plugins[\\/]skill-mcp-center[\\/]mcp-servers\.json$/)
  })

  it('空白 DSH_HOME 视为未设置', () => {
    expect(mcpStorePath({ DSH_HOME: '   ' })).not.toContain('   ')
  })
})

describe('McpServerStore（持久化：重启后配置必须还在）', () => {
  it('写入后由新实例读回（模拟重启进程）', async () => {
    const file = join(await temporaryDirectory(), 'mcp-servers.json')
    await new McpServerStore(file).save([stdioRow])
    // 新实例 = 新进程：只依赖磁盘
    const restored = await new McpServerStore(file).load()
    expect(restored).toEqual([stdioRow])
  })

  it('文件不存在 → 空 registry（首次运行不抛错）', async () => {
    const file = join(await temporaryDirectory(), 'missing.json')
    expect(await new McpServerStore(file).load()).toEqual([])
  })

  it('保存会创建目录并原子落盘（无 .tmp 残留）', async () => {
    const dir = join(await temporaryDirectory(), 'nested', 'deep')
    const file = join(dir, 'mcp-servers.json')
    await new McpServerStore(file).save([stdioRow])
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 })
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('损坏文件 → 隔离为 .corrupt-* 并报错（不静默丢字节）', async () => {
    const dir = await temporaryDirectory()
    const file = join(dir, 'mcp-servers.json')
    await writeFile(file, '{ not json', 'utf8')
    await expect(new McpServerStore(file).load()).rejects.toThrow(/corrupt MCP registry/)
    const quarantined = (await readdir(dir)).filter(name => name.startsWith('mcp-servers.json.corrupt-'))
    expect(quarantined.length).toBe(1)
    expect(await readFile(join(dir, quarantined[0]!), 'utf8')).toBe('{ not json')
  })

  it('顶层结构不对 → 同样隔离', async () => {
    const dir = await temporaryDirectory()
    const file = join(dir, 'mcp-servers.json')
    await writeFile(file, '{"version":1}', 'utf8')
    await expect(new McpServerStore(file).load()).rejects.toThrow(/malformed MCP registry/)
  })

  it('单条坏行不影响其余行', async () => {
    const file = join(await temporaryDirectory(), 'mcp-servers.json')
    await writeFile(file, JSON.stringify({
      version: 1,
      servers: [{ serverName: 'bad name!' }, stdioRow],
    }), 'utf8')
    expect(await new McpServerStore(file).load()).toEqual([stdioRow])
  })
})

describe('normalizeStoredServer', () => {
  it('stdio：缺省字段补全，env 由 host 侧 fullMcpConfig 注入', () => {
    expect(normalizeStoredServer({ serverName: 'demo', transport: 'stdio', command: 'node' }))
      .toEqual({ serverName: 'demo', transport: 'stdio', command: 'node', disabled: false })
  })

  it('streamable-http：保留 url 与 headers', () => {
    expect(normalizeStoredServer({ serverName: 'web', transport: 'streamable-http', url: 'https://x/mcp', headers: { a: 'b' } }))
      .toEqual({ serverName: 'web', transport: 'streamable-http', url: 'https://x/mcp', headers: { a: 'b' }, disabled: false })
  })

  it('非法 serverName → 抛错（entry id 依赖它）', () => {
    expect(() => normalizeStoredServer({ serverName: 'has space' })).toThrow('mcp-server-name-invalid')
    expect(() => normalizeStoredServer({ serverName: '' })).toThrow('mcp-server-name-invalid')
    expect(() => normalizeStoredServer({ serverName: 'a'.repeat(33) })).toThrow('mcp-server-name-invalid')
  })

  it('非字符串 args 被丢弃', () => {
    expect(normalizeStoredServer({ serverName: 'demo', args: ['a', 1, null] }).args).toEqual(['a'])
  })
})

describe('fullMcpConfig', () => {
  it('stdio 形状带 env/超时/failOnStartupError', () => {
    expect(fullMcpConfig({ serverName: 'demo', transport: 'stdio', command: 'npx' })).toMatchObject({
      transport: 'stdio', serverName: 'demo', command: 'npx', args: [], env: {}, cwd: '',
      toolCallTimeoutMs: 60_000, failOnStartupError: false,
    })
  })

  it('http 形状带 headers', () => {
    expect(fullMcpConfig({ serverName: 'web', transport: 'streamable-http', url: 'u' })).toMatchObject({
      transport: 'streamable-http', serverName: 'web', url: 'u', headers: {},
    })
  })
})

describe('reconcileStoredServers（开机把 durable 行重建为 live entry）', () => {
  const ENTRY_NAME = '@deepseek-ai/dsh-mcp-client'

  function fakeLoader(live: { id: string, options: { name?: string } }[] = []) {
    const calls: Record<string, unknown>[] = []
    const failures: string[] = []
    return {
      calls,
      failures,
      entries: () => live,
      create: async (options: Record<string, unknown>) => {
        const id = String(options.id)
        if (failures.includes(id)) throw new Error(`boom ${id}`)
        calls.push(options)
        return id
      },
    }
  }

  it('缺失的 server 全部重建，并带上 disabled 状态', async () => {
    const loader = fakeLoader()
    const store: StoredMcpServer[] = [stdioRow, { serverName: 'off', transport: 'stdio', command: 'x', disabled: true }]
    const report = await reconcileStoredServers(store, loader, ENTRY_NAME)
    expect(report.created).toEqual(['mcp-filesystem', 'mcp-off'])
    expect(loader.calls.map(call => call.id)).toEqual(['mcp-filesystem', 'mcp-off'])
    expect(loader.calls[0]).toMatchObject({ name: ENTRY_NAME, disabled: null })
    expect(loader.calls[1]).toMatchObject({ disabled: true })
  })

  it('已存在的 entry 不重复创建（配置文件里的行保留自己的 entry）', async () => {
    const loader = fakeLoader([{ id: mcpServerEntryId('filesystem'), options: { name: ENTRY_NAME } }])
    const report = await reconcileStoredServers([stdioRow], loader, ENTRY_NAME)
    expect(report.alreadyLive).toEqual(['mcp-filesystem'])
    expect(loader.calls).toEqual([])
  })

  it('非 mcp-client 的 live entry 不参与判定', async () => {
    const loader = fakeLoader([{ id: mcpServerEntryId('filesystem'), options: { name: 'other-plugin' } }])
    const report = await reconcileStoredServers([stdioRow], loader, ENTRY_NAME)
    expect(report.created).toEqual(['mcp-filesystem'])
  })

  it('单个 server 失败不影响其余，并记录告警', async () => {
    const loader = fakeLoader()
    loader.failures.push('mcp-filesystem')
    const warnings: unknown[][] = []
    const report = await reconcileStoredServers(
      [stdioRow, { serverName: 'ok', transport: 'stdio', command: 'x' }],
      loader,
      ENTRY_NAME,
      (...args: unknown[]) => { warnings.push(args) },
    )
    expect(report.failed.map(failure => failure.id)).toEqual(['mcp-filesystem'])
    expect(report.created).toEqual(['mcp-ok'])
    expect(warnings.length).toBeGreaterThan(0)
  })
})
