# dsh-qq-bridge

把 QQ（NapCat / OneBot 11）接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：收到 QQ 消息 → 起一轮真实 Agent 对话 → 把回复发回 QQ。

不是转发机器人：回复由 DSH 里的**同一个 Agent**产生，带人格（`SOUL.md`）、记忆和工具。

## 它做什么

```
NapCat 正向 WS :3001 ──事件──▶ dsh-qq-bridge ──prompt──▶ ctx.sessionController
                                                        （真实 Agent，带工具/记忆）
NapCat HTTP :3000 ◀──发送── dsh-qq-bridge ◀──inspect── 会话日志里的 assistant 文本
```

## 配置

```yaml
- insert:
    - id: qq-bridge
      name: dsh-qq-bridge
      config:
        httpUrl: http://127.0.0.1:3000   # NapCat OneBot HTTP
        wsUrl: ws://127.0.0.1:3001       # NapCat 正向 WebSocket
        token: your-onebot-token
        owner: 10001                     # 主人 QQ：私聊全回
        friends: [10002]                 # 额外允许私聊的 QQ
        groups: []                       # 允许的群；空数组=不限制
        mentionOnly: true                # 群里只在 @ 或被叫名字时回
        name_aliases: ['大肥鱼', '肥鱼']   # 群里触发用的名字
        maxReplyChars: 600
        turnTimeoutMs: 180000
        inboxFile: ./qq-inbox.jsonl      # 消息留档（可选，配合外部导入）
```

## 权限模型

| 场景 | 默认行为 |
|---|---|
| 主人私聊 | 回 |
| `friends` 里的私聊 | 回 |
| 其他私聊 | **不回** |
| 群聊 | 仅 `@` 或消息含 `name_aliases` 时回 |
| 自己的消息 | 忽略 |

## 依赖

- NapCat（或任意 OneBot v11 实现），需开 HTTP + 正向 WebSocket
- DSH 0.2.x，插件注入 `sessionController`

## 已知限制

- 每个会话是 `qq-private-<uin>` / `qq-group-<gid>` 的持久 Session，历史会累积，靠 DSH 的压缩策略兜底
- 同一会话同时来消息会排队（插件内部 `busy` 集合）
- 一次回复只取最后一轮 assistant 文本，不分段流式发送

## License

MIT
