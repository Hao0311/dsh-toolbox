# dsh-toolbox

DSH Web GUI 里的工具箱：左侧导航（手机上在抽屉里）多一行「工具箱」，点开是一个右侧抽屉
（手机端全屏，可随时退出、任务在后台继续）。

桌面端打开抽屉时**主页面自动往左让位**：面板多宽，主内容就让出多宽，不会压住聊天；
窗口较窄（让位后主内容不足约 640px）时会顺手把左侧导航收成图标轨，关面板后自动恢复。
面板宽度随窗口自适应：424px ~ 340px。

## 功能

| 功能区 | 做什么 |
|---|---|
| 连接状态 | 打开面板自动刷新：局域网 / 本机回环 / Tailscale / 外网、客户端 IP、本机地址、公网出口、Wi-Fi 频段·信道·速率·信号 |
| 一键体检 | 打面板自动跑一次**轻量**检查（约 1~2 秒，只发小请求）；点按钮跑**完整**体检（含网关 ping、DNS、公网出口），给「良好 / 一般 / 较差」结论和建议 |
| 测速 | 快速 20MB / 标准 100MB / 极限 500MB / 持续 30 秒 / 自定义（下载、上传、时长自选）。服务端计时、4 并发流、实时曲线；关掉面板继续跑 |
| 质量监控 | 30 秒 / 1 分钟 / 3 分钟低流量采样（每 0.3 秒一个小请求），给延迟曲线、丢包和卡顿尖峰——查「卡」而不是查带宽 |
| 历史记录 | 体检 / 测速 / 监控自动存本机（localStorage，最近 40 条），测速结果和上一次对比 |
| 自动巡检 | 页面开着时每 3/5/10 分钟做 3 次轻探测；网络变差时导航入口亮红点，并在面板里提示 |
| 分享 / 报告 | 生成一段中文总结（连接方式、体检结论、测速、监控、建议），一键复制发人 |

## 实现

- **宿主端** `index.js`：`ctx.connection.fetch.register` 注册 `/api/toolbox/net/*`
  路由（下载流 / 上传流 / 信息 / 诊断 / 服务端计时 / 状态），并通过官方
  `webserver/index-inject` 把 `client.css`、`client.js` 内联进 `index.html`。
  宿主只在**启动时**读一次本文件；CSS / JS 是每次页面加载现读，所以改界面不用重启。
- **客户端** `client.js`：纯 DOM 注入，不依赖 React、不改 DSH 布局。
  测量引擎与面板解耦：关掉面板任务照跑，重新打开能看到实时状态；
  入口行的小圆点 / 顶部 2px 进度线表示后台任务。
- **鉴权**：路由都挂在 `/api` 下，走 connection 层统一的 Host/Origin + cookie 校验。

## 测速原理

| 项目 | 做法 |
|---|---|
| 下载 | `GET /api/toolbox/net/download?mb=N` 流式返回 N×1MiB 随机数据，客户端流式读取计数；数字以**服务端计时**为准 |
| 上传 | `POST /api/toolbox/net/upload`，浏览器发随机 Blob，服务端边收边计数，返回首字节→末字节耗时 |
| 延迟 / 抖动 / 丢包 | 连续小请求 `/api/toolbox/net/info`，超时算丢包 |

> 电脑本机上打开会走回环，数字会虚高到 GB/s 级别，面板会标「本机回环」提醒。

## 安装 / 更新

```sh
dsh plugin --profile web add github:Hao0311/dsh-toolbox
```

> npm 上有 ldchao 的同名包 `dsh-toolbox`（股票盯盘 + 小说阅读器，不是本插件），
> `dsh plugin add dsh-toolbox` 会装错，务必用上面的 `github:` 来源。

开发时用本目录的同步脚本：把本目录同步到 `~/.dsh/profiles/web/node_modules/dsh-toolbox/`，
并在 `cordis.patch.yml` 的标记块里加入 `insert:` 条目（幂等，重复跑不会重复写）。

```powershell
powershell -NoProfile -File D:\Workspaces\DSH\plugins\dsh-toolbox\install.ps1
```

- **只改 `client.js` / `client.css`**：跑 install.ps1 后浏览器刷新即可，**不用重启 DSH**。
- **改了 `index.js`**：需要重启 DSH（插件只在启动时装载）：
  `powershell -NoProfile -File D:\Workspaces\DSH\tools\dsh\dsh-restart.ps1`

> 注意：用 PowerShell 5.1 读写本目录的中文文件时别用 `Get-Content`/`Set-Content` 改内容
> （默认按 ANSI 读会把 UTF-8 中文写坏）；改文件用编辑器或 Node 脚本。

## 加新工具

```js
window.DSHToolbox.register({
  id: 'my-tool',          // 唯一
  title: '我的工具',
  hint: '一句话说明',      // 可选
  render(container) {     // 自己画 UI，container 是一个普通 DOM 节点
    container.textContent = 'hello';
  },
});
```

注册顺序即面板底部「更多工具」里的显示顺序。

## 自检

- 页面源码里搜 `__DSH_TOOLBOX__`（宿主注入的 global，报告注入行数与路由状态）。
- 直接请求 `/api/toolbox/net/info`，应返回 `{ ok: true, ip, host, ... }`。
- 本地验证脚本：`.cdp-verify/cdp-toolbox.js`（桌面/手机截图）、
  `.cdp-verify/cdp-toolbox-func.js`（点按钮、跑体检/测速/监控、验证后台继续）。

---

## English

`dsh-toolbox` adds a toolbox panel to the DeepSeek Harness Web GUI: a right-side drawer
(full-screen on phones) showing connection information, one-click diagnostics, a speed
test, a quality monitor, history and auto patrol. The host half registers the
`/api/toolbox` routes and injects `client.js` / `client.css` into the page through the
official `webserver/index-inject` hook, so no client build step is needed.

Install:

```sh
dsh plugin --profile web add github:Hao0311/dsh-toolbox
```

The plugin is web-only; without the `connection` service it stays inactive.