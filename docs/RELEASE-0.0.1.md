# 0.0.1 npm 发布说明

> 历史记录：保留当时的版本、环境和结果。当前使用与开发入口见[文档目录](README.md)。

首个 npm 版本为 `0.0.1`，仍是 P0 技术预览。GitHub：<https://github.com/ArtlexYoung/dsh-super-novel>。npm 包名：`dsh-super-novel`；许可证：[Apache License 2.0](../LICENSE)。npm 发布由维护者执行，GitHub 推送不等同于 npm 发布或 dsh-market 收录。

## 本版范围

- 小说生成预设 `dsh-super-novel`，以及中英文小说侧栏的显式启用、状态与错误显示。
- bundle 仅插入自身服务，不覆盖预设 roots、默认模式或其他插件；已验证与 super-code 两种加载顺序共存。
- 同名未归属目录、用户编辑、额外文件和不同版本采用冲突保护。启用不覆盖原内容，查看侧栏不写入磁盘或调用模型。
- 不包含章节管理、作品存储、自动事实回填或独立审校。真实写作测试存在字数/段数未达标的情况，不能宣传完整写作流程或质量提升已通过验收。

当前兼容基线是 Harness `0.1.5-rc.2`，Node.js `^22.19.0 || >=24.0.0`，实际运行验证为 macOS Web。Desktop、Windows/Linux 与热卸载仍未完整验证。版本号不改变这些限制。

## 从本地 alpha 迁移

此前本地 `0.1.0-alpha.1` 从未作为本任务的 npm 发布执行。它的归属记录与 `0.0.1` 不同，安装新包不会自动覆盖旧预设：

1. 关闭使用小说生成模式的旧会话。
2. 备份并将旧版用户预设根里的 `dsh-super-novel` 整个目录移到预设根之外，保留修改内容供比较。不要改写归属标记绕过保护。
3. 在目标 Harness profile 安装 `dsh-super-novel@0.0.1`，保持 bundle 注册，重启宿主并在侧栏重新启用。
4. 新建会话选择 `Super Novel · 小说生成`。原有其他预设和默认值不需要调整。

默认用户根通常为 `$DSH_HOME/.agent-presets/`；有自定义 roots 时以实际配置为准。插件不保存正文，因此迁移的只是模式文件，不是作品文件。

## 维护者发布

从仓库开发环境重新生成时，先按[开发说明](development.md)安装依赖并链接相邻已构建 Harness，再执行：

```sh
npm run typecheck
npm run build
npm test
npm pack
npm publish ./dsh-super-novel-0.0.1.tgz --access public --registry=https://registry.npmjs.org/
```

最后一条是真实发布，由维护者登录 npm 后执行；可能要求 npm 2FA。发布已验证的 tarball，可确保上传内容与本地检查一致。`npm pack` 的 prepack 会重新构建，防止上传过期 lib；普通使用者安装已发布 tarball 不运行构建，也不需要相邻源码仓库。不要把 npm token 写入源码或命令行。

包包含预编译 Host、Client、Typert/Remote、固定 preset、说明和 LICENSE。`eval/`、`.test-output/`、构建暂存、node_modules 和源码评测素材不打包。未添加猜测的 npm owner；registry 对包名的实际授权以维护者发布时为准。

## 市场收录

npm 发布后，在 dsh-market 使用的 `awesome-dsh-plugin` 目录提交真实 npm 包和 GitHub 信息。npm/GitHub 准备完成并不自动产生市场条目。本次没有向市场提交 PR。


## 发布准备验证（2026-09-20）

- `npm run typecheck`、`npm run build` 和 14 项 `npm test` 通过，包括两个 super-code 顺序、自定义 roots/default 保留、冲突不覆盖和真实 Loader/RPC。
- tarball 在全新目录用公开 npm registry 安装成功；进一步安装同版官方 Loader 测试依赖后，实际加载包的 Host、Remote、写作预设通过，归属标记为 `0.0.1`，默认模式保持 standard。此项不依赖相邻 Harness 源码链接，也未调用模型。
- 许可证、导出入口和预设文件存在；本轮未更改正文指导或侧栏代码，浏览器与真实写作证据沿用 [P0 截图报告](BROWSER-WRITING-P0.md)，不是重新执行完整文学质量评测。
- registry 查询 `dsh-super-novel` 返回 404，查询时未发现公开版本；这不代替发布权限检查。
