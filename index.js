// 角色表情立绘插件 —— Host 半（ESM，函数形式）
// 功能：
//   1. 多角色扫描：characters/<角色名>/ 每个子目录一个角色（emotion.png / emotion-N.png 命名规律），
//      目录名即角色 id；characters/ 为空时回退 emotes/（旧默认目录，角色 id 'default'）。
//      没有任何立绘时 = 无角色（空态，不显示任何默认角色）。
//   2. 路由 /character-emote/characters —— 角色清单（含各自情绪表）
//   3. 路由 /character-emote/character （POST）—— 切换当前角色
//   4. 路由 /character-emote/refresh  （POST）—— 重新扫描角色表（丢图后不用重启，点刷新即认）
//   5. 路由 /character-emote/state    —— 当前角色 + 情绪状态（Client 轮询）
//   6. 路由 /character-emote/file/<name> —— 当前角色立绘（basename + 白名单双防护）
//   7. 路由 /character-emote/style    —— 立绘样式读写（持久化到 $DSH_HOME，跨重启/端口变化恢复）
//   8. 工具 set_expression：模型回复前声明情绪，情绪枚举 = 全角色并集（切换角色不重注册，
//      refresh 时若并集变化会重新注册工具），execute 按当前角色表校验
//   9. 流式情绪判定：监听 llm/stream 输出文本，关键词规则实时切图（模型忘调工具也有兜底；
//      模型刚调过 set_expression 的 4 秒内让位给工具结果）
//   10. 情绪模式（v0.6.0 P0-1）：auto/manual/paused；manual 下工具调用/流式判定只记「待定情绪」不切图，
//      设置页经 POST /character-emote/mode 与 /character-emote/apply 手动应用；paused 完全冻结
//   11. 视觉强度（v0.6.0 P0-2）：无更高档位立绘时 state 返回 visualIntensity(0..1)，client 用 scale 模拟；
//      state 另带 files（当前角色全部立绘文件名），client 切换角色时预加载（P0-3）
// 注意：不声明 Config schema（bundle 插件 import 不到 schemastery，配置经 apply(ctx, config) 注入）。
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url))
const CHARACTERS_DIR = join(PLUGIN_ROOT, 'characters')
const LEGACY_DIR = join(PLUGIN_ROOT, 'emotes')
const DSH_HOME = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) || join(homedir(), '.dsh')
const STYLE_FILE = join(DSH_HOME, 'dsh-character-emote-style.json')

export const name = 'dsh-character-emote'
export const inject = ['webServer', 'tools']

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const IMAGE_RE = /^(.+?)(?:-(\d+))?\.([a-zA-Z0-9]+)$/

// 情绪轴表：28 种情绪 → { valence: 正负 -1..1, arousal: 唤醒度 0..1 }
// 心情基线（mood）用它对每次情绪调用做加权累积 + 时间衰减，让情绪有连续性。
const AXIS = {
  admiration: { valence: 0.4, arousal: 0.3 },
  amusement: { valence: 0.7, arousal: 0.6 },
  anger: { valence: -0.8, arousal: 0.9 },
  annoyance: { valence: -0.5, arousal: 0.5 },
  approval: { valence: 0.5, arousal: 0.2 },
  caring: { valence: 0.7, arousal: 0.2 },
  confusion: { valence: -0.2, arousal: 0.4 },
  curiosity: { valence: 0.3, arousal: 0.6 },
  desire: { valence: 0.6, arousal: 0.7 },
  disappointment: { valence: -0.6, arousal: 0.3 },
  disapproval: { valence: -0.5, arousal: 0.4 },
  disgust: { valence: -0.7, arousal: 0.5 },
  embarrassment: { valence: -0.3, arousal: 0.5 },
  excitement: { valence: 0.8, arousal: 0.9 },
  fear: { valence: -0.7, arousal: 0.8 },
  gratitude: { valence: 0.7, arousal: 0.3 },
  grief: { valence: -0.9, arousal: 0.2 },
  joy: { valence: 0.8, arousal: 0.6 },
  love: { valence: 0.9, arousal: 0.5 },
  nervousness: { valence: -0.4, arousal: 0.7 },
  neutral: { valence: 0, arousal: 0 },
  optimism: { valence: 0.6, arousal: 0.4 },
  pride: { valence: 0.6, arousal: 0.4 },
  realization: { valence: 0.2, arousal: 0.5 },
  relief: { valence: 0.5, arousal: 0.1 },
  remorse: { valence: -0.5, arousal: 0.3 },
  sadness: { valence: -0.8, arousal: 0.2 },
  surprise: { valence: 0.2, arousal: 0.8 },
}
const MOOD_HALF_LIFE_MS = 120 * 1000 // 心情半衰期：2 分钟无情绪调用，mood 衰减一半

// 流式情绪判定关键词表：中文为主。strong 词命中 → 强度 1，普通词 → 强度 0
const EMOTION_KEYWORDS = {
  joy: ['开心', '高兴', '哈哈', '嘻嘻', '嘿嘿', '太好了', '好耶', '笑死', '真棒'],
  anger: ['生气', '气死', '可恶', '混蛋', '恼火', '火大', '岂有此理', '气坏了'],
  sadness: ['难过', '伤心', '呜呜', '好难过', '哭', '心碎'],
  surprise: ['惊讶', '震惊', '天啊', '哇', '不会吧', '居然', '竟然', '吓了一跳'],
  fear: ['害怕', '恐怖', '吓死', '好怕', '毛骨悚然'],
  disgust: ['恶心', '讨厌', '嫌弃', '受不了'],
  amusement: ['好笑', '搞笑', '滑稽', '笑喷'],
  embarrassment: ['害羞', '脸红', '不好意思', '尴尬'],
  love: ['喜欢你', '爱你', '心动', '好爱'],
  caring: ['担心', '心疼', '关心', '别怕'],
  approval: ['不错', '很好', '厉害', '赞', '干得好'],
  confusion: ['不懂', '疑惑', '什么鬼', '奇怪'],
  curiosity: ['好奇', '想知道', '是什么'],
  grief: ['悲痛', '悼念', '节哀', '眼泪'],
  nervousness: ['紧张', '忐忑', '不安'],
  relief: ['松口气', '还好', '虚惊一场'],
  realization: ['原来如此', '明白了', '懂了', '恍然大悟'],
  admiration: ['佩服', '崇拜', '太厉害了'],
  desire: ['想要', '渴望', '馋'],
  annoyance: ['烦躁', '烦人', '啧'],
  disapproval: ['不行', '反对', '不认同'],
  disappointment: ['失望', '唉', '白期待'],
  remorse: ['抱歉', '对不起', '懊悔'],
  pride: ['骄傲', '自豪'],
  optimism: ['会好的', '乐观', '没事的'],
  gratitude: ['谢谢', '感谢', '多谢'],
}
const EMOTION_STRONG = ['气死', '吓死', '笑死', '爱死', '开心死了', '高兴坏了', '气坏了']

// 扩展触发条件：标点符号、表情符号、语气词
const TRIGGER_CONDITIONS = {
  // 标点符号触发
  punctuation: (text) => {
    if (text.includes('！') || text.includes('!')) return { emotion: 'excitement', intensity: 1 }
    if (text.includes('？') || text.includes('?')) return { emotion: 'confusion', intensity: 0 }
    if (text.includes('...')) return { emotion: 'sadness', intensity: 0 }
    return null
  },
  
  // 表情符号触发
  emoji: (text) => {
    if (text.includes('😊') || text.includes('😄')) return { emotion: 'joy', intensity: 1 }
    if (text.includes('😠') || text.includes('😡')) return { emotion: 'anger', intensity: 1 }
    if (text.includes('😢') || text.includes('😭')) return { emotion: 'sadness', intensity: 1 }
    if (text.includes('😲') || text.includes('🤯')) return { emotion: 'surprise', intensity: 1 }
    return null
  },
  
  // 语气词触发
  interjection: (text) => {
    if (text.includes('哇') || text.includes('啊')) return { emotion: 'surprise', intensity: 1 }
    if (text.includes('哎') || text.includes('唉')) return { emotion: 'disappointment', intensity: 0 }
    if (text.includes('嘿') || text.includes('嘻嘻')) return { emotion: 'amusement', intensity: 1 }
    return null
  }
}

// ── 样式持久化（$DSH_HOME/dsh-character-emote-style.json，跨重启/端口变化恢复）──
const STYLE_DEFAULTS = { size: 260, side: 'right', x: 0, y: 0, opacity: 100, animate: true }
function sanitizeStyle(body) {
  const s = body && typeof body === 'object' ? body : {}
  const w = typeof window !== 'undefined' && window.innerWidth || 1200
  const h = typeof window !== 'undefined' && window.innerHeight || 800
  const size = typeof s.size === 'number' && !Number.isNaN(s.size) ? Math.max(120, Math.min(420, s.size)) : STYLE_DEFAULTS.size
  const side = (s.side === 'left' || s.side === 'right') ? s.side : 'free'
  const x = typeof s.x === 'number' && !Number.isNaN(s.x) ? s.x : (side === 'left' ? 28 : w - 28 - Math.round(size * 0.7))
  const y = typeof s.y === 'number' && !Number.isNaN(s.y) ? s.y : h - size - 140
  const opacity = typeof s.opacity === 'number' && !Number.isNaN(s.opacity) ? Math.max(30, Math.min(100, s.opacity)) : 100
  return {
    size,
    side,
    x,
    y,
    opacity,
    animate: s.animate !== false,
  }
}
function readStyleFile() {
  try {
    const parsed = JSON.parse(readFileSync(STYLE_FILE, 'utf8'))
    return sanitizeStyle(parsed)
  } catch {
    return sanitizeStyle({})
  }
}
function writeStyleFile(style) {
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(STYLE_FILE, JSON.stringify(style, null, 2), 'utf8')
    return true
  } catch (e) {
    console.warn('[dsh-character-emote] style write failed: ' + e.message)
    return false
  }
}

// 扫描目录 → { table: { 情绪: [基础, 变体1, ...]（数组下标=档位，元素=文件名） }, files: Set }
function buildEmoteTable(dir) {
  let names = []
  try { names = readdirSync(dir) } catch { return null }
  const table = {}
  const files = new Set()
  for (const n of names) {
    const ext = n.slice(n.lastIndexOf('.')).toLowerCase()
    if (!MIME[ext]) continue
    const m = IMAGE_RE.exec(n)
    if (!m) continue
    const emo = m[1]
    const v = m[2] ? parseInt(m[2], 10) : 0
    if (!table[emo]) table[emo] = []
    table[emo][v] = n
    files.add(n)
  }
  return Object.keys(table).length > 0 ? { table, files } : null
}

// 选图：intensity 钳制到该情绪可用档位，档位空洞时就近取
function pickFile(table, emotion, intensity) {
  const arr = table[emotion]
  if (!arr) return null
  const max = arr.length - 1
  let level = Math.max(0, Math.min(intensity | 0, max))
  for (let i = level; i >= 0; i--) if (arr[i]) return arr[i]
  for (let i = level + 1; i <= max; i++) if (arr[i]) return arr[i]
  return null
}

function buildCharacter(id, dir) {
  const t = buildEmoteTable(dir)
  if (!t) return null
  return { id, dir, table: t.table, files: t.files }
}

function serveFile(file, res) {
  try {
    const data = readFileSync(file)
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=3600',
    })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function apply(ctx) {
  console.log('[dsh-character-emote] plugin loaded (host half)')
  try { mkdirSync(CHARACTERS_DIR, { recursive: true }) } catch { /* ignore */ }

  // ── 可变状态：角色表 / 全情绪并集 / 当前角色 / 当前情绪 / 工具 disposer
  let characters = []
  let allEmotions = []
  let active = null
  let current = null
  let toolDisposer = null
  // 心情基线：valence 正负 / arousal 唤醒度，随时间衰减回中，情绪调用按比例混入
  let mood = { valence: 0, arousal: 0, at: Date.now() }
  // 最近一次模型工具调用时间：流式判定让位给工具结果（4 秒内不覆盖）
  let lastToolAt = 0
  // ── 情绪模式（v0.6.0 P0-1）：auto 自动切换 / manual 只记待定不切图 / paused 完全冻结 ──
  let mode = 'auto'
  let pending = null

  // ── 流式情绪判定：扫描模型输出文本，命中关键词即切图（工具优先，4 秒让位）──
  function detectEmotion(text) {
    // 优先使用关键词检测
    for (const [emo, words] of Object.entries(EMOTION_KEYWORDS)) {
      for (const w of words) {
        if (text.includes(w)) {
          return { emotion: emo, strong: EMOTION_STRONG.some((s) => text.includes(s)), triggerType: 'keyword' }
        }
      }
    }
    
    // 扩展触发条件：标点符号、表情符号、语气词
    for (const [type, detector] of Object.entries(TRIGGER_CONDITIONS)) {
      const result = detector(text)
      if (result) {
        return { ...result, triggerType: type }
      }
    }
    
    return null
  }
  async function* wrapForEmotion(upstream) {
    let buffer = ''
    let switched = false
    for await (const chunk of upstream) {
      yield chunk
      if (switched) continue
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        buffer += chunk.text
        if (buffer.length < 2) continue
        const hit = detectEmotion(buffer)
        if (hit && active && active.table[hit.emotion]) {
          switched = true
          if (Date.now() - lastToolAt > 4000) {
            applyEmotion(hit.emotion, hit.strong ? 1 : 0, null, { source: 'stream' })
          }
        }
      }
    }
  }

  const pickDefault = () => characters[0] || null

  // mood 时间衰减：按距上次调用的时间差指数衰减（半衰期 MOOD_HALF_LIFE_MS）
  function decayMood(now) {
    const dt = now - mood.at
    if (dt <= 0) return
    const f = Math.pow(0.5, dt / MOOD_HALF_LIFE_MS)
    mood.valence *= f
    mood.arousal *= f
    mood.at = now
  }

  // 应用一次情绪：衰减 → 跳变缓冲 → 更新 mood → 定立绘
  // 跳变缓冲：新情绪与 mood 方向相反且差距大（如 angry 后秒 joy）→ 自动降一档强度，避免情绪硬切
  function setEmotion(emotion, intensity, secondary) {
    if (!active) { current = null; return null }
    const axis = AXIS[emotion] || { valence: 0, arousal: 0 }
    const now = Date.now()
    decayMood(now)
    const maxLevel = (active.table[emotion] || []).length - 1
    let level = Math.max(0, Math.min(intensity | 0, maxLevel))
    const prevV = mood.valence
    if (prevV !== 0 && Math.sign(prevV) !== Math.sign(axis.valence) && Math.abs(prevV - axis.valence) > 1.2) {
      level = Math.max(0, level - 1)
    }
    
    // 动态强度映射：根据心情调整强度
    const moodFactor = mood.valence > 0 ? 1.2 : 0.8
    const adjustedLevel = Math.round(level * moodFactor)
    const finalLevel = Math.max(0, Math.min(adjustedLevel, maxLevel))
    
    mood.valence = mood.valence * 0.6 + axis.valence * 0.4
    mood.arousal = mood.arousal * 0.6 + axis.arousal * 0.4
    mood.at = now
    const file = pickFile(active.table, emotion, finalLevel)
    // P0-2（v0.6.0）：无更高档位图时用视觉强度模拟（0..1）。
    // 有变体图且请求强度未超出可用档位 → 0 不叠加（向后兼容）；
    // 超出可用档位 / 单图情绪 → 超出部分按比例映射，client 用 scale 模拟。
    const visualIntensity = maxLevel > 0
      ? Math.max(0, Math.min(1, (adjustedLevel - finalLevel) / maxLevel))
      : Math.max(0, Math.min(1, adjustedLevel / 3))
    current = {
      character: active.id,
      emotion,
      intensity: finalLevel,
      secondary: secondary || null,
      file,
      visualIntensity: Math.round(visualIntensity * 100) / 100,
      mood: { valence: Math.round(mood.valence * 100) / 100, arousal: Math.round(mood.arousal * 100) / 100 },
    }
    return current
  }

  // 情绪请求入口（工具调用 / 流式判定都走这里）：按当前模式处理
  // auto → 直接切换；manual → 只更新待定情绪不切图；paused → 完全忽略
  function applyEmotion(emotion, intensity, secondary, opts) {
    const src = (opts && opts.source) || 'tool'
    if (mode === 'paused') {
      return { applied: false, state: current, message: 'paused（情绪冻结中）' }
    }
    if (mode === 'manual') {
      pending = { emotion, intensity: intensity | 0, secondary: secondary || null }
      if (src === 'tool') lastToolAt = Date.now()
      return { applied: false, pending, state: current, message: 'manual：已记录待定情绪，设置页手动应用' }
    }
    if (src === 'tool') lastToolAt = Date.now()
    const state = setEmotion(emotion, intensity, secondary)
    return { applied: true, state, message: 'applied' }
  }

  function rescan() {
    const next = []
    try {
      for (const entry of readdirSync(CHARACTERS_DIR)) {
        const full = join(CHARACTERS_DIR, entry)
        let isDir = false
        try { isDir = statSync(full).isDirectory() } catch { /* ignore */ }
        if (!isDir) continue
        const c = buildCharacter(entry, full)
        if (c) next.push(c)
      }
    } catch { /* ignore */ }
    // characters/ 为空时回退旧默认目录 emotes/（角色 id 'default'）
    if (next.length === 0) {
      const c = buildCharacter('default', LEGACY_DIR)
      if (c) next.push(c)
    }
    characters = next
    allEmotions = [...new Set(characters.flatMap((c) => Object.keys(c.table)))]

    // active 失效（角色被删/重扫后对象替换）→ 回退第一个
    if (!characters.some((c) => c === active)) active = pickDefault()
    pending = null
    resetCurrent()
  }

  function resetCurrent() {
    if (!active) { current = null; return }
    const emotions = Object.keys(active.table)
    if (emotions.length === 0) { current = null; return }
    const first = emotions.includes('neutral') ? 'neutral' : emotions[0]
    mood = { valence: 0, arousal: 0, at: Date.now() }
    setEmotion(first, 0, null)
  }

  // 工具注册（可重复调用：refresh 时先卸旧的再注册，保证情绪枚举是最新并集）
  function registerTool() {
    if (toolDisposer) {
      try { toolDisposer() } catch { /* ignore */ }
      toolDisposer = null
    }
    if (allEmotions.length === 0) return
    try {
      const tool = {
        name: 'set_expression',
        description: '切换当前角色立绘的面部表情。在回复正文之前，根据你此刻的情绪调用一次：emotion 选最贴近的主情绪，secondary 可填复合的副情绪（如「惊喜又害羞」就填 surprise 主 + embarrassment 副），intensity 表示强度（0 为基础档，数字越大情绪越强烈；可用档位取决于该情绪在当前角色下拥有的变体数量）。情绪不能硬切：与心情相反时会自动缓冲降档。',
        parameters: {
          type: 'object',
          properties: {
            emotion: {
              type: 'string',
              description: '主情绪名：' + allEmotions.join(', '),
              enum: allEmotions,
            },
            secondary: {
              type: 'string',
              description: '副情绪（可选）：复合情绪时的第二情绪，例如 joy 主 + embarrassment 副 = 又开心又害羞',
              enum: allEmotions,
            },
            intensity: {
              type: 'integer',
              description: '强度档位，0 为默认；例如 anger 支持 0-3，joy 只有 0。',
            },
          },
          required: ['emotion'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              emotion: { type: 'string', enum: allEmotions },
              secondary: { type: 'string', enum: allEmotions },
              file: { type: 'string' },
              visualIntensity: { type: 'number' },
              message: { type: 'string' },
              mood: {
                type: 'object',
                properties: {
                  valence: { type: 'number' },
                  arousal: { type: 'number' },
                },
                required: ['valence', 'arousal'],
                additionalProperties: false,
              },
            },
            required: ['ok', 'emotion', 'file'],
            additionalProperties: false,
          },
          render: (args, value) => [
            { type: 'text', text: '立绘表情 → ' + value.emotion + (value.secondary ? ' + ' + value.secondary : '') + (value.message ? '（' + value.message + '）' : '') },
          ],
        },
        execute: async (args) => {
          const emotion = args && args.emotion
          if (!active || !active.table[emotion]) {
            return {
              ok: false,
              emotion: current ? current.emotion : null,
              file: current ? current.file : null,
              message: '当前角色（' + (active ? active.id : '?') + '）无此情绪: ' + String(emotion),
            }
          }
          const intensity = args && typeof args.intensity === 'number' ? Math.floor(args.intensity) : 0
          const secondary = args && typeof args.secondary === 'string' && active.table[args.secondary] ? args.secondary : null
          const result = applyEmotion(emotion, intensity, secondary, { source: 'tool' })
          if (result.applied && result.state) {
            return { ok: true, emotion, secondary, file: result.state.file, mood: result.state.mood, visualIntensity: result.state.visualIntensity, message: 'intensity ' + result.state.intensity }
          }
          const st = current
          return {
            ok: true,
            emotion,
            secondary,
            file: st ? st.file : null,
            mood: st ? st.mood : { valence: 0, arousal: 0 },
            visualIntensity: st ? st.visualIntensity : 0,
            message: result.message || '',
          }
        },
      }
      toolDisposer = ctx.tools.register(tool)
      console.log('[dsh-character-emote] tool registered, emotions=' + allEmotions.length)
    } catch (e) {
      console.warn('[dsh-character-emote] tool registration failed: ' + ((e && e.message) || e))
    }
  }

  rescan()
  registerTool()

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/character-emote',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        if (url.pathname === '/character-emote/characters') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(characters.map((c) => ({
            id: c.id,
            dir: c.dir,
            emotions: Object.keys(c.table),
          }))))
          return
        }
        if (url.pathname === '/character-emote/style') {
          if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(readStyleFile()))
            return
          }
          if (req.method === 'POST') {
            let body = {}
            try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
            const style = sanitizeStyle(body || {})
            writeStyleFile(style)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, style }))
            return
          }
        }
        if (url.pathname === '/character-emote/refresh' && req.method === 'POST') {
          rescan()
          registerTool()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({
            ok: true,
            characters: characters.map((c) => c.id),
            state: current,
          }))
          return
        }
        if (url.pathname === '/character-emote/character' && req.method === 'POST') {
          let body = {}
          try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
          const target = characters.find((c) => c.id === (body && body.id))
          if (!target) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'unknown character: ' + String((body && body.id)) }))
            return
          }
          active = target
          pending = null
          resetCurrent()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, state: current }))
          return
        }
        if (url.pathname === '/character-emote/state') {
          const base = current || {
            character: active ? active.id : null,
            emotion: null,
            intensity: 0,
            secondary: null,
            file: null,
            visualIntensity: 0,
            mood: { valence: 0, arousal: 0 },
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(Object.assign({}, base, {
            mode,
            pending,
            files: active ? [...active.files] : [],
          })))
          return
        }
        if (url.pathname === '/character-emote/mode' && req.method === 'POST') {
          let body = {}
          try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
          const next = (body && body.mode) || 'auto'
          if (next !== 'auto' && next !== 'manual' && next !== 'paused') {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'mode must be auto/manual/paused' }))
            return
          }
          mode = next
          pending = null
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, mode, state: current }))
          return
        }
        if (url.pathname === '/character-emote/apply' && req.method === 'POST') {
          let body = {}
          try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
          const emotion = body && body.emotion
          if (!active || !active.table[emotion]) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'unknown emotion: ' + String(emotion) }))
            return
          }
          const intensity = typeof body.intensity === 'number' ? Math.floor(body.intensity) : 0
          const secondary = typeof body.secondary === 'string' && active.table[body.secondary] ? body.secondary : null
          lastToolAt = Date.now()
          const state = setEmotion(emotion, intensity, secondary)
          pending = null
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, state }))
          return
        }
        if (url.pathname.startsWith('/character-emote/file/') && active) {
          const raw = url.pathname.slice('/character-emote/file/'.length)
          let name
          try { name = decodeURIComponent(raw) } catch { name = raw }
          const safe = basename(name)
          if (safe !== name || !active.files.has(safe)) {
            res.writeHead(404, { 'content-type': 'text/plain' })
            res.end('not found')
            return
          }
          serveFile(join(active.dir, safe), res)
          return
        }
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
      },
    }),
    'dsh-character-emote: routes',
  )

  // 插件卸载时清掉工具注册
  ctx.effect(() => () => {
    if (toolDisposer) {
      try { toolDisposer() } catch { /* ignore */ }
      toolDisposer = null
    }
  }, 'dsh-character-emote: tool cleanup')

  // 流式情绪判定：包裹每次模型生成流，输出文本命中关键词即自动切图
  const streamDisposer = ctx.on('llm/stream', (_options, next) => {
    try {
      return wrapForEmotion(next())
    } catch (e) {
      console.warn('[dsh-character-emote] stream wrap failed: ' + ((e && e.message) || e))
      return next()
    }
  })
  ctx.effect(() => streamDisposer, 'dsh-character-emote: llm/stream watcher')

  console.log('[dsh-character-emote] loaded, characters=[' + characters.map((c) => c.id).join(', ') + '], active=' + (active ? active.id : 'none'))
}
