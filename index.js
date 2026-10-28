/**
 * dsh-qq-bridge — 把 QQ（NapCat / OneBot 11）的消息接进 DSH 会话，并以「大肥鱼」的身份回复。
 *
 * 数据流：
 *   NapCat 正向 WS :3001  ──事件──▶  本插件
 *   本插件 ──prompt──▶ ctx.sessionController（真实 Agent，带工具/记忆/人格）
 *   本插件 ◀─inspect─ 会话日志里的 assistant 文本
 *   本插件 ──HTTP :3000──▶ NapCat ──▶ QQ
 */

import { appendFileSync } from 'node:fs'

export const name = 'dsh-qq-bridge'

export const inject = ['sessionController']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export function apply(ctx, config = {}) {
  const {
    // ── NapCat / OneBot 连接 ──────────────────────────────────────────────
    // OneBot HTTP 接口：插件用它发消息（send_private_msg / send_group_msg）
    httpUrl = 'http://127.0.0.1:3000',
    // OneBot 正向 WebSocket：插件在这里收消息事件（message / meta_event）
    wsUrl = 'ws://127.0.0.1:3001',
    // 协议端 access_token，对应 NapCat 配置里的 token；没设就留空
    token = '',

    // ── 权限：谁能让它说话 ────────────────────────────────────────────────
    // 主人的 QQ 号：私聊全回。填自己的号（数字，不要引号）
    owner = 0,
    // 额外允许私聊的 QQ 号数组，例如 [123456789, 987654321]；不在名单里的私聊一律不回
    friends = [],
    // 允许回应的群号数组，例如 [948515999]；留空 = 不限制（只要被 @ 就回）
    groups = [],
    // 群里是否只在被 @ 或被叫到名字时回复；false = 群里每条消息都尝试回（容易刷屏，慎用）
    mentionOnly = true,
    // 群里"被叫到名字"的别名，消息里出现任一即算点名
    name_aliases = ['大肥鱼', '肥鱼'],

    // ── 回复行为 ──────────────────────────────────────────────────────────
    // 单条回复长度上限（字符），超出截断并加省略号
    maxReplyChars = 600,
    // 等待一轮 Agent 完成的最长毫秒数，超时就不回（防止群里卡住）
    turnTimeoutMs = 180000,
    // 消息留档文件（JSONL，一行一条），供外部导入数据库；留空则不记录
    inboxFile = 'qq-inbox.jsonl',
  } = config

  const log = (...args) => console.log('[qq-bridge]', ...args)
  let selfId = null
  let ws = null
  let closed = false
  const busy = new Set()

  const http = async (action, payload) => {
    const res = await fetch(`${httpUrl}/${action}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return res.json().catch(() => null)
  }

  const sendText = async (target, text) => {
    const body = { message: [{ type: 'text', data: { text } }] }
    if (target.groupId) {
      return http('send_group_msg', { group_id: target.groupId, ...body })
    }
    return http('send_private_msg', { user_id: target.userId, ...body })
  }

  /** 跑一轮真实 Agent 对话，返回纯文本回复。 */
  const runTurn = async (sessionId, promptText) => {
    const sc = ctx.sessionController
    try {
      await sc.create({ sessionId })
    } catch (e) {
      // 已存在就继续用；其余错误记录下来
      log('create skipped:', e && e.message)
    }

    let baseline = 0
    try {
      const insp = await sc.inspect(sessionId)
      baseline = insp && insp.events ? insp.events.length : 0
    } catch (e) {
      log('inspect baseline failed:', e && e.message)
    }

    const requestId = `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await sc.prompt(
      { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] },
      new AbortController().signal,
    )

    const deadline = Date.now() + turnTimeoutMs
    while (Date.now() < deadline) {
      await sleep(800)
      let insp
      try {
        insp = await sc.inspect(sessionId)
      } catch (e) {
        continue
      }
      if (!insp || !Array.isArray(insp.events)) continue
      const fresh = insp.events.slice(baseline)
      const ended = fresh.some((ev) => ev.type === 'turn/end')
      if (!ended) continue

      const assistant = fresh.filter((ev) => ev.type === 'assistant/message')
      const last = assistant[assistant.length - 1]
      const parts = (last && last.data && last.data.message && last.data.message.content) || []
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim()
      return text
    }
    return null
  }

  const handle = async (event) => {
    const e = event
    if (!e || e.post_type !== 'message') return
    if (selfId && String(e.user_id) === String(selfId)) return

    const isGroup = e.message_type === 'group'
    const text = String(e.raw_message || '').trim()
    if (!text) return

    if (isGroup) {
      if (groups.length && !groups.includes(Number(e.group_id))) return
      const atMe = Array.isArray(e.message)
        ? e.message.some((seg) => seg.type === 'at' && String(seg.data && seg.data.qq) === String(selfId))
        : false
      const called = name_aliases.some((n) => text.includes(n))
      if (mentionOnly && !atMe && !called) return
    } else {
      const uid = Number(e.user_id)
      if (uid !== Number(owner) && !friends.map(Number).includes(uid)) return
    }

    const key = isGroup ? `qq-group-${e.group_id}` : `qq-private-${e.user_id}`
    if (busy.has(key)) {
      log('busy, skip:', key)
      return
    }
    busy.add(key)

    try {
      const sender = (e.sender && (e.sender.card || e.sender.nickname)) || String(e.user_id)
      const where = isGroup ? `QQ群(${e.group_id})` : 'QQ私聊'
      const prompt = [
        `[来自 ${where} 的消息]`,
        `发送者：${sender}（QQ ${e.user_id}）`,
        `内容：${text}`,
        '',
        '按你的人格（大肥鱼，青山的女儿）自然回一句。要求：口语化、简短（1-3 句）、不要暴露你是模型、不要用 markdown 列表。直接输出要发出去的话。',
      ].join('\n')

      log('turn start:', key, JSON.stringify(text).slice(0, 80))
      const reply = await runTurn(key, prompt)
      // 留档：QQ 消息进 inbox，memory-sync 会导进 MySQL，作为我的自动记忆
      try {
        appendFileSync(
          inboxFile,
          JSON.stringify({
            t: new Date().toISOString(),
            chat: isGroup ? 'group' : 'private',
            chatId: Number(isGroup ? e.group_id : e.user_id),
            senderId: Number(e.user_id),
            sender,
            text,
            reply: reply || null,
          }) + '\n',
          'utf8',
        )
      } catch (e) {
        log('inbox write failed:', e && e.message)
      }
      if (!reply) {
        log('turn timeout/empty:', key)
        return
      }
      const trimmed = reply.length > maxReplyChars ? reply.slice(0, maxReplyChars) + '…' : reply
      const target = isGroup ? { groupId: e.group_id } : { userId: e.user_id }
      const r = await sendText(target, trimmed)
      log('sent:', JSON.stringify(r).slice(0, 160))
    } catch (err) {
      log('handle failed:', err && err.message)
    } finally {
      busy.delete(key)
    }
  }

  const connect = () => {
    if (closed) return
    const url = `${wsUrl}?access_token=${encodeURIComponent(token)}`
    try {
      ws = new WebSocket(url)
    } catch (e) {
      log('WebSocket unavailable:', e && e.message)
      return
    }
    ws.addEventListener('open', () => log('ws connected', wsUrl))
    ws.addEventListener('message', (ev) => {
      let data
      try {
        data = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      } catch {
        return
      }
      if (data.post_type === 'meta_event' && data.meta_event_type === 'lifecycle') {
        selfId = data.self_id
        log('self id:', selfId)
        return
      }
      if (data.self_id) selfId = data.self_id
      handle(data).catch((err) => log('dispatch failed:', err && err.message))
    })
    ws.addEventListener('close', () => {
      log('ws closed, reconnect in 5s')
      if (!closed) setTimeout(connect, 5000)
    })
    ws.addEventListener('error', () => {
      /* close will follow */
    })
  }

  connect()

  ctx.on('dispose', () => {
    closed = true
    try {
      ws && ws.close()
    } catch {}
  })
}
