# P0 实现与验证记录

> 历史记录：保留当时的版本、环境和结果。当前使用与开发入口见[文档目录](README.md)。

日期：2026-09-20。版本：`0.1.0-alpha.1`。这是安装与扩展接口的技术预览，未证明小说质量提升。

## 已实现

- bundle 仅插入 `dsh-super-novel`，不替换宿主的预设配置。
- 显式启用包内固定预设，版本/哈希归属、排他锁、同名保护、缺文件续装；异常保留现场。升级不自动覆盖旧版本。
- Agent 作用域写作提示词；没有全局写作工具，没有模型调用或正文存储。
- 中英文侧栏、启用/刷新/失败状态、取消生命周期；通过宿主 Remote 与 Sidebar 公共接口装配。
- Host TypeScript、官方 Typert 生成、Client classic module closure、npm tarball。

## 本机证据

环境：macOS arm64，Node.js `24.18.1`；Harness `0.1.5-rc.2` / `c291e7961a`；Playwright `1.61.1` + Chromium headless shell。

| 检查 | 结果与范围 |
| --- | --- |
| `npm run typecheck` / `npm run build` | 通过，Host 类型检查、生成严格 RPC codec 和浏览器包 |
| `npm test` | 10 项通过：真实 Loader / Agent mount、提示词作用域、两个 patch 顺序、只读查看、幂等/并发/锁、同名和用户编辑保护、缺文件恢复、直接符号链接、取消、权限失败、`~/` 与相对路径 |
| 干净依赖构建 | 在独立暂存目录 `npm ci --ignore-scripts --legacy-peer-deps`，使用 npm 生成器包并链接已构建 Harness 后 build 通过；lockfile 不含本机路径 |
| 打包安装 | `npm pack --dry-run --json`、`npm pack --json` 通过，tarball 解包到全新隔离 profile；`prepare-preview.ts` / 实际 CLI Web Loader 成功装配，首次启用成功 |
| super-code 实际组合 | 两种 bundle 顺序均在真实 Web Host 启动，roster 同时包含六个可用模式；默认值保持 `super-code`，小说生成模式重启后仍就绪。未执行 super-code 的模型任务 |
| 真实浏览器 | 首次启用成功、刷新、关闭重开、切换两个会话、中英文和明暗切换；900px 全屏视口检查、原生模式选择通过；无 pageerror，具体布局限制见下文 |

初次真实 Web 验证发现动态 `remote.superNovel` 服务未声明注入，修复为先 `$mount`，再在子注入作用域注册侧栏。浏览器测试同时验证真正的 RemoteResult 解包，未用假 RPC 替代。

测试 profile 的会话由 `preview-fixture.ts` 通过宿主 API 建立，并写入固定的空 turn 起止事件使会话可见；没有提交用户 prompt，没有调用模型。测试数据在 `.test-output/`，构建暂存在 `.build/`，均被 Git 忽略。普通 Harness profile 与参考仓库未修改。共存检查在该隔离 profile 增加指向已有 `dsh-super-code` 的链接，并分别交换两个 bundle 的顺序；`preview-fixture.ts` 对默认值与预设可用性作实际断言，输出 `.test-output/profile-check.json`。

## 重现浏览器验证

先按[开发说明](development.md)构建，再运行：

```sh
node --experimental-strip-types scripts/prepare-preview.ts
node --experimental-strip-types scripts/serve-preview.ts
```

前者只创建不存在的 `.test-output/web-home`，遇已存在目录拒绝覆盖。后者启动任务自己的进程，将临时认证 URL 写入权限 `0600` 的 `.test-output/preview-url`，不输出 URL。另开终端执行：

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node --experimental-strip-types scripts/browser-smoke.ts
```

使用已安装的 Playwright 和 Chromium；当前脚本不负责下载浏览器。截图生成于 `.test-output/screenshots/`。结束后在预览进程终端按 Ctrl+C，仅终止该任务启动的进程。不要复制认证 URL 到日志或文档。`DSH_HOME` 和 `DSH_AGENTS_HOME` 已由脚本指向测试目录。

## 边界与待验证项

- 900px 窗口同时展开左右侧栏时，宿主仍保留桌面列宽，内容可能超出视口；使用右侧栏全屏。不宣称手机布局已支持，P1 继续处理实际工作台布局。
- 没有真实模型评测、Desktop 运行验证、Windows/Linux 验证或插件热卸载泄漏检查。
- 同名旧版本采取显式冲突策略，不提供自动迁移。锁协调本插件实例，非恶意文件系统并发防护；断电、磁盘空间耗尽等中断场景尚未逐点故障注入。
- 缺 peer 依赖及宿主版本不匹配主要依赖包管理器诊断，尚未覆盖全部失败组合。
- 文学流程、持久化、事实、审校和修订仍按 P1–P5 实施。dsh-market 结构已准备，账号、许可证及公开发布在 P6 落实。

## 实际界面

[英文侧栏](screenshots/p0-en-light.png) · [中文暗色全屏](screenshots/p0-zh-dark-fullscreen.png)。均来自上述真实 Web profile，属于 P0 技术预览，不是四页签完整工作台的效果图。
