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

4. 设置管理员密码。

```bash
wrangler secret put ADMIN_PASSWORD
```

5. 部署 Worker。

```bash
wrangler deploy
```

6. 用部署后的 Worker 地址更新前端 `vx-config.json`。

打开前端目录里的 `encrypt-config.html`，填写 Worker API 地址，例如：

```text
https://vx-chat-worker.your-name.workers.dev
```

生成新的 `vx-config.json` 后上传。
