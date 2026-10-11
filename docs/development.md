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

窄栏写作布局用 `scripts/browser-writing-layout.ts` 检查实际宿主的 300/420px 侧栏、短窗口和 900px 全屏。它测量正文高度、保存条和导航边界，验证单个工具、Esc、焦点循环、原编辑器、选区、滚动、原生撤销、资料只读和显式编辑前保留草稿；资料浏览不调用模型。

草稿和路径回归用 `scripts/browser-drafts.ts`：同章双窗口、清除浏览器草稿后从磁盘恢复、检查点失败/重试、正式保存、修改位置再切回。该脚本只操作隔离测试目录。

侧栏适配用 `scripts/browser-sidebar.ts`，覆盖七类混合资料、类型/关联章节/名称筛选、100 项分页、目录开关、300/420px 拖动侧栏和 900px 全屏。它同时检查切页和缩放保留草稿、候选与采纳结果，以及 ⌘/Ctrl+S 保存；停服重启后附加 `reopen`，确认查询不会重新生成。共享辅助函数通过可见入口打开新建、AI 设置和文档选项，等待固定响应夹具就绪后才测试。该浏览器命令使用 Chromium，只验证 Web；桌面原生协议的实测范围见[评测说明](evaluation.md)。

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

写作辅助用 `scripts/browser-writing-methods.ts` 验证意图输入保留、磁盘版本、AI 方向编辑、纯读上下文和局部审校候选。`test/writing-methods.test.ts` 覆盖幂等、冲突、来源变化、预算、引用越界、范围保护和备份包含意图。

跨章状态用 `scripts/browser-story-state.ts` 验证手工事件、可编辑建议、明确确认、两章伏笔、纯读上下文与修改影响。`test/story-state.test.ts` 包含五章序列、人物知情隔离、来源变化、前章重排、采纳中断重放和损坏格式。`test/proposal-host.test.ts` 用真实 Host 的备份任务核对 AI 与事实采纳后的归档，定时等待在测试中提前触发。

整书查找使用 `scripts/browser-navigation.ts` 检查已保存正文/资料、命中片段、双向引用、前进返回、正文撤销/重做、保存后刷新位置、精确打开原文、草稿失败阻止切章、过期证据和 300/420px、900px 全屏，核对查询零模型调用。`test/book-search.test.ts` 覆盖字面匹配、中文/Unicode 位置、分页、范围隔离、取消和读取预算；`test/writing-position.test.ts` 覆盖位置与存储失败；`test/editor-history.test.ts` 覆盖输入分组、组字、范围替换、重做与内存边界。

资料维护使用 `scripts/browser-material-maintenance.ts` 检查无关更新保留输入、元信息冲突、清除浏览器表单缓存后的资料/事件/伏笔恢复、正式保存与清理失败的区别、旧清理保留新输入、常用筛选、三种批量操作与过期预览拒绝。实际包检查 300/420px 和 900px 全屏，预览时确认按钮保持可见，维护不调用模型。`test/material-maintenance.test.ts` 覆盖独立分支、格式与预算、备份回读、100 份批量、1,000 份筛选、三个提交阶段的中断和重复请求；真实 Host 测试另外校验只读与跨库限制。

集中待确认使用 `scripts/browser-candidate-inbox.ts` 检查指定候选导航、跨章草稿保留、审阅返回、方向编辑、部分状态确认与拒绝剩余、过期阻断、资料来源、整理范围预览、停止及轮询保留焦点。独立流程包含两次作者显式启动的固定响应调用，查询和重开不新增调用；检查 300/420px 与 900px 布局。`test/candidate-inbox.test.ts` 覆盖只读与跨库、拒绝后的旧表单、分页与扫描预算、损坏、取消、幂等和备份回读。

整书提纲使用 `scripts/browser-book-outline.ts` 检查核验备份后启用、卷与故事线、键盘重排、过期预览、影响列表、撤回、正文和结构表单从磁盘恢复、另一窗口 prepared 阶段保留输入，以及 300/420px、900px 全屏。`test/book-structure.test.ts` 覆盖严格格式、迁移与结构保存各阶段中断、幂等、跨库和只读、正文不变、引用与前章顺序、辅助记录变化、预算、取消、1,000 章分页和格式 3 的资料维护入口。旧插件必须拒绝格式 3，不使用降级写入作为恢复办法。

保存与恢复使用 `scripts/browser-save-recovery.ts` 检查当前输入、当前书范围、命名里程碑、重复点击、副本预览、正文与表单失败阻止切库、确认落盘后切换及返回原输入。`test/recovery-experience.test.ts` 覆盖保存层独立失败、损坏与离线、里程碑三个阶段中断、幂等、同名、副本被改或多余文件、任意和链接路径拒绝、待恢复记录、表单屏障及 Host 权限。固定响应配置仅供隔离测试，此流程零模型调用。

跨章改稿使用 `scripts/browser-book-review.ts`，与其他固定响应流程一样准备全新 `--generation` profile，再传入该目录运行。检查故事线来源预览、双击只调用一次、两章精确引用、确认/拒绝、停止后刷新零重发、磁盘草稿、原编辑器与位置、局部候选及采纳、过期阻断和 300/420px、900px 布局。相同检查函数也可供隔离的安装桌面 profile 使用。

`test/book-reviews.test.ts` 覆盖范围/预算、空事实降级、范围外来源排除、错误证据和格式、重复/并发/两个中断阶段、显式 Host 停止、确认与候选的幂等、后续复核依赖和两轮上限、过期、备份、影响与权限。固定响应验证流程，不证明模型审校准确率或文学效果。
