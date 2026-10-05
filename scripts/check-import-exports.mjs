#!/usr/bin/env node
/**
 * 检查 uview-ultra 的 Vue3 侧（.js / .vue）里「导入的名字对方到底有没有导出」。
 *
 * 为什么需要：`.vue` / `.js` 之间互相 import，如果某个函数只在 `.uts` 孪生文件里有、
 * `.js` 侧漏了，编译期不会报错，直到 Rollup 打包时才抛出
 * `"xxx" is not exported by "..."`，而且一次只报一个。这个脚本一次性列全。
 *
 * 用法：
 *   node scripts/check-import-exports.mjs
 *   node scripts/check-import-exports.mjs --source <uview-ultra 路径>
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceIndex = process.argv.indexOf('--source')
const LIB = sourceIndex === -1
    ? path.resolve(ROOT, '..', 'uview-plus4', 'uni_modules', 'uview-ultra')
    : path.resolve(process.argv[sourceIndex + 1])

const RESOLVE_SUFFIXES = ['', '.js', '.vue', '/index.js']

function exists(target) {
    try {
        return fs.statSync(target).isFile()
    } catch {
        return false
    }
}

function resolveSpecifier(fromFile, specifier) {
    if (!specifier.startsWith('.')) return null
    const base = path.resolve(path.dirname(fromFile), specifier)
    for (const suffix of RESOLVE_SUFFIXES) {
        if (exists(base + suffix)) return base + suffix
    }
    return null
}

function walk(dir, out = []) {
    // 显式排序：readdirSync 的顺序依赖文件系统，Windows 与 Linux 不一致
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
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

function scriptOf(file, source) {
    if (!file.endsWith('.vue')) return source
    const match = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)
    return match ? match[1] : ''
}

/** 收集一个模块导出的具名符号；`export * from` 会递归展开 */
function collectExports(file, seen = new Set()) {
    const names = new Set()
    let hasDefault = false
    if (!file || seen.has(file)) return { names, hasDefault }
    seen.add(file)

    const source = scriptOf(file, fs.readFileSync(file, 'utf8'))
    for (const match of source.matchAll(/export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(match[1])
    }
    for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of match[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop().trim()
            if (name) names.add(name)
        }
    }
    if (/export\s+default\b/.test(source)) hasDefault = true
    for (const match of source.matchAll(/export\s+\*\s+from\s+(['"])([^'"]+)\1/g)) {
        const target = resolveSpecifier(file, match[2])
        if (!target) continue
        const nested = collectExports(target, seen)
        for (const name of nested.names) names.add(name)
        if (nested.hasDefault) hasDefault = true
    }
    return { names, hasDefault }
}

/** 供门禁调用：返回 { fileCount, problems } */
export function checkImportExports(libRoot = LIB) {
    const problems = []
    const files = walk(libRoot)

    for (const file of files) {
        const source = scriptOf(file, fs.readFileSync(file, 'utf8'))
        for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g)) {
            const clause = match[1].trim()
            const specifier = match[3]
            const target = resolveSpecifier(file, specifier)
            if (!target) continue
            const exported = collectExports(target)

            const namedMatch = clause.match(/\{([^}]*)\}/)
            if (namedMatch) {
                for (const part of namedMatch[1].split(',')) {
                    const raw = part.trim()
                    if (!raw) continue
                    const name = raw.split(/\s+as\s+/)[0].trim()
                    if (name && !exported.names.has(name)) {
                        problems.push({ file, specifier, target, name })
                    }
                }
            }
            // 默认导出不做检查：SFC（.vue）与打包好的第三方 bundle 用正则都识别不准，
            // 真缺默认导出时 Rollup 会直接报错，不必在这里制造噪声。
        }
    }

    return { fileCount: files.length, problems }
}

function rel(target) {
    return path.relative(ROOT, target).split(path.sep).join('/')
}

function main() {
    const { fileCount, problems } = checkImportExports()
    console.log('检查 ' + fileCount + ' 个 Vue3 侧文件的导入导出一致性')
    if (problems.length === 0) {
        console.log('')
        console.log('check-import-exports: OK')
        return
    }

    for (const problem of problems) {
        console.log('  ✗ ' + rel(problem.file))
        console.log('      导入 ' + problem.name + ' from \'' + problem.specifier + '\'，但 ' + rel(problem.target) + ' 没有导出它')
    }
    console.log('')
    console.log('check-import-exports: FAILED（' + problems.length + ' 处）')
    process.exitCode = 1
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) main()
