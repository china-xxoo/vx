# VX Cloudflare Ready

这个目录已经切换为 Cloudflare 版本：

- 不再使用 Gist 保存数据
- 不再使用 MQTT 做实时消息
- 前端通过 Cloudflare Worker 调接口
- 房间消息通过 Durable Objects WebSocket 秒到
- 账号、房间、文字聊天记录保存在 D1

## 文件结构

- `index.html`：主入口，只直接加载计算器首屏。
- `assets/css/calc.css` / `assets/js/calc.js`：计算器和解锁逻辑。
- `assets/css/app.css` / `assets/js/app.js`：Cloudflare API + WebSocket 版本主程序。
- `cloudflare-worker/`：Worker、D1 表结构、Wrangler 配置。
- `vx-config.json`：加密配置，需要用新的 Worker 地址重新生成。
- `encrypt-config.html`：配置生成器，只填写 Cloudflare Worker API 地址。
- `manifest.webmanifest` / `service-worker.js`：PWA 配置和缓存。
- `vx-logo-180.png` / `vx-logo-512.png`：应用图标。

## 部署顺序

1. 先部署 `cloudflare-worker/`。
2. 拿到 Worker 地址后，打开 `encrypt-config.html`。
3. 输入暗语和 Worker 地址，生成新的 `vx-config.json`。
4. 上传整个前端目录到 GitHub Pages。

## 重要说明

这是直接替换架构的版本。旧 Gist 里的房间和聊天记录不会自动迁移到 D1；如果需要迁移，需要另外写一次性迁移脚本。
