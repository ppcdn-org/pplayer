# PPCDN 网页推流自测指引

浏览器直接推流（`getUserMedia` → WHIP），无需 ppobs、不接触 appSecret。
设计与接口见 `docs/design/ppcdn-web-publish-design.zh-CN.md`（ppcdn 仓库）。

## 发布页地址

| 方式 | 地址 | 说明 |
| --- | --- | --- |
| 控制台入口（推荐） | `https://pp-cdn.org` → 登录 → **网页推流** tab → **打开网页推流** | 弹窗自动带入登录态，无需粘贴 Token |
| 独立打开 | `https://pplayer.pp-cdn.org/publish.html` | 需手动粘贴用户 Token |

## 前置

- 账号：demo `ppcdn.org@gmail.com` / `Demo123@pp-cdn.org`，或你自己的账号。
- appId：demo `appbd4cd2aa7be8`，或你自己的 app。
- 已就绪（线上已确认）：ppcenter `whipAuth.authKey` 已配置；Origin mmx 的 `webrtcAllowOrigins` 放行 `https://pplayer.pp-cdn.org`。

## 用控制台（推荐）

1. 登录 `https://pp-cdn.org`。
2. 打开 **网页推流** tab → **打开网页推流**，允许浏览器使用摄像头/麦克风。
3. 填 `streamName`（`[A-Za-z0-9._-]`，≤128 字符）；`appId` 已按控制台所选 App 自动预填（可在控制台上方下拉切换）。
4. 按需勾选：**Simulcast**、**注入 SEI 时延戳**、**启用 P2P 直连**、**仅音频**；编码保持「自动（优先 H264）」。
5. 点 **开始推流**；本地预览出现即已发布。
6. 观看：
   - 另开 `https://pplayer.pp-cdn.org/`，在 **Stream** 输入框填 `{appId}/{streamName}` 或 `{appId}/{streamName}/h264`，Start；
   - 或控制台 **推流** tab 里对该流点 **Preview**。
7. 回 **网页推流** tab 点 **刷新**，应看到该会话（流路径 / 编码 / Origin 节点 / 到期时间）。
8. 结束：发布页点 **停止**。

## 独立打开（不经过控制台）

1. 取用户 Token（JWT）：
   - 控制台 DevTools → Application → Local Storage → `ppcdn_console_token`；或
   - `curl -sX POST https://api.pp-cdn.org/v1/auth/login -H "Content-Type: application/json" -d '{"email":"...","password":"..."}'` → `data.token`。
2. 打开 `https://pplayer.pp-cdn.org/publish.html`，把 Token 粘到 **用户 Token**，填 `appId`/`streamName`，开始推流。

## 验证点

- 发布页状态依次：`requesting-session → capturing → publishing → live`。
- 控制台 **网页推流** tab 出现该会话；停止后消失。
- pplayer 能拉到并播放；H264 流可尝试 P2P，HEVC/兜底走 Edge。
- 勾选 **注入 SEI 时延戳** 后，pplayer 面板 P2P Delay 为实测值（需 Chromium）。
- 控制台 **拉流统计** 出现该观看会话。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `401 not_authenticated` | Token 缺失/过期 → 重新登录 |
| `401 invalid_credentials`（probe/接口） | appId 不存在或 Token 与账号不符 |
| `403 app_forbidden` | appId 不属于当前账号 |
| `402 account_in_arrears` | 账号欠费 |
| `409 stream_in_use` | 已不再出现：同一 `{appId}/{streamName}` 再次推流会**自动顶替**上一个会话（appId 全局唯一，旧会话只可能是自己的残留）。若仍见到，说明服务端早于 v1.0.72 |
| `429 too_many_publish_sessions` | 同账号并发超过 `browserPublish.maxSessionsPerUser`（默认 2） |
| `503 browser_publish_unavailable` | 服务端 `browserPublish.disabled=true` |
| 开始后 pplayer 404/黑屏 | Origin 尚在收到该流，等 1–2s 重试；确认 Origin 已放行 pplayer 跨域 |
| P2P 不生效 | 需 H264 + 双方 NAT 可穿透 + 有 publisher 空闲槽；对称 NAT/CGNAT 会回退 Edge |

## 已知限制

- **SEI 时延注入**依赖 Insertable Streams，仅 Chromium；其他浏览器只能靠 RTP/缓冲估算。
- **VP8** 仅作 H264 编码不可用时的兜底：能播，但无 ABR / P2P / SEI 时延。
- **P2P** 为重协商直连，真实网络覆盖仍需进一步验收。
- 发布页独立打开时 Token 需手动提供（控制台入口已自动带入，Token 经 `postMessage` 传递、不经 URL）。

## 相关接口（ppcenter）

```
POST   /v1/publish/browser-requests               # 创建会话（Authorization: Bearer <用户JWT>）
GET    /v1/publish/browser-requests               # 列出当前用户活跃会话
POST   /v1/publish/browser-requests/{id}/refresh  # 续签（返回新 WHIP token）
DELETE /v1/publish/browser-requests/{id}          # 停止
POST   /v1/publish/browser-probe                  # 浏览器发布端 NAT 探测（P2P 需要）
```
