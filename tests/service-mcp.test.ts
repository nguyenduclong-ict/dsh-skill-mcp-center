/**
 * Host-side regression tests for the reported defect: MCP servers added in the
 * management center vanished when DSH Desktop was restarted.
 *
 * The center manages `mcp-client` loader entries, and the loader's ROOT tree is
 * in-memory (`Loader.write()` is a documented no-op), so a root entry alone can
 * never survive a restart. These tests mount the real cordis `Context` and a
 * recording stand-in for `ctx.loader`, then simulate a restart by booting a
 * second context against the same registry file.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillMcpService } from '../src/service.ts'

const ENTRY_NAME = '@deepseek-ai/dsh-mcp-client'

interface FakeEntry {
  id: string
  options: { name?: string, config?: Record<string, unknown> }
  disabled: boolean
  fiber?: undefined
}

/** Recording stand-in for the `loader` service, shaped like the real entry tree. */
class FakeLoader extends Service {
  /** Root-tree store: exactly the entries this process created at the root. */
  readonly store: Record<string, FakeEntry> = {}
  readonly mounted: FakeEntry[] = []
  /** Ids created through `create()`, in order — a respawn shows up as a new entry. */
  readonly created: string[] = []
  /** Ids the fake refuses to create, to exercise restore-failure paths. */
  readonly refuse = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'loader')
  }

  entries(): FakeEntry[] {
    return this.mounted
  }

  resolve(id: string): FakeEntry {
    const entry = this.mounted.find(candidate => candidate.id === id)
    if (entry === undefined) throw new Error(`cannot resolve entry ${id}`)
    return entry
  }

  async create(options: { id: string, name: string, config?: Record<string, unknown>, disabled?: boolean | null }): Promise<string> {
    if (this.refuse.has(String(options.id))) throw new Error(`refused ${options.id}`)
    const entry = this.mount(options)
    this.store[entry.id] = entry
    this.created.push(entry.id)
    return entry.id
  }

  /** Mount an entry that came from a nested (file-backed) tree, like the real include. */
  mountNested(options: { id: string, name: string, config?: Record<string, unknown>, disabled?: boolean | null }): FakeEntry {
    return this.mount(options)
  }

  async update(id: string, options: { config?: Record<string, unknown>, disabled?: boolean | null }): Promise<void> {
    const entry = this.resolve(id)
    if (options.config !== undefined) entry.options.config = options.config
    if (options.disabled !== undefined) entry.disabled = options.disabled === true
  }

  async remove(id: string): Promise<void> {
    const at = this.mounted.findIndex(entry => entry.id === id)
    if (at >= 0) this.mounted.splice(at, 1)
    delete this.store[id]
  }

  private mount(options: { id: string, name: string, config?: Record<string, unknown>, disabled?: boolean | null }): FakeEntry {
    const entry: FakeEntry = {
      id: String(options.id),
      options: { name: options.name, config: options.config },
      disabled: options.disabled === true,
    }
    this.mounted.push(entry)
    return entry
  }
}

class FakeTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  schemas(): { name: string }[] {
    return []
  }
}

/** One "process": fresh context, fresh services, same registry file. */
async function boot(
  storePath: string,
  prepare?: (loader: FakeLoader) => void,
  config: { restoreWorkspaceBinding?: boolean } = {},
): Promise<{ ctx: Context, loader: FakeLoader, service: SkillMcpService }> {
  const ctx = new Context()
  const loader = new FakeLoader(ctx)
  new FakeTools(ctx)
  // Entries a profile config file provides exist before the center initializes.
  prepare?.(loader)
  const fiber = ctx.plugin(SkillMcpService, { storePath, ...config })
  await fiber.await()
  const service = ctx.get('skillMcp') as SkillMcpService | undefined
  if (service === undefined) throw new Error('skillMcp service missing')
  return { ctx, loader, service }
}

/**
 * Run one agent step for a session whose workspace is `cwd`, the way the agent
 * loop dispatches it: `events.waterfall('agent/pre-step', payload, next)`.
 */
async function stepInWorkspace(ctx: Context, cwd: string): Promise<void> {
  const waterfall = (ctx.events as unknown as {
    waterfall: (name: string, payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  }).waterfall.bind(ctx.events)
  await waterfall('agent/pre-step', { agent: { session: { header: { cwd } } }, messages: [], step: 1 }, async () => ({ kind: 'enter' }))
}

/** A workspace directory that really exists (bindings are validated against disk). */
async function workspaceDirectory(name: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `skill-mcp-ws-${name}-`))
}

/** Read the durable registry straight off disk, as another process would. */
async function registryOnDisk(storePath: string): Promise<{ servers: Record<string, unknown>[] }> {
  return JSON.parse(await readFile(storePath, 'utf8'))
}

async function temporaryStore(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'skill-mcp-service-')), 'mcp-servers.json')
}

const filesystemConfig = {
  serverName: 'filesystem',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem'],
  cwd: 'C:\\work',
}

describe('MCP 管理与持久化', () => {
  it('新增 server：写入 durable registry，同时热连接 live entry', async () => {
    const storePath = await temporaryStore()
    const { loader, service } = await boot(storePath)
    const { id } = await service.createMcpServer(filesystemConfig)
    expect(id).toBe('mcp-filesystem')
    expect(loader.mounted.map(entry => entry.id)).toEqual(['mcp-filesystem'])
    expect(loader.mounted[0]!.options.config).toMatchObject({ command: 'npx', cwd: 'C:\\work' })
    expect((await registryOnDisk(storePath)).servers).toEqual([{ ...filesystemConfig, disabled: false }])
  })

  it('重启后配置仍在，并被重建为 live entry（回归：原来是重启即清空）', async () => {
    const storePath = await temporaryStore()
    const first = await boot(storePath)
    await first.service.createMcpServer(filesystemConfig)
    await first.service.createMcpServer({ serverName: 'web', transport: 'streamable-http', url: 'https://mcp.example.com/x' })

    // 新进程：同一份 registry，全新的 context/loader
    const second = await boot(storePath)
    const servers = await second.service.listMcpServers()
    expect(servers.map(server => server.serverName).sort()).toEqual(['filesystem', 'web'])
    expect(servers.every(server => server.managed)).toBe(true)
    const ids = second.loader.mounted.map(entry => entry.id).sort()
    expect(ids).toEqual(['mcp-filesystem', 'mcp-web'])
    const web = second.loader.mounted.find(entry => entry.id === 'mcp-web')!
    expect(web.options.config).toMatchObject({ transport: 'streamable-http', url: 'https://mcp.example.com/x' })
  })

  it('http server 的 headers 跨重启保留，并原样进入 mcp-client 配置', async () => {
    const storePath = await temporaryStore()
    const headers = { Authorization: 'Bearer t0ken', 'X-Api-Key': 'abc 123' }
    const first = await boot(storePath)
    await first.service.createMcpServer({
      serverName: 'web',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/x',
      headers,
    })

    // 写盘就是 mcp-client 的形状（headers 是它的 requestInit.headers 来源）
    const onDisk = await registryOnDisk(storePath)
    expect(onDisk.servers[0]).toMatchObject({ transport: 'streamable-http', headers })
    expect(first.loader.mounted[0]!.options.config).toMatchObject({ headers })

    // 新进程：重建的 entry 仍带着 headers，卡片也把它们暴露给编辑表单
    const second = await boot(storePath)
    const web = second.loader.mounted.find(entry => entry.id === 'mcp-web')!
    expect(web.options.config).toMatchObject({ headers })
    expect((await second.service.listMcpServers())[0]!.headers).toEqual(headers)
  })

  it('http server 不填 headers 时为空对象，编辑可清除已有 headers', async () => {
    const storePath = await temporaryStore()
    const { service } = await boot(storePath)
    await service.createMcpServer({ serverName: 'web', transport: 'streamable-http', url: 'https://mcp.example.com/x' })
    expect((await registryOnDisk(storePath)).servers[0]).not.toHaveProperty('headers')
    // 卡片（来自 fullMcpConfig）把缺省补成 {}，表单据此渲染成空文本
    expect((await service.listMcpServers())[0]!.headers).toEqual({})

    await service.updateMcpServer('mcp-web', {
      serverName: 'web',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/x',
      headers: { Authorization: 'Bearer t' },
    })
    expect((await registryOnDisk(storePath)).servers[0]).toMatchObject({ headers: { Authorization: 'Bearer t' } })

    // 清空表单提交 {} → 落盘的 row 不再有 headers
    await service.updateMcpServer('mcp-web', {
      serverName: 'web',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/x',
      headers: {},
    })
    expect((await registryOnDisk(storePath)).servers[0]).not.toHaveProperty('headers')
  })

  it('停用状态跨重启保留（重建时保持 disabled，不发起连接）', async () => {
    const storePath = await temporaryStore()
    const first = await boot(storePath)
    await first.service.createMcpServer(filesystemConfig)
    await first.service.setMcpServerEnabled('mcp-filesystem', false)
    expect(first.loader.mounted[0]!.disabled).toBe(true)

    const second = await boot(storePath)
    expect(second.loader.mounted.map(entry => entry.id)).toEqual(['mcp-filesystem'])
    expect(second.loader.mounted[0]!.disabled).toBe(true)
    expect((await second.service.listMcpServers())[0]!.disabled).toBe(true)
  })

  it('重启后可重新启用（entry 已存在 → 热更新 disabled）', async () => {
    const storePath = await temporaryStore()
    const first = await boot(storePath)
    await first.service.createMcpServer(filesystemConfig)
    await first.service.setMcpServerEnabled('mcp-filesystem', false)

    const second = await boot(storePath)
    await second.service.setMcpServerEnabled('mcp-filesystem', true)
    expect(second.loader.mounted[0]!.disabled).toBe(false)
    expect((await registryOnDisk(storePath)).servers[0]).toMatchObject({ disabled: false })
  })

  it('编辑 server：registry 与 live config 同步更新', async () => {
    const storePath = await temporaryStore()
    const { loader, service } = await boot(storePath)
    await service.createMcpServer(filesystemConfig)
    await service.updateMcpServer('mcp-filesystem', { ...filesystemConfig, args: ['--flag'] })
    expect(loader.mounted[0]!.options.config).toMatchObject({ args: ['--flag'] })
    expect((await registryOnDisk(storePath)).servers[0]).toMatchObject({ args: ['--flag'] })
  })

  it('改名：entry id 随 serverName 迁移（旧 entry 下线，新 entry 上线）', async () => {
    const storePath = await temporaryStore()
    const { loader, service } = await boot(storePath)
    await service.createMcpServer(filesystemConfig)
    await service.updateMcpServer('mcp-filesystem', { ...filesystemConfig, serverName: 'fs' })
    expect(loader.mounted.map(entry => entry.id)).toEqual(['mcp-fs'])

    const second = await boot(storePath)
    expect(second.loader.mounted.map(entry => entry.id)).toEqual(['mcp-fs'])
  })

  it('删除 server：registry 与 live entry 一并移除，且重启后不再出现', async () => {
    const storePath = await temporaryStore()
    const { loader, service } = await boot(storePath)
    await service.createMcpServer(filesystemConfig)
    await service.removeMcpServer('mcp-filesystem')
    expect(loader.mounted).toEqual([])
    expect((await registryOnDisk(storePath)).servers).toEqual([])

    const second = await boot(storePath)
    expect(second.loader.mounted).toEqual([])
    expect(await second.service.listMcpServers()).toEqual([])
  })

  it('同名重复创建被拒绝（不会覆盖已有 server 的配置）', async () => {
    const storePath = await temporaryStore()
    const { loader, service } = await boot(storePath)
    await service.createMcpServer(filesystemConfig)
    await expect(service.createMcpServer({ ...filesystemConfig, command: 'other' })).rejects.toThrow('mcp-server-exists')
    expect(loader.mounted.length).toBe(1)
    expect((await registryOnDisk(storePath)).servers.length).toBe(1)
  })

  it('非法 serverName 被拒绝且不落盘', async () => {
    const storePath = await temporaryStore()
    const { service } = await boot(storePath)
    await expect(service.createMcpServer({ serverName: 'bad name', transport: 'stdio', command: 'x' }))
      .rejects.toThrow('mcp-server-name-invalid')
    expect(await readFile(storePath, 'utf8').catch(() => '')).toBe('')
  })

  it('配置文件里定义的 entry：标记为只读，且管理操作被拒绝（不写回配置文件）', async () => {
    const storePath = await temporaryStore()
    // 模拟 cordis.patch.yml 提供的 entry：启动前就在，且属于嵌套（文件）树
    const { service } = await boot(storePath, loader => {
      loader.mountNested({ id: 'mcp-profile', name: ENTRY_NAME, config: { serverName: 'profile', transport: 'stdio', command: 'x' } })
    })

    const servers = await service.listMcpServers()
    expect(servers).toEqual([expect.objectContaining({ id: 'mcp-profile', serverName: 'profile', managed: false })])
    await expect(service.setMcpServerEnabled('mcp-profile', false)).rejects.toThrow('mcp-server-file-managed')
    await expect(service.removeMcpServer('mcp-profile')).rejects.toThrow('mcp-server-file-managed')
    await expect(service.updateMcpServer('mcp-profile', { serverName: 'profile', transport: 'stdio' })).rejects.toThrow('mcp-server-file-managed')
    expect(await readFile(storePath, 'utf8').catch(() => '')).toBe('')
  })

  it('配置文件 entry 与 durable 行撞 id 时：以配置文件为准，且拒绝改写', async () => {
    const storePath = await temporaryStore()
    const first = await boot(storePath)
    await first.service.createMcpServer(filesystemConfig)

    // 下一次启动：配置文件先提供了同名 entry，reconcile 不会重复创建
    const second = await boot(storePath, loader => {
      loader.mountNested({ id: 'mcp-filesystem', name: ENTRY_NAME, config: { serverName: 'filesystem', transport: 'stdio', command: 'from-profile' } })
    })
    expect(second.loader.mounted.length).toBe(1)
    expect(await second.service.listMcpServers()).toEqual([
      expect.objectContaining({ id: 'mcp-filesystem', managed: false, command: 'from-profile' }),
    ])
    await expect(second.service.removeMcpServer('mcp-filesystem')).rejects.toThrow('mcp-server-file-managed')
    // durable 行仍在（用户的配置没被这次启动弄丢）
    expect((await registryOnDisk(storePath)).servers.length).toBe(1)
  })

  it('重建失败（例如 mcp-client 起不来）时保留 registry，重启后仍可看到该 server', async () => {
    const storePath = await temporaryStore()
    const first = await boot(storePath)
    await first.service.createMcpServer(filesystemConfig)

    const second = await boot(storePath)
    second.loader.refuse.add('mcp-filesystem')
    // 模拟下一次启动：entry 建不起来，但 durable 行必须还在
    const third = await boot(storePath)
    third.loader.refuse.add('mcp-filesystem')
    const servers = await third.service.listMcpServers()
    expect(servers).toEqual([expect.objectContaining({ serverName: 'filesystem', managed: true, fiberPhase: null })])
    expect((await registryOnDisk(storePath)).servers.length).toBe(1)
  })

  it('mcpStatus 对未连接的 durable server 报未连接（不抛错）', async () => {
    const storePath = await temporaryStore()
    const first = await boot(storePath)
    await first.service.createMcpServer(filesystemConfig)
    const second = await boot(storePath)
    second.loader.refuse.add('mcp-filesystem')
    expect(await second.service.mcpStatus()).toEqual([
      expect.objectContaining({ serverName: 'filesystem', toolCount: 0, connected: false, fiberPhase: null }),
    ])
  })
})

describe('MCP 绑定 workspace（cwd 跟随当前项目）', () => {
  const codegraphRow = {
    serverName: 'codegraph',
    transport: 'stdio' as const,
    scope: 'workspace' as const,
    command: 'codegraph',
    args: ['serve', '--mcp'],
  }

  it('scope=workspace：等首个会话给出项目后才启动，cwd 就是该项目', async () => {
    const storePath = await temporaryStore()
    const { ctx, loader, service } = await boot(storePath)
    await service.createMcpServer(codegraphRow)
    // 还没有任何会话 → 不启动（避免用 launch-root 起一个没用的进程）
    expect(loader.mounted).toEqual([])
    expect(await service.listMcpServers()).toEqual([
      expect.objectContaining({ serverName: 'codegraph', scope: 'workspace', boundWorkspace: undefined, workspace: undefined }),
    ])

    const projectA = await workspaceDirectory('a')
    await stepInWorkspace(ctx, projectA)
    expect(loader.mounted.map(entry => entry.id)).toEqual(['mcp-codegraph'])
    expect(loader.mounted[0]!.options.config).toMatchObject({ cwd: projectA })
    expect((await registryOnDisk(storePath)).servers[0]).toMatchObject({ scope: 'workspace', boundWorkspace: projectA })
  })

  it('切换项目 → entry 重启并指向新项目；同一项目重复 step 不重启', async () => {
    const storePath = await temporaryStore()
    const { ctx, loader, service } = await boot(storePath)
    await service.createMcpServer(codegraphRow)
    const projectA = await workspaceDirectory('a')
    const projectB = await workspaceDirectory('b')

    await stepInWorkspace(ctx, projectA)
    expect(loader.mounted.length).toBe(1)

    await stepInWorkspace(ctx, projectA)
    expect(loader.created.length).toBe(1) // 同一 workspace：不重启

    await stepInWorkspace(ctx, projectB)
    expect(loader.created.length).toBe(2) // 换项目：重启
    expect(loader.mounted.length).toBe(1)
    expect(loader.mounted[0]!.options.config).toMatchObject({ cwd: projectB })
    expect((await registryOnDisk(storePath)).servers[0]).toMatchObject({ boundWorkspace: projectB })
  })

  it('重启进程：沿用 boundWorkspace 直接绑定（不必等新会话）', async () => {
    const storePath = await temporaryStore()
    const project = await workspaceDirectory('keep')
    const first = await boot(storePath)
    await first.service.createMcpServer(codegraphRow)
    await stepInWorkspace(first.ctx, project)

    const second = await boot(storePath)
    expect(second.loader.created.length).toBe(1)
    expect(second.loader.mounted[0]!.options.config).toMatchObject({ cwd: project })
    expect((await second.service.listMcpServers())[0]).toMatchObject({ boundWorkspace: project, workspace: project })
  })

  it('boundWorkspace 已不存在（项目被删/搬走）→ 丢弃绑定并等待新会话', async () => {
    const storePath = await temporaryStore()
    const project = await workspaceDirectory('gone')
    const first = await boot(storePath)
    await first.service.createMcpServer(codegraphRow)
    await stepInWorkspace(first.ctx, project)
    await rm(project, { recursive: true, force: true })

    const second = await boot(storePath)
    expect(second.loader.mounted).toEqual([])
    expect((await registryOnDisk(storePath)).servers[0]).not.toHaveProperty('boundWorkspace')

    const fresh = await workspaceDirectory('fresh')
    await stepInWorkspace(second.ctx, fresh)
    expect(second.loader.mounted[0]!.options.config).toMatchObject({ cwd: fresh })
  })

  it('{workspace} 占位符：global 行也能跟随，且切换项目会重启', async () => {
    const storePath = await temporaryStore()
    const { ctx, loader, service } = await boot(storePath)
    await service.createMcpServer({
      serverName: 'indexer',
      transport: 'stdio',
      command: 'indexer',
      args: ['--root', '{workspace}', '--watch'],
    })
    const projectA = await workspaceDirectory('a')
    const projectB = await workspaceDirectory('b')
    await stepInWorkspace(ctx, projectA)
    expect(loader.mounted[0]!.options.config).toMatchObject({ args: ['--root', projectA, '--watch'] })
    await stepInWorkspace(ctx, projectB)
    expect(loader.created.length).toBe(2)
    expect(loader.mounted[0]!.options.config).toMatchObject({ args: ['--root', projectB, '--watch'] })
  })

  it('普通 global 行不随项目切换重启', async () => {
    const storePath = await temporaryStore()
    const { ctx, loader, service } = await boot(storePath)
    await service.createMcpServer(filesystemConfig)
    expect(loader.created.length).toBe(1)
    await stepInWorkspace(ctx, await workspaceDirectory('a'))
    await stepInWorkspace(ctx, await workspaceDirectory('b'))
    expect(loader.created.length).toBe(1)
    expect(loader.mounted.length).toBe(1)
  })

  it('停用的 workspace 行：不启动进程、不因换项目重启，只记绑定；启用时按最新绑定启动', async () => {
    const storePath = await temporaryStore()
    const { ctx, loader, service } = await boot(storePath)
    await service.createMcpServer(codegraphRow)
    await service.setMcpServerEnabled('mcp-codegraph', false)

    const projectA = await workspaceDirectory('a')
    await stepInWorkspace(ctx, projectA)
    // 停用 = 没有进程可指向：不建 entry，只把绑定记下来
    expect(loader.mounted).toEqual([])
    expect(loader.created).toEqual([])
    expect((await registryOnDisk(storePath)).servers[0]).toMatchObject({ disabled: true, boundWorkspace: projectA })

    const projectB = await workspaceDirectory('b')
    await stepInWorkspace(ctx, projectB)
    expect(loader.created).toEqual([])
    expect((await registryOnDisk(storePath)).servers[0]).toMatchObject({ boundWorkspace: projectB })

    await service.setMcpServerEnabled('mcp-codegraph', true)
    expect(loader.mounted.length).toBe(1)
    expect(loader.mounted[0]!.disabled).toBe(false)
    expect(loader.mounted[0]!.options.config).toMatchObject({ cwd: projectB })
  })

  it('setMcpServerWorkspace：不经过会话也能指定项目', async () => {
    const storePath = await temporaryStore()
    const { loader, service } = await boot(storePath)
    await service.createMcpServer(codegraphRow)
    const project = await workspaceDirectory('manual')
    await service.setMcpServerWorkspace('mcp-codegraph', project)
    expect(loader.mounted[0]!.options.config).toMatchObject({ cwd: project })
    await expect(service.setMcpServerWorkspace('mcp-nope', project)).rejects.toThrow('mcp-server-file-managed')
  })

  it('cwd 里显式写 {workspace} 之外的固定路径仍可用（子目录）', async () => {
    const storePath = await temporaryStore()
    const { ctx, loader, service } = await boot(storePath)
    await service.createMcpServer({
      serverName: 'sub',
      transport: 'stdio',
      command: 'tool',
      cwd: join('{workspace}', 'packages', 'app'),
    })
    const project = await workspaceDirectory('mono')
    await stepInWorkspace(ctx, project)
    expect(loader.mounted[0]!.options.config).toMatchObject({ cwd: join(project, 'packages', 'app') })
  })
})
