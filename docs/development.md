# 开发说明

## 环境

需要 Node.js `^22.19.0 || >=24.0.0`，以及相邻目录已构建的 `deepseek-harness`。当前宿主基线为 `0.1.5-rc.2`，历史运行验证使用提交 `c291e7961a`。组合测试还会读取相邻 `dsh-super-code` 的 patch。

```text
dsh-plugin/
  deepseek-harness/
  dsh-super-code/
  dsh-super-novel/
```

在 `dsh-super-novel` 中执行：

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run dev:link-harness
npm run typecheck
npm run build
npm test
npm run pack:check
```

链接脚本只在本项目 `node_modules` 中添加缺失链接。重新安装依赖后，需要再次运行。类型检查与生成器沿用 `0.1.5-rc.2` 基线；运行依赖支持 `^0.1.5-rc.2 || ^0.2.0-rc.2`。新旧预设包为可选替代项，宿主须提供其中一种，所有 peer 必须复用宿主实例。

## 检查范围

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 检查 Host TypeScript 类型 |
| `npm run build` | 编译 Host、浏览器代码及官方 Typert/Remote 产物 |
| `npm test` | 检查作品保存/恢复、候选采纳/取消/冲突、模型路由、权限、预设与组合加载 |
| `npm run doctor` | 只读检查 Node、编译文件和已解析 peer 版本 |
| `npm run pack:check` | 构建，检查实际包清单、exports、截图及禁止文件 |
| `npm pack` | 构建并生成可安装 tarball |

作品界面的隔离浏览器验证：

```sh
node --experimental-strip-types scripts/prepare-preview.ts .test-output/preview-v003
node --experimental-strip-types scripts/serve-preview.ts .test-output/preview-v003
```

准备脚本拒绝覆盖已有目录。等服务显示就绪，再使用已安装的 Playwright 路径运行 `scripts/browser-books.ts`，先验证创建和保存，再重启预览服务，以 `reopen` 参数验证磁盘恢复。共享导航会脱敏失败消息中的临时认证参数。运行方法与临时认证 URL 的处理见 [P0 技术验证](P0-VALIDATION.md#重现浏览器验证)；现用 URL 位于隔离预览目录。只终止本次启动的进程。

固定响应候选界面的隔离验证：

```sh
node --experimental-strip-types scripts/prepare-preview.ts .test-output/preview-v004 --generation
node --experimental-strip-types scripts/serve-preview.ts .test-output/preview-v004
```

使用已安装的 Playwright 路径运行 `scripts/browser-proposals.ts`，重启后用 `reopen` 参数复验。`--generation` 仅为隔离 profile 注册固定响应适配器，不联系 provider；同一 profile 的浏览器检查要串行。真实模型测试会产生调用费用，方法和历史结果见[评测说明](evaluation.md)。固定响应不能证明文学质量或跨平台兼容。

历史与冲突界面使用新 profile，运行 `scripts/browser-history.ts`，重启后附加 `reopen` 参数。它核对历史恢复、保留两稿、手工合并和中断后第三种正文的显式恢复。阶段错误通过注入模拟，不能作为实际磁盘满或断电验收。

资料与规划用 `scripts/browser-materials.ts` 检查新建场景、规划候选采纳、选择资料起草和重启。同样使用 `--generation` 的全新隔离 profile，不调用真实 provider。

资料页直接生成用 `scripts/browser-material-generation.ts`，覆盖七类资料、默认名称与要求、资料和正文来源、采纳/拒绝、创建后失败重试、停止、切书隔离。停服重开后附加 `reopen`，确认资料和未完成候选保留，查询不调用模型。

侧栏适配用 `scripts/browser-sidebar.ts`，覆盖七类混合资料、类型/关联章节/名称筛选、100 项分页、目录折叠、300/420px 拖动侧栏和 900px 全屏。它同时检查切页和缩放保留草稿、候选与采纳结果，以及 ⌘/Ctrl+S 保存；停服重启后附加 `reopen`，确认查询不会重新生成。共享辅助函数通过可见入口打开新建、AI 设置和文档选项，等待固定响应夹具就绪后才测试。该浏览器命令使用 Chromium，只验证 Web；桌面原生协议的实测范围见[评测说明](evaluation.md)。

事实工作流用 `scripts/browser-facts.ts` 验证提取、采纳、引用定位、下一章上下文及旧章变化后过期。固定响应只能证明流程，事实含义与连续写作质量仍需真实模型和人工评阅。

审校工作流用 `scripts/browser-reviews.ts` 验证占位检查、定位、局部修订、复核、采纳和重启。单测覆盖无效引用、损坏记录、输入预算和两轮上限；固定响应不能证明审校准确率或修订质量。

## 打包与发布

工作台用 `scripts/browser-voices.ts` 验证导入预览、授权样本、撤销后候选过期和导出回读。`scripts/browser-directory.ts` 验证 1000 章分页、搜索和长正文；本机结果不代表其他平台性能。

完整链路用 `scripts/browser-workflow.ts`，先运行默认 workflow，停服重开后附加 `reopen`。它检查规划采纳、章纲起草、候选审校、局部修订、复核采纳、事实回填、下一章、停止和纯查询。所有模型响应固定，真实作者声音与质量仍未验证。

共存检查使用 `scripts/prepare-coexist.ts`，需要本地已有 super-code 安装包，分别测试 first/last 两种顺序；浏览器工作流附加 `--coexist`。隔离 profile 固定英文，与浏览器初始语言一致。super-code 当前语言同步会触发整页重载，语言不一致时可能循环重载；两插件共存时的语言切换仍有此限制。

安装包包含编译产物、预设、bundle patch、README、文档和许可证。使用者安装 tarball 不需要生成器或相邻源码仓库。

`PLAN.md`、`MEMORY.md`、`TASKS.md`、`.development/` 是本地过程资料；不跟踪、不打包。`eval/`、`.test-output/` 和 `.build/` 保存本地评测、截图和构建暂存，也不发布。

发布前核对版本、文件清单，并在独立 profile 安装实际 tarball。npm 发布与市场收录分别执行；`npm pack` 不会发布。旧版本准备记录见 [0.0.1 发布说明](RELEASE-0.0.1.md)。

`screenshots.json` 声明本仓库的真实安装包截图，图中版本和固定响应限制见 README。源码不包含编译产物，市场安装需已构建 tarball；取得 GitHub Release 下载地址后再投稿，不把源码地址当成可直接安装的发布包。

兼容回归检查两代预设服务、卸载释放、默认模式不变、RPC 严格 schema 和图标导出。macOS 已用未修改的 DSH NEXT `2.0.17-next` 安装版、隔离 profile 和真实 tarball 运行侧栏及完整写作 workflow/reopen；宿主为 `0.2.0-rc.2`，没有兼容豁免。

平台补验可在对应机器执行上面的类型、构建、测试和包检查，再运行实际包 workflow/reopen。Windows 的目录 fsync 限制及文件占用重试已有模拟回归，不能替代 Windows/Linux 实机验收。其他桌面版本也需单独验证。POSIX 权限测试在 Windows 跳过，跳过项必须记录。
