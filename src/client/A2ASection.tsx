/**
 * A2A network settings page.
 *
 * The page is self-contained: it polls the same-origin admin snapshot, edits
 * nodes through the Host config editor, and never receives a bearer token
 * value. Styling uses the shell's semantic theme aliases.
 *
 * @module @local/dsh-a2a/client/A2ASection
 */

import { useEffect, useState, type CSSProperties } from 'react'
import {
  deleteNode,
  fetchState,
  refreshNode,
  saveInboundToken,
  saveNode,
  saveNodeToken,
  savePeerToken,
  type AdminLogEntry,
  type AdminNode,
  type AdminState,
  type NodeInput,
} from './api.ts'

const zh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')

const copy = {
  title: zh ? 'A2A 网络' : 'A2A network',
  subtitle: zh
    ? '对外提供 Agent Card 与 JSON-RPC 任务端点，并把远端 Agent 的 Skills 注册为本地工具。'
    : 'Serve an Agent Card and JSON-RPC task endpoint, and mount remote agent skills as local tools.',
  loading: zh ? '加载中…' : 'Loading…',
  server: zh ? '本地 A2A 服务' : 'Local A2A server',
  outbound: zh ? '出站节点' : 'Outbound nodes',
  activity: zh ? '收发活动' : 'Activity',
  enabled: zh ? '已启用' : 'Enabled',
  disabled: zh ? '已关闭' : 'Disabled',
  endpoint: zh ? '端点' : 'Endpoint',
  cardPath: 'Agent Card',
  viewCard: zh ? '查看卡片' : 'View card',
  auth: zh ? '鉴权' : 'Authentication',
  noAuth: zh ? '无' : 'None',
  bearer: 'Bearer',
  tokenSet: zh ? '令牌已配置' : 'Token configured',
  tokenMissing: zh ? '未配置令牌' : 'No token configured',
  inboundToken: zh ? '入站令牌' : 'Inbound token',
  inboundTokenHint: zh
    ? '只写不回显；留空保存表示保持现状，点击“清除”删除。'
    : 'Write-only; leave blank to keep the current token, or use Clear to remove it.',
  peers: zh ? '入站 peer 令牌' : 'Inbound peer tokens',
  peersHint: zh
    ? '按 peer 拆分的令牌：每个 peer 一枚，入站时据此识别来源。只写不回显。'
    : 'Per-peer tokens: one per peer, used to identify the caller. Write-only.',
  save: zh ? '保存' : 'Save',
  clear: zh ? '清除' : 'Clear',
  saved: zh ? '已保存。配置变更可能需要一次重载。' : 'Saved. A configuration change may reload the plugin.',
  newToken: zh ? '新令牌' : 'New token',
  nodeName: zh ? '名称' : 'Name',
  nodeUrl: zh ? '地址（不含 /a2a）' : 'Base URL (without /a2a)',
  nodeId: 'ID',
  nodeToken: zh ? '节点令牌（只写）' : 'Node token (write-only)',
  keepToken: zh ? '留空则保留现有令牌' : 'Leave blank to keep the current token',
  tokenEnv: zh ? '令牌环境变量' : 'Token environment variable',
  add: zh ? '添加节点' : 'Add node',
  edit: zh ? '编辑' : 'Edit',
  cancel: zh ? '取消' : 'Cancel',
  refresh: zh ? '刷新卡片' : 'Refresh',
  remove: zh ? '删除' : 'Delete',
  autoDiscover: zh ? '启动时自动发现' : 'Discover on start',
  skills: zh ? '技能' : 'Skills',
  tools: zh ? '工具' : 'Tools',
  status: zh ? '状态' : 'Status',
  notDiscovered: zh ? '尚未发现' : 'Not discovered yet',
  noNodes: zh ? '还没有配置远端节点。' : 'No remote nodes configured yet.',
  noLogs: zh ? '暂无活动。' : 'No activity yet.',
  activeTasks: zh ? '活动任务' : 'Active tasks',
  totalTasks: zh ? '累计任务' : 'Total tasks',
  registeredTools: zh ? '已注册工具' : 'Registered tools',
  discovered: zh ? '已发现节点' : 'Discovered nodes',
  confirmDelete: zh ? '删除这个节点及其令牌？' : 'Delete this node and its stored token?',
  error: zh ? '错误' : 'Error',
  required: zh ? 'ID、名称和地址都不能为空。' : 'ID, name, and URL are required.',
}

const ui: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 0 24px', color: 'inherit' },
  header: { display: 'flex', flexDirection: 'column', gap: 4 },
  h1: { margin: 0, fontSize: 20, fontWeight: 600 },
  subtitle: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary, inherit)', lineHeight: 1.5 },
  card: {
    border: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 16%, transparent))',
    borderRadius: 10,
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  h2: { margin: 0, fontSize: 15, fontWeight: 600 },
  h3: { margin: 0, fontSize: 13, fontWeight: 600 },
  grid: { display: 'grid', gridTemplateColumns: 'minmax(100px, max-content) 1fr', gap: '8px 16px', margin: 0, fontSize: 13 },
  label: { color: 'var(--dsw-alias-label-secondary, inherit)' },
  value: { wordBreak: 'break-all' },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 },
  stat: {
    padding: '10px 12px',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-2, color-mix(in srgb, currentColor 5%, transparent))',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  statValue: { fontSize: 20, fontWeight: 600 },
  statLabel: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left',
    padding: '8px 10px',
    borderBottom: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 16%, transparent))',
    color: 'var(--dsw-alias-label-secondary, inherit)',
    fontWeight: 500,
  },
  td: {
    padding: 10,
    borderBottom: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 10%, transparent))',
    verticalAlign: 'top',
  },
  input: {
    padding: '7px 9px',
    borderRadius: 7,
    fontSize: 13,
    color: 'inherit',
    border: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 22%, transparent))',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    minWidth: 0,
    width: '100%',
    boxSizing: 'border-box',
  },
  button: {
    padding: '7px 12px',
    borderRadius: 7,
    fontSize: 13,
    cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 22%, transparent))',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    color: 'inherit',
  },
  primary: {
    padding: '7px 12px',
    borderRadius: 7,
    fontSize: 13,
    cursor: 'pointer',
    border: '1px solid transparent',
    background: 'var(--dsw-alias-brand-primary, #2563eb)',
    color: '#fff',
  },
  danger: { color: 'var(--dsw-alias-state-error-primary, #dc2626)' },
  form: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 },
  hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)', lineHeight: 1.45, margin: 0 },
  notice: { fontSize: 13, color: 'var(--dsw-alias-state-success-primary, #15803d)' },
  error: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #dc2626)' },
  logs: { display: 'flex', flexDirection: 'column', maxHeight: 260, overflow: 'auto' },
  log: {
    display: 'grid',
    gridTemplateColumns: '70px 64px 1fr auto',
    gap: 8,
    padding: '6px 0',
    fontSize: 12,
    borderBottom: '1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 8%, transparent))',
    alignItems: 'baseline',
  },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, wordBreak: 'break-all' },
  badge: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid currentColor', opacity: 0.8 },
}

/** Empty edit form. */
function emptyForm(): NodeInput {
  return {
    id: '',
    name: '',
    url: '',
    enabled: true,
    autoDiscover: true,
    auth: { mode: 'bearer', tokenEnv: 'DSH_A2A_TOKEN' },
  }
}

/** Convert one node row into the edit form. */
function formOf(node: AdminNode): NodeInput {
  return {
    id: node.id,
    name: node.name,
    url: node.url,
    enabled: node.enabled,
    autoDiscover: node.autoDiscover,
    auth: { mode: node.authMode, tokenEnv: node.tokenEnv },
  }
}

/** Format one log time. */
function timeOf(entry: AdminLogEntry): string {
  try {
    return new Date(entry.time).toLocaleTimeString()
  } catch {
    return entry.time
  }
}

/** Settings page component. */
export function A2ASection() {
  const [state, setState] = useState<AdminState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<NodeInput>(emptyForm)
  const [editing, setEditing] = useState(false)
  const [nodeToken, setNodeToken] = useState('')
  const [inboundToken, setInboundToken] = useState('')
  const [peerTokens, setPeerTokens] = useState<Record<string, string>>({})

  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    const load = async (): Promise<void> => {
      try {
        const next = await fetchState(controller.signal)
        setState(next)
        setError(undefined)
      } catch (failure: unknown) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => { void load() }, 3000)
      }
    }
    void load()
    return () => {
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  const reload = async (): Promise<void> => {
    try {
      setState(await fetchState())
    } catch {
      // Polling retries; a config edit may briefly restart the plugin.
    }
  }

  const run = async (action: () => Promise<void>, success: string): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
      setNotice(success)
      await reload()
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event: { preventDefault: () => void }): Promise<void> => {
    event.preventDefault()
    if (form.id.trim().length === 0 || form.name.trim().length === 0 || form.url.trim().length === 0) {
      setError(copy.required)
      return
    }
    await run(async () => {
      await saveNode(form, nodeToken)
      setNodeToken('')
    }, copy.saved)
  }

  const beginEdit = (node: AdminNode): void => {
    setForm(formOf(node))
    setEditing(true)
    setNodeToken('')
    setNotice(undefined)
  }

  const reset = (): void => {
    setForm(emptyForm())
    setEditing(false)
    setNodeToken('')
  }

  return (
    <section style={ui.root}>
      <header style={ui.header}>
        <h1 style={ui.h1}>{copy.title}</h1>
        <p style={ui.subtitle}>{copy.subtitle}</p>
      </header>

      {error === undefined ? null : <div style={ui.error} role="alert">{copy.error}: {error}</div>}
      {notice === undefined ? null : <div style={ui.notice} role="status">{notice}</div>}
      {state === undefined ? <p style={ui.hint}>{copy.loading}</p> : (
        <>
          <div style={ui.stats}>
            <Stat value={String(state.tasks.active)} label={copy.activeTasks} />
            <Stat value={String(state.tasks.total)} label={copy.totalTasks} />
            <Stat value={String(state.client.discoveredNodes)} label={copy.discovered} />
            <Stat value={String(state.client.registeredTools)} label={copy.registeredTools} />
          </div>

          <section style={ui.card}>
            <h2 style={ui.h2}>{copy.server}</h2>
            <dl style={ui.grid}>
              <dt style={ui.label}>{copy.endpoint}</dt>
              <dd style={ui.value}><code style={ui.code}>{state.server.rpcUrl}</code></dd>
              <dt style={ui.label}>{copy.cardPath}</dt>
              <dd style={ui.value}>
                <code style={ui.code}>{state.server.agentCardPath}</code>
                {' '}
                <a href={state.server.agentCardPath} target="_blank" rel="noreferrer">{copy.viewCard}</a>
                {state.server.agentCardAliases.map(path => <div key={path}><code style={ui.code}>{path}</code></div>)}
              </dd>
              <dt style={ui.label}>{copy.auth}</dt>
              <dd style={ui.value}>
                {state.server.authMode === 'none'
                  ? copy.noAuth
                  : `${copy.bearer} · ${state.server.tokenConfigured
                    ? copy.tokenSet
                    : state.server.peers.length > 0
                      ? (zh
                        ? `${String(state.server.peers.length)} 个 peer 令牌`
                        : `${String(state.server.peers.length)} peer token(s)`)
                      : copy.tokenMissing}`}
              </dd>
            </dl>
            <div style={ui.row}>
              <input
                style={{ ...ui.input, maxWidth: 320 }}
                type="password"
                autoComplete="new-password"
                placeholder={state.server.tokenConfigured ? copy.newToken : copy.inboundToken}
                value={inboundToken}
                onChange={event => { setInboundToken(event.target.value) }}
              />
              <button
                type="button"
                style={ui.primary}
                disabled={busy}
                onClick={() => { void run(async () => { await saveInboundToken(inboundToken); setInboundToken('') }, copy.saved) }}
              >{copy.save}</button>
              <button
                type="button"
                style={ui.button}
                disabled={busy}
                onClick={() => { void run(async () => { await saveInboundToken('') }, copy.saved) }}
              >{copy.clear}</button>
            </div>
            <p style={ui.hint}>{copy.inboundTokenHint}</p>

            {state.server.peers.length === 0 ? null : (
              <>
                <h3 style={ui.h3}>{copy.peers}</h3>
                {state.server.peers.map(peer => (
                  <div key={peer.id} style={ui.row}>
                    <span style={ui.label}>{peer.id}</span>
                    <span style={ui.badge}>
                      {peer.tokenConfigured ? copy.tokenSet : copy.tokenMissing}
                    </span>
                    <input
                      style={{ ...ui.input, maxWidth: 260 }}
                      type="password"
                      autoComplete="new-password"
                      placeholder={peer.tokenConfigured ? copy.newToken : copy.inboundToken}
                      value={peerTokens[peer.id] ?? ''}
                      onChange={event => {
                        const value = event.target.value
                        setPeerTokens(current => ({ ...current, [peer.id]: value }))
                      }}
                    />
                    <button
                      type="button"
                      style={ui.primary}
                      disabled={busy}
                      onClick={() => {
                        void run(async () => {
                          await savePeerToken(peer.id, peerTokens[peer.id] ?? '')
                          setPeerTokens(current => ({ ...current, [peer.id]: '' }))
                        }, copy.saved)
                      }}
                    >{copy.save}</button>
                    <button
                      type="button"
                      style={ui.button}
                      disabled={busy}
                      onClick={() => { void run(async () => { await savePeerToken(peer.id, '') }, copy.saved) }}
                    >{copy.clear}</button>
                  </div>
                ))}
                <p style={ui.hint}>{copy.peersHint}</p>
              </>
            )}
          </section>

          <section style={ui.card}>
            <div style={ui.row}>
              <h2 style={{ ...ui.h2, flex: 1 }}>{copy.outbound}</h2>
              <button type="button" style={ui.button} onClick={reset}>{copy.add}</button>
            </div>

            {state.client.nodes.length === 0 ? <p style={ui.hint}>{copy.noNodes}</p> : (
              <table style={ui.table}>
                <thead>
                  <tr>
                    <th style={ui.th}>{copy.nodeName}</th>
                    <th style={ui.th}>{copy.status}</th>
                    <th style={ui.th}>{copy.skills}</th>
                    <th style={ui.th}>{copy.tools}</th>
                    <th style={ui.th} />
                  </tr>
                </thead>
                <tbody>
                  {state.client.nodes.map(node => (
                    <tr key={node.id}>
                      <td style={ui.td}>
                        <div style={{ fontWeight: 600 }}>{node.name}</div>
                        <div style={ui.code}>{node.url}</div>
                        <div style={{ color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 12 }}>
                          {node.enabled ? copy.enabled : copy.disabled} · {node.authMode === 'none' ? copy.noAuth : copy.bearer}
                        </div>
                      </td>
                      <td style={ui.td}>
                        {node.error !== undefined
                          ? <span style={ui.error}>{node.error}</span>
                          : node.card === undefined
                            ? <span style={ui.hint}>{copy.notDiscovered}</span>
                            : <span>
                              {node.card.name} · v{node.card.version}
                              <div style={ui.hint}>{node.card.skills.map(skill => skill.name).join(', ')}</div>
                            </span>}
                      </td>
                      <td style={ui.td}>{String(node.skills)}</td>
                      <td style={ui.td}><code style={ui.code}>{node.tools.join(', ') || '—'}</code></td>
                      <td style={ui.td}>
                        <div style={ui.row}>
                          <button type="button" style={ui.button} disabled={busy} onClick={() => { beginEdit(node) }}>{copy.edit}</button>
                          <button type="button" style={ui.button} disabled={busy} onClick={() => { void run(async () => { await refreshNode(node.id) }, copy.saved) }}>{copy.refresh}</button>
                          <button
                            type="button"
                            style={{ ...ui.button, ...ui.danger }}
                            disabled={busy}
                            onClick={() => {
                              if (!window.confirm(copy.confirmDelete)) return
                              void run(async () => { await deleteNode(node.id) }, copy.saved)
                            }}
                          >{copy.remove}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <form style={ui.form} onSubmit={(event) => { void submit(event) }}>
              <label style={ui.field}>{copy.nodeId}
                <input style={ui.input} value={form.id} readOnly={editing} onChange={event => { setForm({ ...form, id: event.target.value }) }} />
              </label>
              <label style={ui.field}>{copy.nodeName}
                <input style={ui.input} value={form.name} onChange={event => { setForm({ ...form, name: event.target.value }) }} />
              </label>
              <label style={ui.field}>{copy.nodeUrl}
                <input style={ui.input} value={form.url} placeholder="https://agent.example.com" onChange={event => { setForm({ ...form, url: event.target.value }) }} />
              </label>
              <label style={ui.field}>{copy.auth}
                <select
                  style={ui.input}
                  value={form.auth.mode}
                  onChange={event => { setForm({ ...form, auth: { ...form.auth, mode: event.target.value === 'none' ? 'none' : 'bearer' } }) }}
                >
                  <option value="bearer">{copy.bearer}</option>
                  <option value="none">{copy.noAuth}</option>
                </select>
              </label>
              <label style={ui.field}>{copy.tokenEnv}
                <input style={ui.input} value={form.auth.tokenEnv} onChange={event => { setForm({ ...form, auth: { ...form.auth, tokenEnv: event.target.value } }) }} />
              </label>
              <label style={ui.field}>{copy.nodeToken}
                <div style={ui.row}>
                  <input
                    style={{ ...ui.input, flex: 1 }}
                    type="password"
                    autoComplete="new-password"
                    placeholder={copy.keepToken}
                    value={nodeToken}
                    onChange={event => { setNodeToken(event.target.value) }}
                  />
                  <button
                    type="button"
                    style={ui.button}
                    disabled={busy || !editing}
                    onClick={() => { void run(async () => { await saveNodeToken(form.id, '') }, copy.saved) }}
                  >{copy.clear}</button>
                </div>
              </label>
              <label style={{ ...ui.field, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={form.enabled} onChange={event => { setForm({ ...form, enabled: event.target.checked }) }} />
                {copy.enabled}
              </label>
              <label style={{ ...ui.field, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={form.autoDiscover} onChange={event => { setForm({ ...form, autoDiscover: event.target.checked }) }} />
                {copy.autoDiscover}
              </label>
              <div style={ui.row}>
                <button type="submit" style={ui.primary} disabled={busy}>{copy.save}</button>
                <button type="button" style={ui.button} disabled={busy} onClick={reset}>{copy.cancel}</button>
              </div>
            </form>
          </section>

          <section style={ui.card}>
            <h2 style={ui.h2}>{copy.activity}</h2>
            {state.logs.recent.length === 0 ? <p style={ui.hint}>{copy.noLogs}</p> : (
              <div style={ui.logs}>
                {[...state.logs.recent].reverse().map(entry => (
                  <div key={entry.seq} style={ui.log}>
                    <span style={ui.hint}>{timeOf(entry)}</span>
                    <span style={{
                      ...ui.badge,
                      color: entry.level === 'error'
                        ? 'var(--dsw-alias-state-error-primary, #dc2626)'
                        : entry.level === 'warn'
                          ? 'var(--dsw-alias-state-warn-primary, #b45309)'
                          : 'inherit',
                    }}>{entry.direction}</span>
                    <span>
                      {entry.message}
                      {entry.state === undefined ? '' : ` · ${entry.state}`}
                      {entry.durationMs === undefined ? '' : ` · ${String(entry.durationMs)} ms`}
                    </span>
                    <span style={ui.hint}>{entry.peer ?? entry.taskId ?? ''}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </section>
  )
}

/** One compact statistic. */
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={ui.stat}>
      <span style={ui.statValue}>{value}</span>
      <span style={ui.statLabel}>{label}</span>
    </div>
  )
}
