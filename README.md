# dsh-super-novel

DeepSeek Harness 小说写作插件，预设 ID 为 `dsh-super-novel`。当前版本 `0.1.0-alpha.1` 是 P0 技术预览：提供小说写作提示词、右侧「小说工作台」和显式启用流程。

章节管理、作品存储、事实回填、独立审校和修订流程尚未实现。已完成 3 个样本、6 次调用的[真实模型提示词对照](docs/LIVE-EVAL-P0.md)，尚不能证明写作质量提升。完整方案见 [设计](docs/DESIGN.md)，按 [实施批次](docs/IMPLEMENTATION.md) 继续推进。

## 本地开发

需要 Node.js 22.19+ 或 24+，以及相邻目录已构建的 `deepseek-harness`（当前验证 `0.1.5-rc.2`、`c291e7961a`）；组合测试还读取相邻 `dsh-super-code` 的 patch。

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run dev:link-harness
npm run typecheck
npm run build
npm test
npm run pack:check
npm pack
```

开发链接脚本只在本项目 `node_modules` 添加缺失链接。安装依赖后须重新运行链接脚本。正式包携带预编译 Host、Client 和官方生成的 Typert/Remote 产物；使用者不需要本地生成器。精确 prerelease peerDependencies 限定当前宿主基线，其他版本待验证。

## 启用与数据位置

将本地 tarball 安装到专用 Harness profile，并将 `dsh-super-novel` 加入该 profile 的 `dsh.profile.bundles`（遵循宿主的 profile/bundle 安装流程）。P0 尚未上架市场。隔离验证方法见 [验证记录](docs/P0-VALIDATION.md)。

打开一个会话，在右侧栏的开始页选择「小说工作台」，点击「启用写作模式」。随后在宿主模式选择器中选择 **Super Write · 小说写作**；如果已打开的选择器未更新，关闭后重新打开。

插件只向宿主第一个 `trust: user` 预设根写入 `dsh-super-novel/`，默认通常是 `$DSH_HOME/.agent-presets/dsh-super-novel/`（未指定 `DSH_HOME` 时在 `~/.dsh` 下）。自定义根支持绝对路径与 `~/`；相对路径拒绝启用。bundle 不替换 roots、默认模式或其他预设。查看侧栏不创建目录，不调用模型。

目录包含 `preset.yml`、`agent.cordis.yml` 和带版本/文件哈希的 `.dsh-super-novel.json`。插件目前不保存小说正文。

## 冲突、恢复、升级与卸载

- 同名未归属目录、额外文件、被修改的预设或其他版本都会显示冲突，不覆盖内容。先备份整个目录，再检查差异；需要重新安装时，将旧目录移到预设根之外，之后重新启用。
- 已归属且仅缺少文件时，可以点击「继续启用」。文件只写了一部分、归属记录损坏或目录尚无归属记录时，需要按上一项人工处理。
- 启用使用根下 `.dsh-super-novel.lock/` 目录互斥。进程崩溃会留下锁；确认所有启用进程已退出后，只对该空锁目录执行 `rmdir`，再重新检查。不要在另一实例启用期间移除锁。
- 本版本不自动迁移旧预设。升级前备份旧目录，检查新旧版本差异并人工移出旧预设，再启用新版本。
- 卸载前关闭使用此模式的会话，将预设目录备份到 roots 之外，再从 profile 移除 bundle 与包。先卸载包会留下引用缺失包的预设，宿主可能标记不可用；重新安装相同版本可恢复，也可按上述方式移走残留预设。没有自动卸载钩子。

安装锁用于协调本插件实例，不抵御其他程序同时替换文件；只检查根目录本身、目标目录与文件的符号链接，不检查所有祖先目录。磁盘写入不是跨文件事务；遇中途写入失败会保留现场供恢复。

## 设计与发布

- [调研](docs/RESEARCH.md)：Harness 接口、EasyNovel / Novel-1 流程与市场规范。
- [设计](docs/DESIGN.md)：规划、写作、事实、审校与修订闭环。
- [计划](PLAN.md)：当前进度和下一步。
- [P0 验证](docs/P0-VALIDATION.md)：实际检查、兼容范围和未测项。

发布包已声明 `dsh.bundle.patch`、`dsh.client` 与 exports。dsh-market 目录条目在 P6 按真实功能准备；发布 owner、仓库与许可证尚未确定（当前 `UNLICENSED`），没有执行 npm 发布或市场提交。
