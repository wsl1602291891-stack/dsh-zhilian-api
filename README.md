# 智连API（dsh-zhilian-api）

在 DSH 设置里新增「智连API」页：一键授权 `api.888425.xyz` 账号，按分组创建/复用专用 Key，并把模型按协议家族注册成 DSH 提供方路由。

## 它做什么

| 能力 | 实现 |
|---|---|
| 一键授权 | 浏览器打开本站 `/dsh/` 授权页 → 读取本站 HttpOnly refresh cookie → 跳回插件自带的 127.0.0.1 随机端口 hand-off 页 → access token 交给主机（仅内存） |
| 分组 Key | 每个分组一把 `DSH 桌面 / DeepSeek Harness` 令牌；同名同组复用，模型范围变了 `PUT` 整份覆盖（回填 expired_time / remain_quota 等） |
| 协议路由 | 按模型名分族：`gpt/o*/chatgpt/codex` → `openai-responses`；`claude/anthropic` → `anthropic-messages`；其余 → `openai-completions` |
| 模型目录 | 读 `/api/pricing`，过滤生图/视频/音频模型与非文本端点，按账户可用分组切分 |
| 余额与用量 | `/api/user/self` 账户余额；`/api/usage/token/` 每把 Key 的可用/已用 |
| 功能入口 | 页底直达充值、模型广场、生图画布、视频、音频、画布、动效、试衣间、写作、主站 |

## 安全边界

- access token 只存在主机内存，不落盘；DSH 重启后需要重新授权才能「新建/更新 Key」，已写入的 Key 与模型路由继续可用。
- API Key 存进 DSH 凭据平面（`ctx.credentials`），地址是 `DSH_NEWAPI_G1` 这类稳定引用；设置文件只记录引用名。
- 主机路由只接受本机回环请求；授权回调另起一个只绑 127.0.0.1 的随机端口监听，不依赖桌面壳的 `file://` 原点和 DSH web 模式的鉴权；`/open` 只允许打开 `https://api.888425.xyz`。
- 授权 URL 只带 `state` 与 `port`，绝不把回调 URL 放进查询参数——宝塔 WAF 会把 URL-in-URL 判为攻击并返回 403；回调地址由站点授权页自己拼。
- 授权 state 一次性、10 分钟过期；hand-off 页 CSP 只允许内联脚本与同源 fetch。

## 安装（本地插件）

1. 目录已在 `~/.dsh/local-plugins/dsh-zhilian-api`。
2. 在 `~/.dsh/profiles/desktop/node_modules/` 建符号链接：
   `mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-zhilian-api" "%USERPROFILE%\.dsh\local-plugins\dsh-zhilian-api"`
3. 在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里加入 `"dsh-zhilian-api"`。
4. 重启 DSH，设置 → 智连API。

## 站点侧依赖

`https://api.888425.xyz/dsh/` 授权页（静态，`/www/wwwroot/api.888425.xyz/dsh/index.html`）与 nginx `location ^~ /dsh/` 块。没有这页，「一键授权」无法拿到本站会话。

## 回滚

- 插件：从 `bundles` 移除 `dsh-zhilian-api`，删符号链接，重启 DSH；设置页与路由消失，已建 Key 仍在本站令牌列表里可手动删除。
- 站点：删 `/www/wwwroot/api.888425.xyz/dsh/` 与 vhost 的 `DSH AUTHORIZE` 块，`nginx -t && systemctl reload nginx`。

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。
