import { defineTool } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import {
  readdirSync,
  statSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { join, resolve, relative, sep, basename } from 'node:path'

export const name = 'dsh-dead-links'
export const inject = ['tools']

// Extract http(s):// links per line. The character class stops at whitespace,
// quotes, backticks, angle brackets and closing brackets/parens — enough to cut
// a URL out of markdown `[text](url)` / `<url>` / bare-link prose. A simple
// trailing-punctuation strip handles end-of-sentence periods/commas.
const LINK_RE = /https?:\/\/[^\s<>"'`)\]}]+/g

// Trivial, deterministic glob matcher. Only `*` (within a path segment) and
// `**` (across segments) are wildcards; every other character is literal.
function globToRegExp(pattern) {
  let out = '^'
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?' // `**/` matches zero or more directories
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if ('\\^$.|+()[]{}?'.includes(ch)) out += '\\' + ch
    else out += ch
    i += 1
  }
  return new RegExp(out + '$')
}

function stripTrailingPunctuation(raw) {
  let url = raw
  while (url.length > 0 && ',.;:!?'.includes(url[url.length - 1])) {
    url = url.slice(0, -1)
  }
  return url
}

function extractLinks(line) {
  const out = []
  for (const m of line.matchAll(LINK_RE)) {
    out.push(stripTrailingPunctuation(m[0]))
  }
  return out
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// Zero-dependency recursive walk collecting regular files. Skips node_modules,
// .git and hidden directories to avoid a runaway scan on the workspace root
// fallback; symlinks are not followed (no cycle risk).
function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
      walk(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
}

function describeError(err) {
  const cause = err && err.cause && err.cause.message ? ` (${err.cause.message})` : ''
  return `${(err && err.message) || String(err)}${cause}`
}

// Check one URL. HEAD first; on 405/403/network error downgrade to GET (only
// the status matters — the body is read and discarded). Never throws: a final
// network failure yields { status: null, error }.
async function checkUrl(url, timeoutMs) {
  let status = null
  let error = null

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.body) {
      try { await res.body.cancel() } catch { /* noop */ }
    }
    status = res.status
    if (status === 405 || status === 403) status = null // downgrade to GET
  } catch {
    status = null // network error → downgrade to GET
  }

  if (status === null) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = res.status
      if (res.body) {
        for await (const _chunk of res.body) { /* discard body */ }
      }
    } catch (err) {
      error = describeError(err)
    }
  }

  return { status, error }
}

// Concurrency-limited map over `items`. A worker keeps pulling the next item
// until the queue is drained; `limit` bounds how many run in parallel.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const n = Math.min(Math.max(Math.floor(limit), 1), items.length)
  const runners = []
  for (let i = 0; i < n; i++) {
    runners.push((async () => {
      while (next < items.length) {
        const idx = next++
        results[idx] = await worker(items[idx], idx)
      }
    })())
  }
  await Promise.all(runners)
  return results
}

function clampConcurrency(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 5
  return Math.max(1, Math.min(10, Math.floor(value)))
}

function normalizeRel(p) {
  return p.split(sep).join('/')
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'dead_links',
    description:
      'Scan Markdown files under a directory for dead http(s) links. Walks the tree ' +
      'with node:fs (zero deps), extracts http(s):// URLs per line (line numbers kept), ' +
      'checks each unique URL with a concurrency-limited HEAD request (GET fallback on ' +
      '405/403/network error), and returns a canonical { ok, dir, filesScanned, linksFound, ' +
      'linksChecked, dead, durationMs, truncated } object. Read-only — never modifies any file.',
    parameters: {
      dir: {
        type: 'string',
        description:
          'Directory to scan, relative to the workspace root. Defaults to "docs"; ' +
          'when it does not exist, falls back to the workspace root "." (noted in the result).',
      },
      glob: {
        type: 'string',
        default: '**/*.md',
        description:
          'Simple glob to select files, matched against paths relative to dir. Only the ' +
          '"*" wildcard (within a segment) and "**" (across segments) are supported.',
      },
      concurrency: {
        type: 'number',
        default: 5,
        description: 'How many URLs to check in parallel (clamped to 1-10). Defaults to 5.',
      },
      timeoutMs: {
        type: 'number',
        default: 10000,
        description: 'Per-request timeout in milliseconds. Defaults to 10000.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the scan ran (false only on a filesystem error).' },
          dir: { type: 'string', required: true, description: 'The directory actually scanned (after fallback).' },
          filesScanned: { type: 'integer', required: true, description: 'Number of files matched by glob and scanned.' },
          linksFound: { type: 'integer', required: true, description: 'Total link occurrences extracted.' },
          linksChecked: { type: 'integer', required: true, description: 'Number of unique URLs checked over the network.' },
          dead: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true, description: 'File path relative to dir.' },
                line: { type: 'integer', required: true, description: '1-based line number of the link.' },
                url: { type: 'string', required: true, description: 'The dead URL.' },
                status: {
                  oneOf: [{ type: 'integer' }, { type: 'null' }],
                  required: true,
                  description: 'HTTP status when one was received; null on a network error.',
                },
                error: { type: 'string', description: 'Network failure reason, only when status is null.' },
              },
            },
          },
          durationMs: { type: 'number', required: true, description: 'Total wall-clock time in milliseconds.' },
          truncated: { type: 'boolean', required: true, description: 'Whether the dead list was truncated (over 100 entries).' },
          note: { type: 'string', description: 'Human-readable annotation (dir fallback, truncation, cancellation).' },
          error: {
            type: 'object',
            additionalProperties: true,
            description: 'Filesystem failure detail, only present when ok is false.',
            properties: {
              stage: { type: 'string', description: "Failure stage: 'fs'." },
              message: { type: 'string', description: 'Human-readable failure reason.' },
            },
          },
        },
      },
      render(_args, value) {
        if (!value || value.ok === false) {
          const err = (value && value.error) || {}
          return [{ type: 'text', text: `死链检查失败 [${err.stage || 'fs'}]: ${err.message || '未知错误'}` }]
        }
        const lines = [
          `死链检查：目录 "${value.dir}"，扫描 ${value.filesScanned} 个文件，` +
            `发现 ${value.linksFound} 条链接（${value.linksChecked} 个唯一 URL），耗时 ${value.durationMs}ms`,
        ]
        if (value.note) lines.push(`备注：${value.note}`)
        if (!value.dead || value.dead.length === 0) {
          lines.push('未发现死链 ✓')
        } else {
          lines.push(`发现 ${value.dead.length} 条死链${value.truncated ? '（已截断）' : ''}：`)
          lines.push('| 文件 | 行 | URL | 状态 |')
          lines.push('|---|---|---|---|')
          for (const d of value.dead) {
            const statusText = d.status !== null && d.status !== undefined
              ? String(d.status)
              : `网络错误${d.error ? `：${d.error}` : ''}`
            lines.push(`| ${d.file} | ${d.line} | ${d.url} | ${statusText} |`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const started = Date.now()

      const requestedDir = (typeof args.dir === 'string' && args.dir.trim() !== '') ? args.dir.trim() : 'docs'
      let dir = requestedDir
      let note = ''
      let absDir = resolve(process.cwd(), dir)

      if (!isDirectory(absDir)) {
        dir = '.'
        note = `目录 "${requestedDir}" 不存在，已回退到工作区根 "."`
        absDir = resolve(process.cwd(), dir)
      }
      if (!isDirectory(absDir)) {
        return { ok: false, error: { stage: 'fs', message: `目录不存在: "${requestedDir}"（且工作区根不可用）` } }
      }

      const glob = (typeof args.glob === 'string' && args.glob !== '') ? args.glob : '**/*.md'
      const concurrency = clampConcurrency(args.concurrency)
      const timeoutMs = (typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0)
        ? args.timeoutMs
        : 10000

      const allFiles = []
      walk(absDir, allFiles)
      allFiles.sort()

      const matcher = globToRegExp(glob)
      const mdFiles = allFiles.filter((f) => matcher.test(normalizeRel(relative(absDir, f))))

      const occurrences = []
      for (const file of mdFiles) {
        if (exec && exec.signal && exec.signal.aborted) break
        let text
        try {
          text = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        const relFile = normalizeRel(relative(absDir, file))
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          for (const url of extractLinks(lines[i])) {
            occurrences.push({ file: relFile, line: i + 1, url })
          }
        }
      }

      const linksFound = occurrences.length

      const uniqueUrls = []
      const seen = new Set()
      for (const o of occurrences) {
        if (!seen.has(o.url)) {
          seen.add(o.url)
          uniqueUrls.push(o.url)
        }
      }

      const results = await mapWithConcurrency(uniqueUrls, concurrency, async (url) => {
        if (exec && exec.signal && exec.signal.aborted) return { skipped: true }
        const r = await checkUrl(url, timeoutMs)
        return { skipped: false, ...r }
      })

      const urlResult = new Map()
      let linksChecked = 0
      uniqueUrls.forEach((url, i) => {
        const r = results[i]
        if (r && !r.skipped) {
          linksChecked++
          urlResult.set(url, r)
        }
      })

      const deadAll = []
      for (const o of occurrences) {
        const r = urlResult.get(o.url)
        if (!r) continue
        if (r.status === null || r.status >= 400) {
          deadAll.push({
            file: o.file,
            line: o.line,
            url: o.url,
            status: r.status,
            ...(r.error ? { error: r.error } : {}),
          })
        }
      }

      const truncated = deadAll.length > 100
      const dead = truncated ? deadAll.slice(0, 100) : deadAll
      if (truncated) {
        note = (note ? note + '；' : '') + `死链共 ${deadAll.length} 条，仅显示前 100 条`
      }
      if (exec && exec.signal && exec.signal.aborted) {
        note = (note ? note + '；' : '') + '执行已取消，结果为部分数据'
      }

      return {
        ok: true,
        dir,
        filesScanned: mdFiles.length,
        linksFound,
        linksChecked,
        dead,
        durationMs: Date.now() - started,
        truncated,
        ...(note ? { note } : {}),
      }
    },
  }))

  if (process.env.DSH_PLUGIN_SELFTEST === '1') void selfTest(ctx)
}

// Mount-time self-test: create a temp directory inside the workspace, drop one
// .md containing a live link (example.com) and one guaranteed-dead link
// (a .invalid TLD), drive the real execution pipeline (ctx.tools.execute),
// assert the result, print an evidence line, then delete the temp directory.
async function selfTest(ctx) {
  let tmpDir = null
  try {
    tmpDir = mkdtempSync(join(process.cwd(), '.dsh-dead-links-selftest-'))
    const rel = basename(tmpDir)
    writeFileSync(
      join(tmpDir, 'probe.md'),
      '# probe\n\n[good](https://example.com/)\n\n[bad](https://nonexistent-domain.invalid/x)\n',
      'utf8',
    )

    const res = await ctx.tools.execute({
      callId: CallId('dead-links-self-test'),
      name: 'dead_links',
      arguments: { dir: rel, timeoutMs: 15000, concurrency: 2 },
      signal: new AbortController().signal,
    })

    if (res.isError) {
      console.log('[dsh-dead-links] self-test ERROR:', JSON.stringify(res.error))
    } else {
      const v = res.value
      const urls = (v.dead || []).map((d) => d.url)
      const hasInvalid = urls.some((u) => u.includes('.invalid'))
      const hasExample = urls.some((u) => u.includes('example.com'))
      const pass = v.ok === true && hasInvalid && !hasExample
      console.log(
        `[dsh-dead-links] self-test ok=${v.ok} filesScanned=${v.filesScanned} ` +
        `linksChecked=${v.linksChecked} dead=${(v.dead || []).length} ` +
        `hasInvalid=${hasInvalid} hasExample=${hasExample} → ${pass ? 'PASS' : 'FAIL'}`,
      )
    }
  } catch (err) {
    console.log('[dsh-dead-links] self-test THREW:', (err && err.message) || err)
  } finally {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* noop */ }
    }
  }
}
