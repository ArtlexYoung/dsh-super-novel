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

链接脚本只在本项目 `node_modules` 中添加缺失链接。重新安装依赖后，需要再次运行。宿主依赖使用精确预发布版本，其他版本需另行验证。

## 检查范围

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 检查 Host TypeScript 类型 |
| `npm run build` | 编译 Host、浏览器代码及官方 Typert/Remote 产物 |
| `npm test` | 检查作品读写/恢复、权限、预设安装、组合加载、RPC 和用量统计 |
| `npm run pack:check` | 构建并查看 npm 文件清单 |
| `npm pack` | 构建并生成可安装 tarball |

作品界面的隔离浏览器验证：

```sh
node --experimental-strip-types scripts/prepare-preview.ts .test-output/preview-v003
node --experimental-strip-types scripts/serve-preview.ts .test-output/preview-v003
```

准备脚本拒绝覆盖已有目录。使用已安装的 Playwright 路径运行 `scripts/browser-books.ts`，先验证创建和保存，再重启预览服务，以 `reopen` 参数验证磁盘恢复。运行方法与临时认证 URL 的处理见 [P0 技术验证](P0-VALIDATION.md#重现浏览器验证)；现用 URL 位于隔离预览目录。只终止本次启动的进程。

`0.0.3` 的浏览器检查不调用模型。真实模型测试会产生调用费用，方法和历史结果见[评测说明](evaluation.md)。单元测试通过不代表跨平台兼容或文学质量通过。

## 打包与发布

安装包包含编译产物、预设、bundle patch、README、文档和许可证。使用者安装 tarball 不需要生成器或相邻源码仓库。

`PLAN.md`、`MEMORY.md`、`TASKS.md`、`.development/` 是本地过程资料；不跟踪、不打包。`eval/`、`.test-output/` 和 `.build/` 保存本地评测、截图和构建暂存，也不发布。

发布前核对版本、文件清单，并在独立 profile 安装实际 tarball。npm 发布与市场收录分别执行；`npm pack` 不会发布。旧版本准备记录见 [0.0.1 发布说明](RELEASE-0.0.1.md)。
