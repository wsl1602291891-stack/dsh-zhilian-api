/**
 * Host half of `dsh-zhilian-api`.
 *
 * The settings page (client.js) is the face; this half owns the pieces a
 * browser page cannot do safely:
 *
 *   1. the one-click authorization exchange — the user's browser lands on the
 *      site's `/dsh/` page, which reads the site's HttpOnly refresh cookie,
 *      redirects back to a loopback handoff page, and posts the short-lived
 *      access token here (`/auth/exchange`) — the token never touches disk;
 *   2. per-group key minting — one named token per enabled site group,
 *      reusing an existing token and updating its model scope in place
 *      (a `PUT` is a whole-record replace, so every other field is refilled);
 *   3. the model catalog — `/api/pricing` filtered to text models, split by
 *      protocol family (GPT→responses, Claude→messages, everything else→chat);
 *   4. balance/usage reads and opening the user's own site pages.
 *
 * Secrets: API keys live in the harness credential plane (`ctx.credentials`),
 * addressed by stable refs (`DSH_NEWAPI_G1`…). Settings store only the ref
 * names, group metadata and the chosen routing. Access tokens are memory-only.
 *
 * @module dsh-zhilian-api
 */

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-zhilian-api'

/** Plugin version, read from package.json so diagnostics never drift from it. */
const VERSION = (() => {
  try {
    const file = fileURLToPath(new URL('./package.json', import.meta.url))
    return String(JSON.parse(readFileSync(file, 'utf8')).version ?? 'unknown')
  } catch {
    return 'unknown'
  }
})()

/** The harness web server is the only hard dependency; credentials are probed. */
export const inject = ['webServer']

const SITE = 'https://api.888425.xyz'
const API_PREFIX = '/plugins/dsh-zhilian-api'
const TOKEN_NAME = 'DSH 桌面 / DeepSeek Harness'
const STATE_TTL_MS = 10 * 60 * 1000
const CATALOG_TTL_MS = 10 * 60 * 1000
const SETTINGS_VERSION = 1

/** Footer entries: the user's own site, in the order the page shows them. */
const ENTRIES = [
  { label: '充值中心', path: '/wallet', note: '余额与兑换码' },
  { label: '模型广场', path: '/pricing', note: '模型与价格' },
  { label: '生图画布', path: '/image/', note: '出图与改图' },
  { label: '视频工作台', path: '/video/', note: '按秒计费视频' },
  { label: '音频工作站', path: '/audio/', note: 'TTS 与配音' },
  { label: '无限画布', path: '/huabu/', note: '画布与提示词' },
  { label: '动效工坊', path: '/motion/', note: '推理模型出片' },
  { label: '试衣间', path: '/tryon/', note: '服装上身预览' },
  { label: '写作工坊', path: '/write/', note: '长文写作' },
  { label: '主站首页', path: '/', note: '控制台与令牌' }
]

/** The three protocol families and what each route declares. */
const ROUTES = [
  { family: 'gpt', api: 'openai-responses', baseURL: `${SITE}/v1`, title: 'GPT / o 系列 / Codex' },
  { family: 'claude', api: 'anthropic-messages', baseURL: SITE, title: 'Claude / Anthropic' },
  { family: 'chat', api: 'openai-completions', baseURL: `${SITE}/v1`, title: '其他全部模型' }
]

// ── small helpers ───────────────────────────────────────────────────────────

/** The harness home, honouring a `DSH_HOME` override. */
function dshHome() {
  const override = process.env.DSH_HOME
  return override && override.trim() !== '' ? override : join(homedir(), '.dsh')
}

/** Where this plugin keeps its non-secret settings. */
function settingsFile() {
  return join(dshHome(), 'storages', 'dsh-zhilian-api', 'settings.json')
}

/** Default settings for a fresh install. */
function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    user: null,
    selection: [],
    groupRefs: {},
    nextRef: 1,
    groups: {},
    routes: {},
    lastSyncAt: 0,
    // How often the settings page re-syncs models while it is open. Never
    // by default: the user opts in.
    refreshInterval: 'never'
  }
}

/** Refresh frequencies the settings page offers, in milliseconds. */
const REFRESH_INTERVALS = {
  never: null,
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
}

/** Read the settings file, falling back to defaults on any damage. */
function readSettings() {
  try {
    const raw = readFileSync(settingsFile(), 'utf8')
    const value = JSON.parse(raw)
    if (value === null || typeof value !== 'object') return defaultSettings()
    return { ...defaultSettings(), ...value }
  } catch {
    return defaultSettings()
  }
}

/** Atomically persist settings (temp file + rename). */
function writeSettings(value) {
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, file)
}

/** Plain-object guard. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a request originated on the loopback interface. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(JSON.stringify(value))
}

/** Write one HTML response. */
function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"
  })
  res.end(html)
}

/** Read a JSON request body. */
async function readJsonBody(req, limitBytes = 256 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/** Open one URL in the system browser. */
function openExternal(url) {
  const options = { detached: true, stdio: 'ignore', windowsHide: true }
  let child
  if (process.platform === 'win32') {
    // Never route through `cmd /c start`: cmd splits the URL at `&`, which
    // silently drops every query parameter after the first one.
    child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], options)
  } else {
    child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], options)
  }
  child.unref()
}

// ── site API requests ────────────────────────────────────────────────────────

/** One JSON request against the site; throws with the site's own message. */
async function siteApi(path, options = {}) {
  const { token, key, method = 'GET', body } = options
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (key) headers.authorization = `Bearer ${key}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${SITE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(25000)
  })
  let data = null
  try {
    data = await response.json()
  } catch {
    /* the status carries the failure */
  }
  if (!response.ok || !isRecord(data) || data.success === false) {
    const error = new Error((isRecord(data) && data.message) || `HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return data
}

/** All tokens, paginated — a reusable one may live past the first page. */
async function listTokens(token) {
  const items = []
  for (let page = 1; page <= 50; page += 1) {
    const response = await siteApi(`/api/token/?p=${page}&size=100`, { token })
    const pageItems = response.data?.items
    if (!Array.isArray(pageItems)) throw new Error('令牌列表读取失败')
    items.push(...pageItems)
    const total = Number(response.data?.total ?? items.length)
    if (pageItems.length < 100 || items.length >= total) return items
  }
  throw new Error('令牌列表过长，未完成读取')
}

/** Whether a listed token may be reused for this plugin (disabled is revivable). */
function reusableToken(token, group) {
  return (
    isRecord(token) &&
    token.name === TOKEN_NAME &&
    (token.status === 1 || token.status === 2) &&
    token.group === group &&
    (token.expired_time === -1 || token.expired_time > Date.now() / 1000 + 60) &&
    token.cross_group_retry !== true
  )
}

/**
 * Find or mint this plugin's token for one group and return its key.
 * Reuse is by name + group; a changed model scope is an in-place `PUT` with
 * every other field refilled from a fresh read (the record is replaced whole).
 */
async function ensureToken(accessToken, group, modelNames, allTokens) {
  const limits = [...modelNames].sort().join(',')
  let token = allTokens.find(row => reusableToken(row, group))
  let action = 'reused'

  if (token === undefined) {
    const created = await siteApi('/api/token/', {
      token: accessToken,
      method: 'POST',
      body: {
        name: TOKEN_NAME,
        group,
        model_limits_enabled: true,
        model_limits: limits,
        remain_quota: 0,
        unlimited_quota: true,
        expired_time: -1,
        allow_ips: '',
        allow_user_quota_query: true,
        cross_group_retry: false,
        auto_groups: []
      }
    })
    const id = created.data?.id
    if (!id) throw new Error('未能创建专用 Key')
    token = (await siteApi(`/api/token/${id}`, { token: accessToken })).data
    action = 'created'
  } else {
    const old = String(token.model_limits || '')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .sort()
      .join(',')
    // A disabled token is enabled and reused, never duplicated: the site's
    // own rule for one-click authorization is one token per purpose.
    if (!token.model_limits_enabled || old !== limits || token.status !== 1) {
      // Fresh read: a stale list snapshot must never be written back.
      token = (await siteApi(`/api/token/${token.id}`, { token: accessToken })).data
      if (!isRecord(token) || token.group !== group || token.cross_group_retry === true) {
        throw new Error(`分组「${group}」的专用 Key 已撤销或失去分组权限，请重新授权`)
      }
      const wasDisabled = token.status === 2
      await siteApi('/api/token/', {
        token: accessToken,
        method: 'PUT',
        body: {
          id: token.id,
          name: token.name,
          expired_time: token.expired_time,
          remain_quota: token.remain_quota,
          unlimited_quota: token.unlimited_quota,
          model_limits_enabled: true,
          model_limits: limits,
          allow_ips: token.allow_ips == null ? '' : token.allow_ips,
          group: token.group,
          status: 1,
          cross_group_retry: token.cross_group_retry,
          auto_groups: token.auto_groups || [],
          allow_user_quota_query: token.allow_user_quota_query
        }
      })
      action = wasDisabled ? 'enabled' : 'updated'
    }
  }

  const keyResponse = await siteApi(`/api/token/${token.id}/key`, { token: accessToken, method: 'POST' })
  const key = keyResponse.data?.key
  if (typeof key !== 'string' || key.trim() === '' || key.includes('*')) {
    throw new Error(`分组「${group}」的 Key 读取失败`)
  }
  return { tokenId: token.id, key, action }
}

// ── model catalog ───────────────────────────────────────────────────────────

/** Video names the site sometimes exposes as chat endpoints. */
const VIDEO_WORDS = /video|sora|veo|kling|hailuo|seedance|pika|runway|luma|wan3/
/** Media names that must never enter the chat catalog. */
const MEDIA_WORDS = /audio|tts|speech|voice|music|sound|whisper|image|dall-e|dalle|imagen|flux|sdxl|stable-diffusion|midjourney|seedream|qwen-image/
/** GPT-family names: the site serves these through `/v1/responses`. */
const GPT_FAMILY = /^(?:gpt|chatgpt|codex|o[1-9])/i
/** Claude-family names: the site serves these through `/v1/messages`. */
const CLAUDE_FAMILY = /^(?:claude|anthropic)/i

/** The protocol family one model name belongs to. */
export function familyOf(modelName) {
  const value = String(modelName)
  if (GPT_FAMILY.test(value)) return 'gpt'
  if (CLAUDE_FAMILY.test(value)) return 'claude'
  return 'chat'
}

/** Whether a pricing row is a text/chat model this plugin may route. */
export function isTextRow(row) {
  if (!isRecord(row) || typeof row.model_name !== 'string') return false
  const modelName = row.model_name.trim()
  if (modelName === '' || modelName.includes(',')) return false
  const capabilities = Array.isArray(row.supported_endpoint_types) ? row.supported_endpoint_types : []
  if (capabilities.includes('image-generation')) return false
  const chatCapable = capabilities.some(type =>
    type === 'openai' || type === 'openai-response' || type === 'anthropic' || type === 'gemini'
  )
  if (!chatCapable) return false
  if (String(row.billing_expr || '').includes('u("seconds")')) return false
  const lower = modelName.toLowerCase()
  if (VIDEO_WORDS.test(lower) || MEDIA_WORDS.test(lower)) return false
  return true
}

/**
 * Group name → `{ gpt: [], claude: [], chat: [] }` for every allowed group.
 * @param rows - pricing rows.
 * @param groups - allowed group names.
 */
export function catalogFor(rows, groups) {
  const map = new Map()
  for (const group of groups) map.set(group, { gpt: [], claude: [], chat: [] })
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isTextRow(row)) continue
    const family = familyOf(row.model_name)
    for (const group of row.enable_groups || []) {
      const entry = map.get(group)
      if (entry === undefined) continue
      entry[family].push(row.model_name)
    }
  }
  for (const entry of map.values()) {
    for (const family of Object.keys(entry)) entry[family] = [...new Set(entry[family])].sort()
  }
  return map
}

/** Protocol label used in provider display names. */
function familyLabel(family) {
  return family === 'gpt' ? 'GPT' : family === 'claude' ? 'Claude' : '通用'
}

/**
 * Provider profiles for the selected groups, split by protocol family.
 * Route ids are stable per group ref, so a re-connect replaces the same rows.
 * @param catalog - output of {@link catalogFor}.
 * @param groupRefs - group name → credential ref.
 * @param groups - selected group names.
 */
export function buildProviders(catalog, groupRefs, groups) {
  const providers = {}
  const routes = {}
  for (const group of groups) {
    const entry = catalog.get(group)
    const ref = groupRefs[group]
    if (entry === undefined || typeof ref !== 'string') continue
    const slug = ref.toLowerCase().replace(/^dsh_newapi_/, '')
    for (const route of ROUTES) {
      const models = entry[route.family]
      if (!Array.isArray(models) || models.length === 0) continue
      const id = `zhilian-${slug}-${route.family}`
      providers[id] = {
        displayName: `智连API · ${group} · ${familyLabel(route.family)}`,
        apiKeyEnv: ref,
        api: route.api,
        baseURL: route.baseURL,
        models: models.map(model => ({
          id: model,
          name: model,
          // Imported models default to image input and a middle thinking
          // strength; the user can change either in the models page.
          input: ['text', 'image'],
          reasoningEfforts: { medium: 'medium', high: 'high', max: 'max' }
        }))
      }
      routes[id] = group
    }
  }
  return { providers, routes }
}

// ── plugin body ─────────────────────────────────────────────────────────────

/**
 * Register the management API on the harness web server.
 * @param ctx - host context carrying `webServer`.
 */
export function apply(ctx) {
  let settings = readSettings()
  /** `{accessToken, user, groups, at}` — memory only. */
  let session = null
  /** Pending authorization hand-offs: state → `{at, used}`. */
  const pending = new Map()
  /**
   * Finished hand-offs: state → `{at, ok, error}`. The settings page asks about
   * its own state, so an older session still held in memory can never be
   * mistaken for the browser round-trip it is waiting on.
   */
  const finished = new Map()
  /** `/api/pricing` snapshot plus the public group metadata. */
  let catalogCache = { at: 0, rows: [], usableGroup: {}, groupRatio: {} }
  /** `/api/status` money metadata. */
  let money = { quotaPerUnit: 500000, rate: 1, systemName: '' }

  // Boot marker: an at-a-glance answer to "did the row load?" without logs.
  try {
    const dir = dirname(settingsFile())
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'boot.json'), `${JSON.stringify({ at: new Date().toISOString(), version: VERSION, pid: process.pid })}\n`)
  } catch {
    /* diagnostics only */
  }

  const refreshMoney = async () => {
    try {
      const response = await fetch(`${SITE}/api/status`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15000)
      })
      const data = await response.json()
      const value = isRecord(data?.data) ? data.data : {}
      money = {
        quotaPerUnit: Number(value.quota_per_unit) || 500000,
        rate: Number(value.usd_exchange_rate) || 1,
        systemName: typeof value.system_name === 'string' ? value.system_name : ''
      }
    } catch {
      /* keep the previous metadata */
    }
  }

  const refreshCatalog = async (token) => {
    let response
    try {
      response = await siteApi('/api/pricing', token === undefined ? {} : { token })
    } catch (error) {
      // An expired access token must not take the public catalog down with it:
      // forget the session and read the anonymous list instead.
      if (token === undefined || error?.status !== 401) throw error
      if (session !== null && session.accessToken === token) session = null
      response = await siteApi('/api/pricing')
    }
    catalogCache = {
      at: Date.now(),
      rows: Array.isArray(response.data) ? response.data : [],
      usableGroup: isRecord(response.usable_group) ? response.usable_group : {},
      groupRatio: isRecord(response.group_ratio) ? response.group_ratio : {}
    }
    return catalogCache
  }

  const ensureCatalog = async () => {
    if (Date.now() - catalogCache.at > CATALOG_TTL_MS || catalogCache.rows.length === 0) {
      await refreshCatalog(session?.accessToken)
    }
    return catalogCache
  }

  /** Groups this account may use; without a session, the public list. */
  const allowedGroups = () => {
    if (session !== null && Array.isArray(session.groups) && session.groups.length > 0) return session.groups
    return Object.keys(catalogCache.usableGroup)
  }

  /** The user shape the page may see. */
  const publicUser = () => {
    if (session !== null) {
      const user = session.user
      return {
        id: user.id,
        username: user.username,
        displayName: user.display_name || user.username,
        quota: user.quota,
        usedQuota: user.used_quota,
        requestCount: user.request_count,
        group: user.group
      }
    }
    return settings.user
  }

  /** One `/state` payload. */
  const stateSnapshot = () => {
    const groups = allowedGroups()
    const catalog = catalogFor(catalogCache.rows, groups)
    const nameOf = group => catalogCache.usableGroup[group] || group
    return {
      ok: true,
      site: SITE,
      authorized: session !== null,
      user: publicUser(),
      money,
      routing: {
        gpt: 'openai-responses',
        claude: 'anthropic-messages',
        chat: 'openai-completions'
      },
      groups: groups.map(group => {
        const entry = catalog.get(group) || { gpt: [], claude: [], chat: [] }
        const connected = settings.groups[group]
        return {
          name: group,
          displayName: nameOf(group) || group,
          ratio: catalogCache.groupRatio[group],
          counts: {
            gpt: entry.gpt.length,
            claude: entry.claude.length,
            chat: entry.chat.length,
            total: entry.gpt.length + entry.claude.length + entry.chat.length
          },
          connected: isRecord(connected) && typeof connected.keyRef === 'string',
          active: settings.selection.includes(group),
          keyRef: isRecord(connected) ? connected.keyRef : undefined,
          tokenId: isRecord(connected) ? connected.tokenId : undefined,
          syncedAt: isRecord(connected) ? connected.syncedAt : undefined
        }
      }),
      selection: settings.selection,
      routes: settings.routes,
      entries: ENTRIES,
      lastSyncAt: settings.lastSyncAt,
      refreshInterval: settings.refreshInterval ?? 'never'
    }
  }

  /** Refresh the account half from the site (also re-filters groups). */
  const loadAccount = async (accessToken) => {
    const [self, groups, pricing] = await Promise.all([
      siteApi('/api/user/self', { token: accessToken }),
      siteApi('/api/user/self/groups', { token: accessToken }),
      siteApi('/api/pricing', { token: accessToken })
    ])
    if (!isRecord(self.data) || self.data.id === undefined) throw new Error('无法确认当前账户')
    const allowed = Object.keys(groups.data || {}).filter(group => group !== '' && group !== 'auto')
    if (allowed.length === 0) throw new Error('该账户没有可用分组')
    session = {
      accessToken,
      user: self.data,
      groups: allowed,
      at: Date.now()
    }
    catalogCache = {
      at: Date.now(),
      rows: Array.isArray(pricing.data) ? pricing.data : [],
      usableGroup: isRecord(pricing.usable_group) ? pricing.usable_group : {},
      groupRatio: isRecord(pricing.group_ratio) ? pricing.group_ratio : {}
    }
    settings.user = publicUser()
    settings.selection = settings.selection.filter(group => allowed.includes(group))
    if (settings.selection.length === 0) {
      const preferred = ['标准区', '高速区'].filter(group => allowed.includes(group))
      const fallback = allowed
        .filter(group => {
          const entry = catalogFor(catalogCache.rows, [group]).get(group)
          return entry !== undefined && entry.gpt.length + entry.claude.length + entry.chat.length > 0
        })
        .slice(0, 2)
      settings.selection = preferred.length > 0 ? preferred : fallback
    }
    writeSettings(settings)
    return { user: publicUser(), groups: allowed }
  }

  /** Allocate a stable credential ref for one group. */
  const refForGroup = (group) => {
    const existing = settings.groupRefs[group]
    if (typeof existing === 'string') return existing
    const used = new Set(Object.values(settings.groupRefs))
    let index = settings.nextRef
    while (used.has(`DSH_NEWAPI_G${index}`)) index += 1
    settings.nextRef = index + 1
    settings.groupRefs[group] = `DSH_NEWAPI_G${index}`
    return settings.groupRefs[group]
  }

  /** The hand-off page the user's browser lands on after the site redirect. */
  const handoffHtml = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>新API 授权 · DeepSeek Harness</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1b1b1d;color:#eaeaea;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:420px;padding:28px 30px;border:1px solid #3a3a3d;border-radius:14px;background:#232326;text-align:center}
h1{margin:0 0 10px;font-size:18px}
p{margin:6px 0;color:#b9b9bf}
#mark{font-size:34px;line-height:1;margin-bottom:12px}
.err{color:#ff8a80}
.ok{color:#7ee787}
</style></head><body><main>
<div id="mark">⏳</div><h1 id="title">正在完成授权…</h1><p id="detail">正在校验本站账号，请稍候。</p>
</main>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var state = params.get('state') || '';
  var hash = new URLSearchParams(location.hash.slice(1));
  var token = hash.get('token') || '';
  var mark = document.getElementById('mark');
  var title = document.getElementById('title');
  var detail = document.getElementById('detail');
  function fail(message) {
    mark.textContent = '⚠️'; mark.className = 'err'; title.textContent = '授权未完成'; detail.textContent = message;
  }
  // The token travels in the fragment; drop it from the address bar and the
  // history entry as soon as it has been read.
  try { history.replaceState(null, '', location.pathname + '?state=' + encodeURIComponent(state)); } catch (_) {}
  if (!state || !token) { fail('缺少授权参数，请回到 DeepSeek Harness 设置页重新发起授权。'); return; }
  fetch('/auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: state, token: token })
  }).then(function (response) {
    return response.json().catch(function () { return null });
  }).then(function (value) {
    if (!value || value.ok !== true) { fail((value && value.error) || '授权交换失败，请重新发起授权。'); return; }
    mark.textContent = '✅'; mark.className = 'ok';
    title.textContent = '授权成功';
    detail.textContent = '已连接账号 ' + (value.user && (value.user.displayName || value.user.username) || '') + '，可以关闭本页，回到 DeepSeek Harness 继续。';
    setTimeout(function () { try { window.close(); } catch (_) {} }, 1200);
  }).catch(function () { fail('无法连接本机 DeepSeek Harness，请确认应用仍在运行后重试。'); });
})();
</script></body></html>`

  /** One authorization exchange; the state is single-use. */
  const exchangeToken = async (state, token) => {
    const record = typeof state === 'string' ? pending.get(state) : undefined
    if (record === undefined || record.used || Date.now() - record.at > STATE_TTL_MS) {
      return { ok: false, error: '授权已过期，请重新发起' }
    }
    // Single use: a replay must not re-run the exchange. The record stays until
    // the outcome is known so the page polling this state sees "in progress".
    record.used = true
    const settle = (result) => {
      pending.delete(state)
      finished.set(state, { at: Date.now(), ok: result.ok, error: result.ok ? undefined : result.error })
      return result
    }
    const accessToken = typeof token === 'string' ? token.trim() : ''
    if (accessToken === '') return settle({ ok: false, error: '授权信息为空' })
    try {
      await loadAccount(accessToken)
      return settle({ ok: true, user: publicUser() })
    } catch (error) {
      return settle({
        ok: false,
        error: error?.status === 401
          ? '登录已过期，请先在网站登录后重新授权'
          : String(error?.message ?? error)
      })
    }
  }

  /** Where one authorization attempt stands: pending, done, failed or unknown. */
  const authStatusFor = (state) => {
    const done = finished.get(state)
    if (done !== undefined) {
      return done.ok
        ? { ok: true, authorized: true, user: publicUser() }
        : { ok: true, authorized: false, failed: true, error: done.error }
    }
    const record = pending.get(state)
    if (record !== undefined && Date.now() - record.at <= STATE_TTL_MS) {
      return { ok: true, authorized: false, waiting: true }
    }
    return { ok: true, authorized: false, failed: true, error: '授权已过期，请重新发起' }
  }

  /**
   * The loopback authorization server. The external browser must reach a URL
   * that needs no DSH web-mode token and exists whatever transport the desktop
   * shell uses (Electron loads dist over file:// / dsh-app://), so the callback
   * gets its own 127.0.0.1 listener with an OS-assigned port.
   */
  let authPort = null
  let resolveAuthPort
  const authPortReady = new Promise(resolve => {
    resolveAuthPort = resolve
  })

  /** Create one state and the site URL that will land on this local server. */
  const startAuth = async () => {
    const port = await authPortReady
    if (port === null) throw new Error('本机授权回调端口未就绪')
    const state = randomBytes(24).toString('base64url')
    pending.set(state, { at: Date.now(), used: false })
    for (const [key, value] of pending) {
      if (Date.now() - value.at > STATE_TTL_MS) pending.delete(key)
    }
    for (const [key, value] of finished) {
      if (Date.now() - value.at > STATE_TTL_MS) finished.delete(key)
    }
    return {
      state,
      // WAF rule: a callback URL in the query string is read as URL-in-URL and
      // answered 403. Only the port travels; the page rebuilds the loopback
      // callback itself.
      url: `${SITE}/dsh/?state=${encodeURIComponent(state)}&port=${port}`
    }
  }

  /** The local server's two routes: hand-off page and exchange. */
  const authHandler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/auth/handoff' && req.method === 'GET') {
        sendHtml(res, 200, handoffHtml())
        return
      }
      if (url.pathname === '/auth/exchange' && req.method === 'POST') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await exchangeToken(body.state, body.token))
        return
      }
      sendJson(res, 404, { ok: false, error: '未知接口' })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }

  ctx.effect(() => {
    const server = createServer(authHandler)
    let settled = false
    const settle = value => {
      if (settled) return
      settled = true
      resolveAuthPort(value)
    }
    server.on('error', () => settle(null))
    server.listen(0, '127.0.0.1', () => {
      authPort = server.address().port
      settle(authPort)
    })
    return () => {
      try {
        server.close()
      } catch {
        /* already closed */
      }
      authPort = null
    }
  }, 'dsh-zhilian-api: loopback authorization server')

  /** Short delay used by the credential-store retries. */
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  /** The credential service, waiting out a plugin reload that is mid-swap. */
  const credentialService = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const service = ctx.get('credentials')
      if (service !== undefined) return service
      await sleep(200)
    }
    throw new Error('DSH 凭据服务不可用，无法保存 Key')
  }

  /** Write one key, retrying the brief window a reloaded store is disposed in. */
  const storeKey = async (credentials, ref, key) => {
    let lastError
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await credentials.set(ref, key)
        return
      } catch (error) {
        lastError = error
        await sleep(250 * (attempt + 1))
      }
    }
    throw lastError
  }

  /** Per-group usage from the stored key (works without a live session). */
  const groupUsage = async (credentials) => {
    const result = []
    for (const [group, entry] of Object.entries(settings.groups)) {
      if (!isRecord(entry) || typeof entry.keyRef !== 'string') continue
      let resolved
      try {
        resolved = await credentials.resolve(entry.keyRef)
      } catch {
        resolved = undefined
      }
      if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value === '') {
        result.push({ group, missing: true })
        continue
      }
      try {
        const response = await siteApi('/api/usage/token/', { key: resolved.value })
        const value = isRecord(response.data) ? response.data : {}
        result.push({
          group,
          available: value.total_available,
          granted: value.total_granted,
          used: value.total_used,
          unlimited: value.unlimited_quota === true,
          expiresAt: value.expires_at,
          keyGroup: value.group
        })
      } catch (error) {
        result.push({ group, error: String(error?.message ?? error) })
      }
    }
    return result
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
      return
    }
    const route = url.pathname.slice(API_PREFIX.length)

    try {
      // ── read state ──────────────────────────────────────────────────────
      if (route === '/state' && req.method === 'GET') {
        await ensureCatalog()
        await refreshMoney()
        sendJson(res, 200, stateSnapshot())
        return
      }

      // ── authorization ───────────────────────────────────────────────────
      if (route === '/auth/status' && req.method === 'GET') {
        // With a state, answer for that one browser round-trip only: a session
        // already in memory must not complete a fresh re-authorization.
        const state = url.searchParams.get('state')
        if (state !== null && state !== '') {
          sendJson(res, 200, authStatusFor(state))
          return
        }
        sendJson(res, 200, { ok: true, authorized: session !== null, user: publicUser() })
        return
      }

      if (route === '/auth/start' && req.method === 'POST') {
        // The browser callback lives on the plugin's own loopback listener (the
        // hand-off page and the token exchange are served there), so no
        // renderer origin is needed or trusted here.
        await readJsonBody(req)
        sendJson(res, 200, { ok: true, ...(await startAuth()) })
        return
      }

      if (route === '/auth/logout' && req.method === 'POST') {
        session = null
        sendJson(res, 200, { ok: true })
        return
      }

      // ── connect: mint keys + declare provider routes ────────────────────
      if (route === '/connect' && req.method === 'POST') {
        if (session === null) {
          sendJson(res, 401, { ok: false, needAuth: true, error: '请先一键授权本站账号' })
          return
        }
        const body = await readJsonBody(req)
        const requested = Array.isArray(body.groups)
          ? body.groups.filter(group => typeof group === 'string')
          : settings.selection
        const allowed = new Set(allowedGroups())
        const groups = [...new Set(requested)].filter(group => allowed.has(group))
        if (groups.length === 0) {
          sendJson(res, 400, { ok: false, error: '没有可接入的分组' })
          return
        }
        const credentials = await credentialService()

        await ensureCatalog()
        if (session === null) {
          // The catalog read found the access token rejected and dropped it.
          sendJson(res, 401, { ok: false, needAuth: true, error: '授权已过期，请重新一键授权' })
          return
        }
        const allTokens = await listTokens(session.accessToken)
        const connected = []
        const skipped = []
        const fresh = {}
        for (const group of groups) {
          const entry = catalogFor(catalogCache.rows, [group]).get(group)
          const models = entry === undefined ? [] : [...entry.gpt, ...entry.claude, ...entry.chat]
          if (models.length === 0) {
            skipped.push({ group, reason: '该分组没有可路由的文本模型' })
            continue
          }
          const ref = refForGroup(group)
          try {
            const minted = await ensureToken(session.accessToken, group, models, allTokens)
            await storeKey(credentials, ref, minted.key)
            fresh[group] = {
              keyRef: ref,
              tokenId: minted.tokenId,
              keyAction: minted.action,
              syncedAt: Date.now()
            }
            connected.push({ group, keyRef: ref, tokenId: minted.tokenId, action: minted.action, models: models.length })
          } catch (error) {
            skipped.push({ group, reason: String(error?.message ?? error) })
          }
        }

        // Diagnostic trail for the settings page: never contains a key, only
        // which group failed and the site/plugin's own message.
        const writeTrail = (removedGroups) => {
          try {
            const dir = dirname(settingsFile())
            mkdirSync(dir, { recursive: true })
            writeFileSync(
              join(dir, 'last-connect.json'),
              `${JSON.stringify({ at: new Date().toISOString(), requested: groups, connected, skipped, removed: removedGroups }, null, 2)}\n`
            )
          } catch {
            /* diagnostics only */
          }
        }

        // Nothing connected: change nothing. Removal below deletes remote tokens
        // and stored keys, so it only runs once at least one requested group has
        // a working replacement. Refs allocated for the failed groups are dropped
        // by re-reading the settings that were last persisted.
        if (connected.length === 0) {
          settings = readSettings()
          writeTrail([])
          sendJson(res, 400, { ok: false, error: '没有任何分组接入成功', skipped })
          return
        }

        // Groups connected before but not picked this time are removed: the
        // remote token, the stored key, and (via buildProviders) their routes.
        // Judge removal by what was asked for, not what succeeded: a group that
        // was requested but failed this round keeps its existing token.
        const requestedSet = new Set(groups)
        const removed = []
        for (const [group, entry] of Object.entries(settings.groups)) {
          if (requestedSet.has(group) || !isRecord(entry)) continue
          if (typeof entry.tokenId === 'number') {
            try {
              await siteApi(`/api/token/${entry.tokenId}`, { token: session.accessToken, method: 'DELETE' })
            } catch (error) {
              skipped.push({ group, reason: `远端令牌删除失败：${String(error?.message ?? error)}` })
            }
          }
          if (typeof entry.keyRef === 'string') {
            try {
              await credentials.unset(entry.keyRef)
            } catch {
              /* a missing key is already gone */
            }
          }
          delete settings.groups[group]
          delete settings.groupRefs[group]
          removed.push(group)
        }

        writeTrail(removed)

        settings.selection = connected.map(item => item.group)
        for (const [group, value] of Object.entries(fresh)) {
          settings.groups[group] = { ...(settings.groups[group] || {}), ...value }
        }
        for (const group of Object.keys(settings.groups)) {
          if (settings.selection.includes(group)) continue
          settings.groups[group] = { ...settings.groups[group], active: false }
        }
        const groupRefs = {}
        for (const group of settings.selection) {
          const ref = settings.groupRefs[group]
          if (typeof ref === 'string') groupRefs[group] = ref
        }
        const catalog = catalogFor(catalogCache.rows, settings.selection)
        const built = buildProviders(catalog, groupRefs, settings.selection)
        const staleRoutes = Object.keys(settings.routes).filter(id => built.routes[id] === undefined)
        settings.routes = built.routes
        settings.lastSyncAt = Date.now()
        writeSettings(settings)

        sendJson(res, 200, {
          ok: true,
          groups: connected,
          skipped,
          removed,
          providers: built.providers,
          staleRoutes,
          state: stateSnapshot()
        })
        return
      }

      // ── model refresh frequency ─────────────────────────────────────────
      if (route === '/refresh-interval' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const value = typeof body.interval === 'string' ? body.interval : ''
        if (!Object.prototype.hasOwnProperty.call(REFRESH_INTERVALS, value)) {
          sendJson(res, 400, { ok: false, error: '刷新频率只能是 never、hourly、daily 或 weekly' })
          return
        }
        settings.refreshInterval = value
        writeSettings(settings)
        sendJson(res, 200, { ok: true, state: stateSnapshot() })
        return
      }

      // ── refresh catalog / balance ───────────────────────────────────────
      if (route === '/refresh' && req.method === 'POST') {
        let warning
        if (session !== null) {
          try {
            await loadAccount(session.accessToken)
          } catch (error) {
            // Only a rejected token ends the session; a timeout or a 5xx is
            // transient and the next refresh may well succeed.
            if (error?.status === 401) {
              session = null
              warning = '授权已过期，请重新点「一键授权」'
            } else {
              warning = `账户信息刷新失败：${String(error?.message ?? error)}`
            }
          }
        }
        if (session === null) await refreshCatalog()
        await refreshMoney()
        sendJson(res, 200, { ok: true, warning, state: stateSnapshot() })
        return
      }

      if (route === '/balance' && req.method === 'GET') {
        const credentials = ctx.get('credentials')
        const account = session !== null
          ? {
              quota: session.user.quota,
              usedQuota: session.user.used_quota,
              requestCount: session.user.request_count,
              group: session.user.group
            }
          : null
        const keys = credentials === undefined ? [] : await groupUsage(credentials)
        sendJson(res, 200, { ok: true, money, account, keys })
        return
      }

      // ── open one of the user's own pages ────────────────────────────────
      if (route === '/open' && req.method === 'POST') {
        const body = await readJsonBody(req)
        let target
        try {
          target = new URL(String(body.url))
        } catch {
          target = null
        }
        if (target === null || target.origin !== SITE) {
          sendJson(res, 400, { ok: false, error: '只允许打开本站页面' })
          return
        }
        openExternal(target.href)
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { ok: false, error: `未知接口 ${route}` })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler
      }),
    'dsh-zhilian-api: management API'
  )

  // Warm the public catalog and money metadata; failures stay silent and the
  // page retries on its own first load.
  void ensureCatalog().catch(() => {})
  void refreshMoney()
}

/** Pure helpers, exported for the plugin's own tests. */
export const _internal = {
  SITE,
  TOKEN_NAME,
  ENTRIES,
  ROUTES,
  familyOf,
  isTextRow,
  catalogFor,
  buildProviders,
  defaultSettings,
  listTokens,
  ensureToken
}
