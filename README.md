# dsh-dead-links

DSH 插件：Markdown 文档死链检查工具，注册一个 `dead_links` 工具。**纯 ESM、零依赖、无构建、只读不改任何文件**。

## 简介

- 工具名：`dead_links`
- 能力：用 `node:fs` 递归遍历目录，按 glob（默认 `**/*.md`）筛选 Markdown 文件；逐文件按行正则提取 `http(s)://` 链接（保留行号）；并发受限地逐条检查，先 `HEAD`（`AbortSignal.timeout` 超时），遇到 `405/403/网络错误` 降级 `GET`（只关心状态码，读完响应体即丢弃）；最终把每条死链的 `文件/行号/URL/状态码或错误` 折叠进规范 JSON 值返回。
- 行为：**永不抛异常**。网络类异常一律折进规范值（`dead[].status: null` + `dead[].error`）；目录不存在则返回 `{ ok: false, error: { stage: 'fs', message } }`。
- 只读：不修改、不写入任何被扫描的文件。

## 安装

```sh
dsh plugin --profile <name> add file:./plugins/dsh-dead-links
# 或发布后：
dsh plugin --profile <name> add dsh-dead-links
```

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `dir` | string | — | `docs` | 相对**工作区根**的目录。默认 `docs`，不存在时回退到工作区根 `.` 并在结果中注明 |
| `glob` | string | — | `**/*.md` | 简单通配模式，仅支持 `*`（段内）与 `**`（跨段）两种通配，匹配相对 `dir` 的路径 |
| `concurrency` | number | — | `5` | 并发检查的 URL 数量，夹取到 `1–10` |
| `timeoutMs` | number | — | `10000` | 单条请求超时（毫秒） |

## 输出字段

规范 JSON 值（`ok: true` 时）：

```jsonc
{
  "ok": true,
  "dir": "docs",            // 实际扫描的目录（回退后）
  "filesScanned": 12,       // 命中 glob 并扫描的文件数
  "linksFound": 58,         // 提取到的链接出现次数
  "linksChecked": 33,       // 实际检查的唯一 URL 数（按 URL 去重）
  "dead": [                 // 死链列表（每条 = 一次出现位置）
    { "file": "guide.md", "line": 42, "url": "https://gone.invalid/x", "status": 404 },
    { "file": "api.md", "line": 7, "url": "https://nx.invalid/", "status": null, "error": "getaddrinfo ENOTFOUND …" }
  ],
  "durationMs": 2345,
  "truncated": false,       // dead 超过 100 条时截断为 true
  "note": "…"               // 目录回退 / 截断 / 取消等说明，存在时给出
}
```

`ok: false`（目录不可用）时：`{ "ok": false, "error": { "stage": "fs", "message": "…" } }`。

## HEAD 降级 GET、限流并发

- **HEAD 优先**：先用 `HEAD` 探测，绝大多数站点对已存在的资源返回 `2xx/3xx/4xx`，无需下载响应体。
- **降级 GET**：当 `HEAD` 返回 `405 Method Not Allowed` 或 `403 Forbidden`（部分站点/网关禁用 `HEAD`），或 `HEAD` 本身网络失败时，降级为 `GET` 复测。`GET` **只关心状态码**：以流式方式读完响应体后立即丢弃，不落盘、不缓冲整包。
- **限流并发**：用一个固定大小的 worker 池并发检查，`concurrency`（默认 5）控制同时在途的请求数，避免对目标站点造成突发压力。
- **去重**：同一 URL 出现多次只发起一次网络请求，结果按 URL 缓存后映射回每一处出现位置；`linksChecked` 即唯一 URL 数，`linksFound` 为出现总次数。

## 与未来定时任务搭配

本插件只做「单次扫描」。配合一个跨会话调度器（如未来的 `dsh-scheduler`：定时器触发 → 空闲时 `followup(…, { source: { kind: 'cron' } })`，忙碌时 `inject()` 注入通知），即可实现「每周自动跑一遍 `dead_links`，把死链清单推给模型审阅/修复」：

1. 调度器在空闲时调用 `dead_links`（`dir`/`glob` 固定指向文档目录）；
2. 工具返回规范 JSON，`dead` 非空时调度器把结果 `inject` 进会话，让模型生成修复建议或直接改文档；
3. 全链路只读扫描 + 结构化结果，天然适合作为周期性文档健康检查的探测步骤。

## License

MIT
