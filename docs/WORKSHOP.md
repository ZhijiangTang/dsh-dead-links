# dsh-dead-links — DSH Hub Workshop 自证文档

> 对应 package.json#dshWorkshop 的 evidence 字段。所有操作针对公开基线 @deepseek-ai/dsh@0.1.0-rc.6。

## Install（安装）

- npm 安装：`dsh plugin --profile <name> add dsh-dead-links@0.1.1`
- 本地安装：`dsh plugin --profile <name> add file:./plugins/dsh-dead-links`
- 安装后 `dsh --profile <name> --dump-config` 应出现 `# == dsh-dead-links` 层；插件为单包 bundle，声明 `dsh.bundle.patch`。
- 启动自检：`DSH_PLUGIN_SELFTEST=1 dsh --profile <name> --port 0` 可复现全部自检（默认启动不打外网）。

## Failure isolation（失败隔离）

- 安装为 transactional profile bundle；失败时 pnpm 事务回滚，`dsh.profile.bundles` 对账不追加该包，当前 profile 组合保持不变。
- 插件自身异常（工具 execute 内错误）一律折进规范值 `{ok:false, error:...}`，不向外抛；注册的 disposer 由 Cordis 管理，卸载即注销工具。

## Remove（卸载）

- `dsh plugin --profile <name> remove dsh-dead-links` 同时移除依赖与 `dsh.profile.bundles` 层；插件无外部持久状态（除 dsh-handoff/dsh-fetch-file 的显式工作区文件，均在工作区根内且由用户指定路径）。
