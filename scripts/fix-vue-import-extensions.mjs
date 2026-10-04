#!/usr/bin/env node
/**
 * 给 uview-ultra 的 Vue3 侧（.js / .vue）补全相对导入的扩展名。
 *
 * 为什么必须补：uni-app 的 `resolve.extensions` 是
 *   ['.uts', '.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue', '.nvue', '.uvue']
 * ——`.uts` 排在**最前面**，而且非 uni-app x 构建也是这个顺序
 * （见 @dcloudio/uni-cli-shared/dist/constants.js 的 COMMON_EXTENSIONS）。
 *
 * 于是 `import { defineMixin } from '../../libs/vue'` 在 Vue3 工程里会解析到 `libs/vue.uts`，
 * 被 esbuild 当成 UTS 去解析而失败。凡是「同名 .js 与 .uts 并存、导入又没写扩展名」的地方都会踩。
 *
 * 处理方式：只在这些**真正有歧义**的地方补 `.js`，其余导入一律不动。
 *
 * 用法：
 *   node scripts/fix-vue-import-extensions.mjs            # 就地修复
 *   node scripts/fix-vue-import-extensions.mjs --check    # 只检查，有歧义则退出码 1
 *   node scripts/fix-vue-import-extensions.mjs --source <uview-ultra 路径>
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.includes('--check')
const sourceIndex = process.argv.indexOf('--source')
const LIB = sourceIndex === -1
    ? path.resolve(ROOT, '..', 'uview-plus4', 'uni_modules', 'uview-ultra')
    : path.resolve(process.argv[sourceIndex + 1])

const SPECIFIER_RE = /(?:from\s+|import\(\s*)(['"])(\.[^'"]+)\1/g

function exists(target) {
    try {
        return fs.statSync(target).isFile()
    } catch {
        return false
    }
}

function isDirectory(target) {
    try {
        return fs.statSync(target).isDirectory()
    } catch {
        return false
    }
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue
            walk(full, out)
        } else if (entry.isFile() && /\.(js|vue)$/.test(entry.name)) {
            out.push(full)
        }
    }
    return out
}

function rel(target) {
    return path.relative(ROOT, target).split(path.sep).join('/')
}

const changed = []
const ambiguous = []
const missing = []

/** 解析顺序里 .uts 抢在 .js 前面，所以只要同名 .uts 存在，就必须显式写 .js */
function decide(base) {
    if (exists(base + '.uts')) {
        return exists(base + '.js') ? { next: '.js' } : { missing: '.uts 存在但缺 .js' }
    }
    if (isDirectory(base) && exists(base + '/index.uts')) {
        return exists(base + '/index.js') ? { next: '/index.js' } : { missing: 'index.uts 存在但缺 index.js' }
    }
    return null
}

/** 供门禁调用：只扫描不写盘，返回 { ambiguous, missing, plans } */
export function scanImportExtensions(libRoot = LIB) {
    const found = { ambiguous: [], missing: [], plans: [] }
    for (const file of walk(libRoot)) {
        const source = fs.readFileSync(file, 'utf8')
        const replacements = []
        SPECIFIER_RE.lastIndex = 0
        let match
        while ((match = SPECIFIER_RE.exec(source))) {
            const specifier = match[2]
            if (/\.[a-z]+$/.test(specifier)) continue
            const base = path.resolve(path.dirname(file), specifier)
            const decision = decide(base)
            if (!decision) continue
            if (decision.missing) {
                found.missing.push({ file, specifier, reason: decision.missing })
                continue
            }
            const start = match.index + match[0].length - specifier.length - 1
            replacements.push({ start, end: start + specifier.length, next: specifier + decision.next })
            found.ambiguous.push({ file, specifier })
        }
        if (replacements.length > 0) found.plans.push({ file, source, replacements })
    }
    return found
}

function main() {
    const { ambiguous, missing, plans } = scanImportExtensions()

    console.log((CHECK_ONLY ? '检查' : '修复') + '库：' + rel(LIB))
    console.log(
        '有歧义的省略扩展名导入：' + ambiguous.length + ' 处，分布在 '
        + new Set(ambiguous.map((item) => item.file)).size + ' 个文件'
    )
    if (missing.length > 0) {
        console.log('Vue3 侧缺实现的导入：' + missing.length + ' 处')
        for (const item of missing) {
            console.log('  ! ' + rel(item.file) + '  →  ' + item.specifier + '（' + item.reason + '）')
        }
    }

    if (CHECK_ONLY) {
        for (const item of ambiguous.slice(0, 20)) {
            console.log('  ✗ ' + rel(item.file) + '  →  ' + item.specifier)
        }
        if (ambiguous.length > 20) console.log('  …… 其余 ' + (ambiguous.length - 20) + ' 处省略')
        console.log('')
        console.log('fix-vue-import-extensions: ' + (ambiguous.length === 0 ? 'OK' : 'FAILED'))
        process.exitCode = ambiguous.length === 0 ? 0 : 1
        return
    }

    for (const plan of plans) {
        let output = ''
        let cursor = 0
        for (const item of plan.replacements) {
            output += plan.source.slice(cursor, item.start) + item.next
            cursor = item.end
        }
        output += plan.source.slice(cursor)
        fs.writeFileSync(plan.file, output)
        changed.push(plan.file)
    }
    for (const file of changed) console.log('  · ' + rel(file))
    console.log('')
    console.log('fix-vue-import-extensions: OK')
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) main()
