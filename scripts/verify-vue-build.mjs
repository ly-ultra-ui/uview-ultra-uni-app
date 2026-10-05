#!/usr/bin/env node
/**
 * uview-ultra · uni-app Vue3 编译门禁
 *
 * 目的：把「uview-ultra 的 .vue / .js 那一套实现能不能真的被 uni-app Vue3 编译链吃下」
 * 变成一条可重复执行的检查。这套实现在 uview-plus4（uni-app x 工程）里从不参与编译，
 * 所以任何编译错误、缺失导出、未声明变量都只能靠用户反馈才发现。
 *
 * 六段检查：
 *   A. 示例页漂移检查     —— 比对 src/pages 与 uview-plus4/pages 是否同步
 *   B. 导入解析检查       —— 省略扩展名却存在 .uts 孪生（uni-app 的 resolve.extensions 把 .uts 排第一）、
 *                          以及导入的名字对方模块根本没导出
 *   C. SFC 全量编译扫描   —— 逐个用 @vue/compiler-sfc 编译库组件与示例页的全部 .vue
 *   D. 未声明标识符扫描   —— 用 @babel/traverse 做 no-undef，抓 `crtProp` / `UpNoNetwork` 这类
 *                          只有运行到才会炸、编译器又不管的问题
 *   E. 模块加载冒烟       —— 用 Node 逐个 import libs/** 与 components/** 下的 .js，
 *                          抓「引用了不存在的导出」这类模块解析期错误
 *   F. 真实构建           —— 跑一次 uni build（H5），确认整条链路能过
 *
 * 用法：
 *   node scripts/verify-vue-build.mjs                # A ~ F
 *   node scripts/verify-vue-build.mjs --modules-only # 只跑 A ~ E
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import babelParser from '@babel/parser'
import babelTraverse from '@babel/traverse'
import { compileScript, compileTemplate, parse as parseSfc } from 'vue/compiler-sfc'

import { detectDrift, describeDrift } from './sync-demo-pages.mjs'
import { checkImportExports } from './check-import-exports.mjs'
import { scanImportExtensions } from './fix-vue-import-extensions.mjs'

const traverse = babelTraverse.default || babelTraverse

// 让 Node 也能解析省略扩展名 / 目录导入，避免把解析差异误报成组件 bug
register('./node-esm-resolve-hook.mjs', import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = path.join(ROOT, 'src', 'uni_modules', 'uview-ultra')
const COMPONENTS = path.join(LIB, 'components')
const DEMO_PAGES = path.join(ROOT, 'src', 'pages')
const MODULES_ONLY = process.argv.includes('--modules-only')
const PLATFORM = process.env.VERIFY_PLATFORM || 'H5'

const SKIP_DIRS = new Set(['node_modules', 'luch-request', 'marked-uts', 'vite'])
const SKIP_JS_FILES = new Set([path.join(LIB, 'index.js')])

/** 条件编译的平台开关；uview-ultra 的源码里大量使用 #ifdef，必须先按平台裁剪再解析 */
const PLATFORM_FLAGS = {
    H5: new Set(['H5', 'WEB', 'VUE3', 'UNI-APP-VUE3']),
    'mp-weixin': new Set(['MP', 'MP-WEIXIN', 'VUE3', 'UNI-APP-VUE3']),
    app: new Set(['APP-PLUS', 'APP-VUE', 'APP-ANDROID', 'APP-IOS', 'VUE3', 'UNI-APP-VUE3']),
}

const ALLOWED_GLOBALS = new Set([
    // JS 语言内置
    'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'DataView', 'Date', 'Error', 'EvalError',
    'Float32Array', 'Float64Array', 'Function', 'Infinity', 'Int16Array', 'Int32Array',
    'Int8Array', 'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise',
    'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'String', 'Symbol',
    'SyntaxError', 'TypeError', 'URIError', 'Uint16Array', 'Uint32Array', 'Uint8Array',
    'Uint8ClampedArray', 'WeakMap', 'WeakSet', 'decodeURI', 'decodeURIComponent', 'encodeURI',
    'encodeURIComponent', 'escape', 'eval', 'globalThis', 'isFinite', 'isNaN', 'parseFloat',
    'parseInt', 'undefined', 'unescape', 'arguments', 'atob', 'btoa', 'structuredClone',
    // 运行时宿主
    'console', 'process', 'require', 'module', 'exports', 'Buffer', 'global',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
    'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
    'performance', 'crypto', 'fetch', 'AbortController', 'TextEncoder', 'TextDecoder',
    'URL', 'URLSearchParams', 'Blob', 'FormData', 'FileReader', 'Image', 'Audio',
    'XMLHttpRequest', 'WebSocket', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
    // 浏览器 / 小程序 / App 宿主
    'window', 'document', 'navigator', 'location', 'history', 'screen', 'localStorage',
    'sessionStorage', 'getComputedStyle', 'alert', 'confirm', 'prompt', 'self', 'top',
    'parent', 'frames', 'customElements', 'HTMLElement', 'Element', 'Node', 'Event',
    'CustomEvent', 'CSS', 'ImageData', 'CanvasRenderingContext2D',
    // uni-app
    'uni', 'wx', 'my', 'swan', 'tt', 'qq', 'ks', 'jd', 'getApp', 'getCurrentPages',
    'plus', 'WeixinJSBridge', 'weex', 'App', 'Page', 'Component', 'Behavior', '__uniConfig',
    '__uniRoutes', '__uniLayout', '__uniPageOrientation', '__uniFrameElement',
])

const sfcFindings = []
const conditionalFindings = []
const undefinedFindings = []
const moduleFindings = []
let buildResult = null

function relative(target) {
    return path.relative(ROOT, target).split(path.sep).join('/')
}

/**
 * 按「规范化后的相对路径」排序。不能直接排原始路径：
 * Windows 的分隔符是 \ (0x5C)、Linux 是 / (0x2F)，码点不同会让
 * table 与 table2 这类「目录名互为前缀」的先后顺序反过来，报告顺序就随平台变。
 */
function byRelativePath(left, right) {
    const a = relative(left)
    const b = relative(right)
    return a < b ? -1 : a > b ? 1 : 0
}

function walk(dir, predicate, out = []) {
    let entries
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return out
    }
    // 显式排序：readdirSync 的顺序依赖文件系统，Windows 与 Linux 不一致，
    // 不排序的话报错清单的顺序会随平台变化，CI 日志不好比对
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue
            walk(full, predicate, out)
        } else if (entry.isFile() && predicate(full)) {
            out.push(full)
        }
    }
    return out
}

function firstLine(error) {
    const message = error && error.message ? error.message : String(error)
    const text = message.split('\n')[0]
    const line = error && error.loc && error.loc.start ? error.loc.start.line : null
    return line ? text + '（第 ' + line + ' 行）' : text
}

/* ---------------------------------------------------------------- 条件编译裁剪 */

/**
 * 标记可能出现在行首（整行注释），也可能出现在行中间（例如
 * `} else /* #endif *\/ if (...)`），所以按「整行 + 行内」两种位置统一匹配。
 */
const MARKER_RE = /(?:\/\/|\/\*|<!--)\s*#(ifdef|ifndef|else|elif|endif)\b([^\n]*?)(?:\*\/|-->|$)/gi
const TOKEN_RE = /\(|\)|&&|\|\||!|[A-Za-z0-9_-]+/g

function tokenizeCondition(expression) {
    return expression.match(TOKEN_RE) || []
}

/** 支持 `||` `&&` `!` 和括号的小递归下降求值器 */
function evaluateCondition(expression, flags) {
    const tokens = tokenizeCondition(expression)
    let cursor = 0
    const peek = () => tokens[cursor]
    const eat = (token) => {
        if (tokens[cursor] === token) {
            cursor += 1
            return true
        }
        return false
    }
    const parsePrimary = () => {
        if (eat('(')) {
            const value = parseOr()
            eat(')')
            return value
        }
        const token = peek()
        if (token === undefined || token === ')' || token === '&&' || token === '||') return false
        cursor += 1
        return flags.has(token)
    }
    const parseUnary = () => (eat('!') ? !parseUnary() : parsePrimary())
    const parseAnd = () => {
        let value = parseUnary()
        while (eat('&&')) value = parseUnary() && value
        return value
    }
    const parseOr = () => {
        let value = parseAnd()
        while (eat('||')) value = parseAnd() || value
        return value
    }
    return parseOr()
}

/**
 * 按平台裁剪条件编译块。被裁掉的内容替换成空行，保持行号不变，
 * 这样后续报出来的错误行号仍然对应原始文件。
 * 返回 { code, unbalanced }，unbalanced > 0 表示源码里的 #ifdef / #endif 没有配对。
 */
function stripConditionalCompilation(source, platform) {
    const flags = PLATFORM_FLAGS[platform] || PLATFORM_FLAGS.H5
    const lines = source.split('\n')
    const output = new Array(lines.length).fill('')
    const stack = []
    const isActive = () => stack.every((frame) => frame.keep)

    lines.forEach((line, index) => {
        if (!line.includes('#')) {
            if (isActive()) output[index] = line
            return
        }

        MARKER_RE.lastIndex = 0
        let cursor = 0
        let kept = ''
        let match
        while ((match = MARKER_RE.exec(line))) {
            if (isActive()) kept += line.slice(cursor, match.index)
            cursor = match.index + match[0].length

            const kind = match[1].toLowerCase()
            const expression = (match[2] || '').trim()
            if (kind === 'ifdef' || kind === 'ifndef') {
                const matched = evaluateCondition(expression, flags)
                stack.push({ keep: kind === 'ifdef' ? matched : !matched, elseSeen: false })
            } else if (kind === 'else' || kind === 'elif') {
                const top = stack[stack.length - 1]
                if (top && !top.elseSeen) {
                    top.keep = kind === 'elif' ? evaluateCondition(expression, flags) : !top.keep
                    top.elseSeen = true
                }
            } else if (kind === 'endif') {
                stack.pop()
            }
        }
        if (isActive()) kept += line.slice(cursor)
        output[index] = kept
    })

    return { code: output.join('\n'), unbalanced: stack.length }
}

/** 小程序 wxs / renderjs 的 <script> 不是 Vue 组件脚本，解析前先摘掉（同样保留行号） */
function stripNonVueScripts(source) {
    return source.replace(
        /<script\b[^>]*\blang\s*=\s*["'](?:wxs|renderjs)["'][^>]*>[\s\S]*?<\/script\s*>/gi,
        (matched) => '\n'.repeat((matched.match(/\n/g) || []).length)
    )
}

function preprocess(source, platform) {
    const conditional = stripConditionalCompilation(source, platform)
    return {
        code: stripNonVueScripts(conditional.code),
        unbalanced: conditional.unbalanced,
    }
}

/* ------------------------------------------------------------------ A. SFC 全量编译扫描 */

/** 需要做 SFC 编译扫描的根目录：库组件 + 由 sync-demo-pages 生成的示例页 */
const SFC_SCOPE_ROOTS = [
    { label: '库组件', dir: COMPONENTS },
    { label: '示例页', dir: DEMO_PAGES },
]

function scanSfcFiles() {
    const files = []
    for (const scope of SFC_SCOPE_ROOTS) {
        for (const file of walk(scope.dir, (target) => target.endsWith('.vue'))) {
            files.push({ file, scope: scope.label })
        }
    }
    files.sort((left, right) => (left.file < right.file ? -1 : 1))

    for (const { file, scope } of files) {
        const preprocessed = preprocess(fs.readFileSync(file, 'utf8'), PLATFORM)
        if (preprocessed.unbalanced > 0) {
            conditionalFindings.push({
                file,
                message: '有 ' + preprocessed.unbalanced + ' 个 #ifdef / #ifndef 没有对应的 #endif',
            })
        }
        const source = preprocessed.code
        const id = 'smoke-' + path.basename(file, '.vue')
        let descriptor
        try {
            const parsed = parseSfc(source, { filename: file })
            descriptor = parsed.descriptor
            for (const error of parsed.errors) {
                sfcFindings.push({ file, scope, stage: 'parse', message: firstLine(error) })
            }
        } catch (error) {
            sfcFindings.push({ file, scope, stage: 'parse', message: firstLine(error) })
            continue
        }

        if (descriptor.script || descriptor.scriptSetup) {
            try {
                compileScript(descriptor, { id })
            } catch (error) {
                sfcFindings.push({ file, scope, stage: 'script', message: firstLine(error) })
            }
        }

        if (descriptor.template) {
            try {
                const result = compileTemplate({
                    source: descriptor.template.content,
                    filename: file,
                    id,
                })
                for (const error of result.errors) {
                    sfcFindings.push({ file, scope, stage: 'template', message: firstLine(error) })
                }
            } catch (error) {
                sfcFindings.push({ file, scope, stage: 'template', message: firstLine(error) })
            }
        }
    }
    return files.length
}

/* ------------------------------------------------- B. 未声明标识符扫描（no-undef） */

function scanUndefinedIdentifiers() {
    const files = walk(LIB, (file) => file.endsWith('.js') && !SKIP_JS_FILES.has(file)).sort(byRelativePath)
    for (const file of files) {
        const source = preprocess(fs.readFileSync(file, 'utf8'), PLATFORM).code
        let ast
        try {
            ast = babelParser.parse(source, {
                sourceType: 'module',
                allowAwaitOutsideFunction: true,
                plugins: ['jsx', 'classProperties', 'classPrivateProperties', 'classPrivateMethods'],
            })
        } catch (error) {
            undefinedFindings.push({ file, name: '(解析失败)', message: firstLine(error) })
            continue
        }
        const names = new Set()
        traverse(ast, {
            ReferencedIdentifier(nodePath) {
                const name = nodePath.node.name
                if (ALLOWED_GLOBALS.has(name)) return
                if (nodePath.scope.getBinding(name)) return
                names.add(name)
            },
        })
        for (const name of names) {
            undefinedFindings.push({ file, name, message: '未声明的标识符' })
        }
    }
    return files.length
}

/* ------------------------------------------------------------ C. 模块加载冒烟 */

function makeStub(name) {
    const target = function stubTarget() {}
    return new Proxy(target, {
        get(_target, key) {
            if (key === 'then') return undefined
            if (key === Symbol.toPrimitive) return () => ''
            if (key === Symbol.iterator) return function* emptyIterator() {}
            if (key === Symbol.toStringTag) return 'HostStub'
            if (key === 'valueOf') return () => 0
            if (key === 'toString') return () => ''
            if (key === 'toJSON') return () => null
            if (key === 'length') return 0
            if (key === 'name') return name
            return makeStub(name + '.' + String(key))
        },
        apply() {
            return makeStub(name + '()')
        },
        construct() {
            return makeStub('new ' + name)
        },
        has() {
            return true
        },
    })
}

function installHostStubs() {
    const hosts = [
        'uni', 'wx', 'my', 'swan', 'tt', 'qq', 'ks', 'jd', 'window', 'document', 'navigator',
        'location', 'history', 'screen', 'localStorage', 'sessionStorage', 'plus', 'WeixinJSBridge',
    ]
    for (const host of hosts) {
        try {
            Object.defineProperty(globalThis, host, {
                value: makeStub(host),
                configurable: true,
                writable: true,
            })
        } catch {
            // 某些宿主全局（如 navigator）在 Node 里是只读访问器，跳过即可
        }
    }
    globalThis.getApp = () => makeStub('getApp()')
    globalThis.getCurrentPages = () => []
}

async function smokeModules() {
    const files = walk(LIB, (file) => file.endsWith('.js') && !SKIP_JS_FILES.has(file)).sort(byRelativePath)
    let skipped = 0
    for (const file of files) {
        const raw = fs.readFileSync(file, 'utf8')
        // 含条件编译的文件在 Node 里不是合法源码（分支被裁剪后才是），静态扫描已覆盖，这里跳过
        if (preprocess(raw, PLATFORM).code !== raw) {
            skipped += 1
            continue
        }
        try {
            await import(pathToFileURL(file).href)
        } catch (error) {
            moduleFindings.push({ file, message: firstLine(error) })
        }
    }
    return { total: files.length, skipped }
}

/* ------------------------------------------------------------------ D. 真实构建 */

function runBuild() {
    const uniBin = path.join(ROOT, 'node_modules', '@dcloudio', 'vite-plugin-uni', 'bin', 'uni.js')
    if (!fs.existsSync(uniBin)) {
        return { ok: false, tail: ['未找到 ' + relative(uniBin) + '，请先执行 pnpm install'], code: null }
    }

    // 本机杀软会拦截管道创建（spawnSync 带 pipe 会直接 EBUSY），所以把 stdout/stderr 落到文件描述符上
    const logPath = path.join(ROOT, '.verify-build.log')
    const logFd = fs.openSync(logPath, 'w')
    let result
    try {
        result = spawnSync(process.execPath, [uniBin, 'build'], {
            cwd: ROOT,
            stdio: ['ignore', logFd, logFd],
        })
    } finally {
        fs.closeSync(logFd)
    }

    const output = fs.readFileSync(logPath, 'utf8')
    const lines = output.split('\n').map((line) => line.trimEnd()).filter(Boolean)
    if (result.error) {
        lines.push('构建进程无法启动：' + firstLine(result.error))
    }
    if (result.signal) {
        lines.push('构建进程被信号中断：' + result.signal)
    }
    if (output.includes('SAFE_DELETE_BULK_CONFIRM_REQUIRED')) {
        lines.push('提示：这是沙箱的批量删除保护拦住了 uni build 清空 dist/build/h5/assets，')
        lines.push('      不是代码问题。先删掉 dist 再跑一次即可（rm -rf dist）。')
    }
    return {
        ok: result.status === 0,
        tail: lines.slice(-30),
        code: result.status,
        logPath: relative(logPath),
    }
}

/* ------------------------------------------------------------------ 报告 */

function printSection(title) {
    console.log('')
    console.log('=== ' + title + ' ===')
}

function printFindings(findings, describe) {
    for (const finding of findings) {
        const scope = finding.scope ? '[' + finding.scope + '] ' : ''
        console.log('  ✗ ' + scope + relative(finding.file))
        console.log('      ' + describe(finding))
    }
}

async function main() {
    const started = Date.now()
    console.log('uview-ultra · uni-app Vue3 编译门禁')
    console.log('库源码：' + relative(LIB))

    printSection('A. 示例页漂移检查')
    let drift = []
    try {
        drift = detectDrift()
    } catch (error) {
        drift = [{ file: '无法比对示例页：' + firstLine(error), expected: '', actual: null }]
    }
    if (drift.length === 0) {
        console.log('示例页与 uview-plus4/pages 一致')
    } else {
        console.log('示例页与源仓库不一致，执行 pnpm sync:demo 重新生成：')
        for (const item of drift) {
            console.log('  ✗ ' + item.file)
            // 打印第一处不同：CI 与本地不一致时（换行、路径分隔符、顺序）一眼能定位
            for (const line of describeDrift(item)) console.log('      ' + line)
        }
    }

    printSection('B. 导入解析检查')
    const extensionScan = scanImportExtensions()
    const exportCheck = checkImportExports()
    console.log('省略扩展名但存在 .uts 孪生：' + extensionScan.ambiguous.length + ' 处')
    for (const item of extensionScan.ambiguous.slice(0, 10)) {
        console.log('  ✗ ' + relative(item.file) + '  →  ' + item.specifier)
    }
    for (const item of extensionScan.missing) {
        console.log('  ! ' + relative(item.file) + '  →  ' + item.specifier + '（' + item.reason + '）')
    }
    console.log('导入的名字对方没有导出：' + exportCheck.problems.length + ' 处')
    for (const problem of exportCheck.problems.slice(0, 10)) {
        console.log('  ✗ ' + relative(problem.file))
        console.log('      导入 ' + problem.name + ' from \'' + problem.specifier + '\'，但 '
            + relative(problem.target) + ' 没有导出它')
    }

    printSection('C. SFC 全量编译扫描')
    const vueCount = scanSfcFiles()
    console.log('扫描 ' + vueCount + ' 个 .vue 文件，发现 ' + sfcFindings.length + ' 个编译错误')
    printFindings(sfcFindings, (finding) => '[' + finding.stage + '] ' + finding.message)
    if (conditionalFindings.length > 0) {
        console.log('  另有 ' + conditionalFindings.length + ' 个文件的条件编译指令不配对：')
        printFindings(conditionalFindings, (finding) => finding.message)
    }

    printSection('D. 未声明标识符扫描')
    const jsCount = scanUndefinedIdentifiers()
    console.log('扫描 ' + jsCount + ' 个 .js 文件，发现 ' + undefinedFindings.length + ' 处未声明标识符')
    printFindings(undefinedFindings, (finding) => finding.name + ' —— ' + finding.message)

    printSection('E. 模块加载冒烟')
    installHostStubs()
    const smoke = await smokeModules()
    console.log(
        '加载 ' + (smoke.total - smoke.skipped) + ' 个 .js 模块（跳过 ' + smoke.skipped
        + ' 个含条件编译的文件），失败 ' + moduleFindings.length + ' 个'
    )
    printFindings(moduleFindings, (finding) => finding.message)

    if (!MODULES_ONLY) {
        printSection('F. 真实构建（uni build · H5）')
        buildResult = runBuild()
        for (const line of buildResult.tail) {
            console.log('  | ' + line)
        }
        console.log(buildResult.ok ? '  构建通过' : '  构建失败（退出码 ' + buildResult.code + '）')
        if (buildResult.logPath) {
            console.log('  完整构建日志：' + buildResult.logPath)
        }
    }

    const blocking = drift.length + extensionScan.ambiguous.length + extensionScan.missing.length
        + exportCheck.problems.length + sfcFindings.length + conditionalFindings.length
        + undefinedFindings.length + moduleFindings.length + (buildResult && !buildResult.ok ? 1 : 0)

    printSection('结论')
    console.log('示例页漂移        : ' + drift.length)
    console.log('扩展名歧义        : ' + extensionScan.ambiguous.length)
    console.log('缺失导出          : ' + exportCheck.problems.length)
    console.log('SFC 编译错误      : ' + sfcFindings.length)
    console.log('条件编译不配对    : ' + conditionalFindings.length)
    console.log('未声明标识符      : ' + undefinedFindings.length)
    console.log('模块加载失败      : ' + moduleFindings.length)
    if (!MODULES_ONLY) {
        console.log('H5 构建           : ' + (buildResult.ok ? '通过' : '失败'))
    }
    console.log('耗时              : ' + ((Date.now() - started) / 1000).toFixed(1) + 's')

    if (blocking > 0) {
        console.log('')
        console.log('verify-vue-build: FAILED —— uview-ultra 的 uni-app Vue3 链路存在问题')
        process.exit(1)
    }
    console.log('')
    console.log('verify-vue-build: OK —— uview-ultra 的 uni-app Vue3 链路编译通过')
}

main().catch((error) => {
    console.error('verify-vue-build: 运行异常')
    console.error(error)
    process.exit(1)
})
