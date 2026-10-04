#!/usr/bin/env node
/**
 * 把 uview-plus4/pages 下的示例页同步成本工程的 uni-app Vue3 示例页。
 *
 * 为什么需要：uview-plus4 的示例页是 `.uvue`（uni-app x），本工程验证的是 Vue3 链路，
 * 两边必须是同一批示例，手抄一定会漂移。所以这里做确定性转换，并提供 `--check` 检测漂移。
 *
 * 转换规则：
 *   1. `<script setup lang="uts">` → `<script setup lang="ts">`
 *      UTS 语法基本是 TS 的超集，交给 esbuild 做类型擦除即可，不做 AST 手术。
 *   2. 去掉 uvue 专有的 `styleIsolation` / `virtualHost`（Vue3 链路不认这两个 key）。
 *   3. 模板里的 TS 断言（`item['x'] as UTSJSONObject`）在 JS 模板表达式里是语法错误，逐处摘掉。
 *   4. 页面生命周期（`onLoad` / `onReady` / `onPageScroll` ...）在 uni-app Vue3 下必须从
 *      `@dcloudio/uni-app` 显式 import，这里按实际用到的钩子补 import。
 *   5. 其余文件（`.vue` / `.js`）原样拷贝；`.nvue` / `.uts` 不参与 Vue3 链路，跳过。
 *
 * 用法：
 *   node scripts/sync-demo-pages.mjs              # 生成 / 覆盖
 *   node scripts/sync-demo-pages.mjs --check      # 只检查是否与源仓库一致，不一致退出码 1
 *   node scripts/sync-demo-pages.mjs --source <uview-plus4 路径>
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.includes('--check')
const sourceIndex = process.argv.indexOf('--source')
const SOURCE_ROOT = sourceIndex === -1
    ? path.resolve(ROOT, '..', 'uview-plus4')
    : path.resolve(process.argv[sourceIndex + 1])

const SOURCE_PAGES = path.join(SOURCE_ROOT, 'pages')
const SOURCE_PAGES_JSON = path.join(SOURCE_ROOT, 'pages.json')
const TARGET_PAGES = path.join(ROOT, 'src', 'pages')
const TARGET_PAGES_JSON = path.join(ROOT, 'src', 'pages.json')
const TARGET_MANIFEST = path.join(TARGET_PAGES, 'index', 'demo-manifest.js')

const INDEX_PAGE = 'pages/index/index'
const SKIP_EXTENSIONS = new Set(['.nvue', '.uts', '.uvue.bak'])
const COPY_EXTENSIONS = new Set(['.js', '.json', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.css'])

/** uni-app Vue3 下必须从 @dcloudio/uni-app 显式 import 的页面生命周期 */
const PAGE_LIFECYCLE_HOOKS = [
    'onLoad', 'onShow', 'onReady', 'onHide', 'onUnload', 'onResize', 'onBackPress',
    'onPageScroll', 'onReachBottom', 'onPullDownRefresh', 'onTabItemTap', 'onInit',
    'onShareAppMessage', 'onShareTimeline', 'onAddToFavorites', 'onPageNotFound',
    'onNavigationBarButtonTap', 'onNavigationBarSearchInputChanged',
]

const written = []
const skipped = []
const problems = []

/* ------------------------------------------------------------------ 工具 */

function rel(target) {
    return path.relative(ROOT, target).split(path.sep).join('/')
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            walk(full, out)
        } else if (entry.isFile()) {
            out.push(full)
        }
    }
    return out
}

/** 去掉 JSONC 注释与尾逗号，pages.json 里带 `//` 注释 */
function parseJsonc(text) {
    let result = ''
    let inString = false
    let escaped = false
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i]
        if (inString) {
            result += char
            if (escaped) escaped = false
            else if (char === '\\') escaped = true
            else if (char === '"') inString = false
            continue
        }
        if (char === '"') {
            inString = true
            result += char
            continue
        }
        if (char === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i += 1
            result += '\n'
            continue
        }
        if (char === '/' && text[i + 1] === '*') {
            i += 2
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
            i += 1
            continue
        }
        result += char
    }
    return JSON.parse(result.replace(/,(\s*[}\]])/g, '$1'))
}

/** 收集源 pages.json 里的标题，键是去掉前缀的页面路径 */
function readSourceTitles() {
    const titles = new Map()
    if (!fs.existsSync(SOURCE_PAGES_JSON)) return titles
    let config
    try {
        config = parseJsonc(fs.readFileSync(SOURCE_PAGES_JSON, 'utf8'))
    } catch (error) {
        problems.push('无法解析源 pages.json：' + error.message)
        return titles
    }
    const collect = (page, root) => {
        const full = root ? root + '/' + page.path : page.path
        const title = page.style && page.style.navigationBarTitleText
        if (title) titles.set(full, title)
    }
    for (const page of config.pages || []) collect(page, '')
    for (const group of config.subPackages || []) {
        for (const page of group.pages || []) collect(page, group.root)
    }
    return titles
}

/* ------------------------------------------------------------------ 转换 */

/** 摘掉模板表达式里的 TS 断言：只处理 {{ }} 与指令属性值，避免误伤可见文本 */
function stripTemplateAssertions(template) {
    const strip = (expression) => expression.replace(/\s+as\s+[A-Za-z_$][\w$]*(?:\[\])?/g, '')
    return template
        .replace(/\{\{([\s\S]*?)\}\}/g, (matched, expression) => '{{' + strip(expression) + '}}')
        .replace(/([:@][\w:.-]+|v-[\w:.-]+)="([^"]*)"/g, (matched, name, expression) => {
            return name + '="' + strip(expression) + '"'
        })
}

/** 去掉 uvue 专有的 defineOptions key；对象变空则整段去掉 */
function stripUvueOnlyOptions(script) {
    let output = script.replace(/styleIsolation\s*:\s*(['"])[^'"]*\1\s*,?/g, '')
    output = output.replace(/virtualHost\s*:\s*(?:true|false)\s*,?/g, '')
    output = output.replace(/defineOptions\(\s*\{([^{}]*)\}\s*\)\s*/g, (matched, body) => {
        return /[A-Za-z_$]/.test(body) ? matched : ''
    })
    return output
}

/** 按实际用到的页面生命周期补 @dcloudio/uni-app 的 import */
function injectLifecycleImports(script, tagEndIndex) {
    const used = PAGE_LIFECYCLE_HOOKS.filter((hook) => new RegExp('\\b' + hook + '\\s*\\(').test(script))
    if (used.length === 0) return script
    const already = new RegExp("from\\s+['\"]@dcloudio/uni-app['\"]").test(script)
    if (already) return script
    const statement = "\nimport { " + used.join(', ') + " } from '@dcloudio/uni-app'\n"
    return script.slice(0, tagEndIndex) + statement + script.slice(tagEndIndex)
}

/** 把示例页里显式写死的 `.uts` 导入改写成 Vue3 侧能用的形式 */
const UTS_IMPORT_RE = /import\s+((?:(?!import|from)[\s\S])*?)\s+from\s+(['"])([^'"]+)\.uts\2/g

function hasJsSibling(pageFile, specifier) {
    const base = specifier.startsWith('@/')
        ? path.join(SOURCE_ROOT, specifier.slice(2))
        : path.resolve(path.dirname(pageFile), specifier)
    try {
        return fs.statSync(base + '.js').isFile()
    } catch {
        return false
    }
}

function rewriteUtsImports(source, pageFile) {
    return source.replace(UTS_IMPORT_RE, (matched, clause, quote, specifier) => {
        // 有 .js 孪生就直接指向 .js
        if (hasJsSibling(pageFile, specifier)) {
            return 'import ' + clause + ' from ' + quote + specifier + '.js' + quote
        }
        // 没有 .js 孪生的都是纯类型（如 types/index.uts），改成 import type，
        // esbuild 会整条擦除，Vite 也就不会去解析这个不存在的模块
        return 'import type ' + clause + ' from ' + quote + specifier + quote
    })
}

/**
 * uvue 用 `ref.$callMethod('name', ...args)` 调子组件方法，Vue3 里不存在这个 API，
 * 直接调 `ref.name(...args)` 即可。
 */
function rewriteCallMethod(source) {
    return source
        // 先摘掉紧贴在 $callMethod 前面的类型断言：(x as ComponentPublicInstance)?.$callMethod(...)
        .replace(/\(([^()]*?)\s+as\s+[A-Za-z_$][\w$.\[\]]*\)(\s*\??\.\$callMethod)/g, '($1)$2')
        // 再改写调用本身：.$callMethod('name', a, b) → .name(a, b)
        .replace(/\.\$callMethod\(\s*(['"])([A-Za-z_$][\w$]*)\1\s*,?\s*/g, '.$2(')
}

function convertUvue(source, pageFile) {
    let output = rewriteCallMethod(rewriteUtsImports(source, pageFile))
        .replace(/\slang\s*=\s*["']uts["']/g, ' lang="ts"')

    // 注意用 lastIndexOf：模板里还有 <template #default="..."> 这种子模板，第一个 </template> 不是根标签
    const templateEnd = output.lastIndexOf('</template>')
    if (templateEnd !== -1) {
        output = stripTemplateAssertions(output.slice(0, templateEnd)) + output.slice(templateEnd)
    }

    const scriptMatch = output.match(/<script setup\b[^>]*>/)
    if (scriptMatch) {
        const start = scriptMatch.index
        const end = start + scriptMatch[0].length
        const closeIndex = output.indexOf('</script>', end)
        if (closeIndex === -1) {
            problems.push('缺少 </script>')
            return output
        }
        let script = output.slice(end, closeIndex)
        script = stripUvueOnlyOptions(script)
        script = injectLifecycleImports(script, 0)
        output = output.slice(0, end) + script + output.slice(closeIndex)
    }

    return output
}

/* ------------------------------------------------------------------ 生成 */

/** 转换后的自检：模板表达式里不允许残留 TS 断言（JS 模板解析不了 `x as T`） */
const TEMPLATE_ASSERTION_RE = /(?:[:@][\w:.-]+|v-[\w:.-]+)="[^"]*\sas\s+[A-Za-z_$]|\{\{[^}]*\sas\s+[A-Za-z_$]/

function validateConverted(targetRelative, content) {
    const templateEnd = content.lastIndexOf('</template>')
    if (templateEnd === -1) return
    const leftover = content.slice(0, templateEnd).match(TEMPLATE_ASSERTION_RE)
    if (leftover) {
        problems.push(targetRelative + ' 模板里仍有未摘掉的 TS 断言：' + leftover[0].slice(0, 70))
    }
}

function buildTargets() {
    const titles = readSourceTitles()
    const targets = []
    const takenTargets = new Map()

    const sourceFiles = walk(SOURCE_PAGES).sort()
    const uvueFiles = []
    const directFiles = []

    for (const file of sourceFiles) {
        const extension = path.extname(file)
        if (extension === '.uvue') uvueFiles.push(file)
        else directFiles.push(file)
    }

    const push = (file, targetRelative, content) => {
        const pagePath = targetRelative.replace(/\.vue$/, '')
        const isPage = targetRelative.endsWith('.vue')
        const entry = {
            relativePath: targetRelative,
            content,
            pagePath,
            isPage,
            title: titles.get(pagePath) || path.basename(targetRelative, path.extname(targetRelative)),
        }
        if (isPage) validateConverted(targetRelative, content)
        targets.push(entry)
        takenTargets.set(targetRelative, file)
    }

    // 先处理已经存在的 .vue 示例页：它们本来就是给 uni-app / Vue3 链路写的，优先于同名 .uvue
    for (const file of directFiles) {
        const relativePath = path.relative(SOURCE_PAGES, file).split(path.sep).join('/')

        // .config.uts 是示例首页的导航数据，Vue3 链路里改叫 .config.ts（内容含 TS type，交给 esbuild 擦除）
        if (file.endsWith('.config.uts')) {
            push(file, 'pages/' + relativePath.replace(/\.uts$/, '.ts'), fs.readFileSync(file, 'utf8'))
            continue
        }

        const extension = path.extname(file)
        if (SKIP_EXTENSIONS.has(extension)) {
            skipped.push(relativePath)
            continue
        }
        if (extension === '.vue') {
            push(file, 'pages/' + relativePath, convertUvue(fs.readFileSync(file, 'utf8'), file))
            continue
        }
        if (COPY_EXTENSIONS.has(extension)) {
            push(file, 'pages/' + relativePath, fs.readFileSync(file, 'utf8'))
            continue
        }
        skipped.push(relativePath)
    }

    for (const file of uvueFiles) {
        const relativePath = path.relative(SOURCE_PAGES, file).split(path.sep).join('/')
        const targetRelative = 'pages/' + relativePath.replace(/\.uvue$/, '.vue')
        if (takenTargets.has(targetRelative)) {
            skipped.push(relativePath + '（已有同名 .vue，优先用 .vue）')
            continue
        }
        push(file, targetRelative, convertUvue(fs.readFileSync(file, 'utf8'), file))
    }

    return targets
}

function buildPagesJson(pages) {
    const pageEntries = pages.filter((page) => page.isPage)
    const config = {
        pages: [
            {
                path: INDEX_PAGE,
                style: { navigationBarTitleText: 'uview-ultra · Vue3 冒烟' },
            },
            ...pageEntries.map((page) => ({
                path: page.pagePath,
                style: { navigationBarTitleText: page.title },
            })),
        ],
        easycom: {
            autoscan: true,
            custom: {
                '^up-(.*)': '@/uni_modules/uview-ultra/components/up-$1/up-$1.vue',
            },
        },
        globalStyle: {
            navigationBarTextStyle: 'black',
            navigationBarTitleText: 'uview-ultra · Vue3',
            navigationBarBackgroundColor: '#FFFFFF',
            backgroundColor: '#F5F6FA',
        },
    }
    return JSON.stringify(config, null, 4) + '\n'
}

function buildManifest(pages) {
    const groups = []
    for (const page of pages.filter((item) => item.isPage)) {
        const segments = page.pagePath.split('/')
        const group = segments[1] || 'other'
        let bucket = groups.find((item) => item.name === group)
        if (!bucket) {
            bucket = { name: group, items: [] }
            groups.push(bucket)
        }
        bucket.items.push({ title: page.title, path: page.pagePath })
    }
    const body = JSON.stringify(groups, null, 4)
    return [
        '// 由 scripts/sync-demo-pages.mjs 生成，勿手工修改',
        'export default ' + body,
        '',
    ].join('\n')
}

/* ------------------------------------------------------------------ 主流程 */

function emit(targetPath, content) {
    const absolute = path.join(ROOT, 'src', targetPath)
    const existing = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null
    if (existing === content) {
        written.push(targetPath)
        return
    }
    if (CHECK_ONLY) {
        problems.push('与源仓库不一致：' + rel(absolute))
        return
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
    written.push(targetPath)
}

/** 供门禁调用：返回与源仓库不一致的文件清单（空数组表示没有漂移） */
export function detectDrift() {
    const drift = []
    // 比较时把行尾归一化：uview-plus4 是混合行尾，而 git 的 autocrlf 会在检出时改写行尾，
    // 不归一化的话新克隆的仓库会一直误报漂移
    const same = (left, right) => {
        if (left === null) return false
        return left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n')
    }
    const pages = buildTargets()
    for (const page of pages) {
        const absolute = path.join(ROOT, 'src', page.relativePath)
        const existing = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null
        if (!same(existing, page.content)) drift.push(rel(absolute))
    }
    if (!fs.existsSync(TARGET_PAGES_JSON)) {
        drift.push(rel(TARGET_PAGES_JSON))
    } else if (!same(fs.readFileSync(TARGET_PAGES_JSON, 'utf8'), buildPagesJson(pages))) {
        drift.push(rel(TARGET_PAGES_JSON))
    }
    const manifest = buildManifest(pages)
    if (!fs.existsSync(TARGET_MANIFEST)) {
        drift.push(rel(TARGET_MANIFEST))
    } else if (!same(fs.readFileSync(TARGET_MANIFEST, 'utf8'), manifest)) {
        drift.push(rel(TARGET_MANIFEST))
    }
    return drift
}

function main() {
    if (!fs.existsSync(SOURCE_PAGES)) {
        console.error('找不到示例页源目录：' + SOURCE_PAGES)
        console.error('用 --source <uview-plus4 路径> 指定源仓库。')
        process.exit(1)
    }

    const pages = buildTargets()

    for (const page of pages) {
        emit(page.relativePath, page.content)
    }

    const pagesJson = buildPagesJson(pages)
    const manifest = buildManifest(pages)
    const existingPagesJson = fs.existsSync(TARGET_PAGES_JSON)
        ? fs.readFileSync(TARGET_PAGES_JSON, 'utf8')
        : null
    const existingManifest = fs.existsSync(TARGET_MANIFEST) ? fs.readFileSync(TARGET_MANIFEST, 'utf8') : null

    if (CHECK_ONLY) {
        if (existingPagesJson !== pagesJson) problems.push('与源仓库不一致：' + rel(TARGET_PAGES_JSON))
        if (existingManifest !== manifest) problems.push('与源仓库不一致：' + rel(TARGET_MANIFEST))
    } else {
        fs.writeFileSync(TARGET_PAGES_JSON, pagesJson)
        fs.mkdirSync(path.dirname(TARGET_MANIFEST), { recursive: true })
        fs.writeFileSync(TARGET_MANIFEST, manifest)
    }

    console.log((CHECK_ONLY ? '检查' : '同步') + '示例页：' + pages.length + ' 个页面')
    console.log('源仓库：' + SOURCE_PAGES)
    console.log('跳过 ' + skipped.length + ' 个文件（.nvue / .uts 等不参与 Vue3 链路）')

    if (problems.length > 0) {
        console.log('')
        for (const problem of problems) console.log('  ✗ ' + problem)
        console.log('')
        console.log('sync-demo-pages: FAILED')
        process.exit(1)
    }

    console.log('')
    console.log('sync-demo-pages: ' + (CHECK_ONLY ? 'OK（无漂移）' : 'OK'))
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) main()
