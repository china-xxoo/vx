# VX Cloudflare 后端

这套后端替代 Gist 和 MQTT：

- Worker：账号、房间、接口鉴权
- D1：账号、房间、成员、文字聊天记录
- Durable Objects + WebSocket：房间实时消息秒到

## 部署步骤

1. 安装并登录 Wrangler。

```bash
npm i -g wrangler
wrangler login
```

2. 创建 D1 数据库。

```bash
wrangler d1 create vx_chat
```

把输出里的 `database_id` 填入 `wrangler.toml`。

3. 初始化表结构。

```bash
wrangler d1 execute vx_chat --file=./schema.sql
```

4. 生成 Web Push 参数。

```bash
node generate-vapid-keys.mjs
```

会输出三行：

- `VAPID_PUBLIC_KEY`：填到前端配置生成器
- `VAPID_PRIVATE_JWK`：设置为 Worker Secret
- `PUSH_SECRET`：Worker 和前端配置生成器都要填写同一个值

5. 设置管理员密码和通知密钥。

```bash
wrangler secret put ADMIN_PASSWORD
wrangler secret put VAPID_PRIVATE_JWK
wrangler secret put PUSH_SECRET
wrangler secret put VAPID_SUBJECT
```

`VAPID_SUBJECT` 可以填 `mailto:你的邮箱`。

6. 部署 Worker。

```bash
wrangler deploy
```

7. 用部署后的 Worker 地址更新前端 `vx-config.json`。

打开前端目录里的 `encrypt-config.html`，填写 Worker API 地址，例如：

```text
https://vx-chat-worker.your-name.workers.dev
```

如果只是使用 Web Push，不需要切换当前 MQTT/Gist 聊天流程，只需要填写：

- 系统通知 Worker 地址
- 系统通知 VAPID 公钥
- 系统通知密钥

生成新的 `vx-config.json` 后上传。
