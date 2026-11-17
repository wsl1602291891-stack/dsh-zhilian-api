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

## 获取与安装

**从插件市场**：DSH 插件 → 发现 → 搜索「智连API」或 `dsh-zhilian-api`，一键安装。

**从源码（本地插件）**：

1. 把仓库放到 `~/.dsh/local-plugins/dsh-zhilian-api`。
2. 在 `~/.dsh/profiles/<profile>/node_modules/` 建符号链接：
   `mklink /J "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-zhilian-api" "%USERPROFILE%\.dsh\local-plugins\dsh-zhilian-api"`
3. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加入本插件的 bundle 行（内容同本目录的 `cordis.patch.yml`）：
   ```yaml
   - insert:
       - id: zhilian-api
         name: dsh-zhilian-api
   ```
4. 重启 DSH，设置 → 智连API。

## 使用前提

本插件面向 **智连API（api.888425.xyz）**：一键授权依赖该站提供的 `/dsh/` 授权页。换成其他 NewAPI 站点时，需要该站同样提供授权页，并修改 `index.js` 顶部的 `SITE` 常量；没有授权页时无法完成一键授权。

## 安全边界

- access token 只存在主机内存，不落盘；DSH 重启后需要重新授权才能「新建/更新 Key」，已写入的 Key 与模型路由继续可用。
- API Key 存进 DSH 凭据平面（`ctx.credentials`），地址是 `DSH_NEWAPI_G1` 这类稳定引用；设置文件只记录引用名。
- 主机路由只接受本机回环请求；授权回调另起一个只绑 127.0.0.1 的随机端口监听，不依赖桌面壳的 `file://` 原点和 DSH web 模式的鉴权；`/open` 只允许打开 `https://api.888425.xyz`。
- 授权 URL 只带 `state` 与 `port`，绝不把回调 URL 放进查询参数——宝塔 WAF 会把 URL-in-URL 判为攻击并返回 403；回调地址由站点授权页自己拼。
- 授权 state 一次性、10 分钟过期；设置页只查询自己那次 state 的结果，内存里残留的旧会话不会让「重新授权」提前完成；hand-off 页 CSP 只允许内联脚本与同源 fetch，读到 token 后立即把它从地址栏和历史记录里清掉。
- 创建的专用 Key 是不限额度（`unlimited_quota`）并绑定分组与模型范围，按账户余额扣费。Key 泄露即等于账户余额可被消耗，所以只存在 DSH 凭据平面，不要复制到别处；怀疑泄露就在本站令牌列表里删掉对应令牌，再回设置页重新接入。
- 「接入所选分组」只在至少一个分组接入成功后，才会删除本次没选的旧分组（远端令牌、本地 Key、路由）；全部失败时不动任何已有内容。
- 重复接入时，已有模型保留你在模型页改过的设置（图片输入、思考强度等），只有新上架的模型套用默认值。

## 站点侧依赖

一键授权需要本站提供 `/dsh/` 授权页（由站点运营方部署）。没有这页，只能在本站令牌列表里手动建 Key 后自行配置路由，「一键授权」不可用。

## 回滚

- 从插件市场卸载，或从 `cordis.patch.yml` 移除 `zhilian-api` 行，重启 DSH；设置页与路由消失，已建 Key 仍在本站令牌列表里可手动删除。

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。
