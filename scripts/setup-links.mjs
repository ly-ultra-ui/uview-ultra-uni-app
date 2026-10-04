#!/usr/bin/env node
/**
 * 建立本工程对 uview-plus4 的目录联接（Windows junction）。
 *
 * 本工程不复制 uview-ultra 源码和示例静态资源，全部用 junction 指回 uview-plus4，
 * 这样改一处两边即时生效，也不会出现两份代码漂移。
 *
 *   src/uni_modules/uview-ultra  →  <uview-plus4>/uni_modules/uview-ultra
 *   src/static                   →  <uview-plus4>/static
 *
 * 用法：
 *   node scripts/setup-links.mjs
 *   node scripts/setup-links.mjs --source <uview-plus4 路径>
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceIndex = process.argv.indexOf('--source')
const SOURCE_ROOT = sourceIndex === -1
    ? path.resolve(ROOT, '..', 'uview-plus4')
    : path.resolve(process.argv[sourceIndex + 1])

const LINKS = [
    { link: path.join(ROOT, 'src', 'uni_modules', 'uview-ultra'), target: path.join(SOURCE_ROOT, 'uni_modules', 'uview-ultra') },
    { link: path.join(ROOT, 'src', 'static'), target: path.join(SOURCE_ROOT, 'static') },
    { link: path.join(ROOT, 'src', 'common'), target: path.join(SOURCE_ROOT, 'common') },
]

let failed = 0

for (const { link, target } of LINKS) {
    const display = path.relative(ROOT, link).split(path.sep).join('/')
    if (!fs.existsSync(target)) {
        console.log('✗ 目标不存在：' + target)
        failed += 1
        continue
    }
    if (fs.existsSync(link) || isBrokenLink(link)) {
        const stat = fs.lstatSync(link)
        if (stat.isSymbolicLink() && path.resolve(fs.readlinkSync(link)) === path.resolve(target)) {
            console.log('· 已就绪：' + display)
            continue
        }
        if (!stat.isSymbolicLink()) {
            console.log('✗ ' + display + ' 已存在且不是目录联接，请先自行处理')
            failed += 1
            continue
        }
        fs.unlinkSync(link)
    }
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(target, link, 'junction')
    console.log('✓ 已建立：' + display + ' → ' + target)
}

console.log('')
console.log('setup-links: ' + (failed === 0 ? 'OK' : 'FAILED（' + failed + ' 项）'))
process.exit(failed === 0 ? 0 : 1)

function isBrokenLink(target) {
    try {
        return fs.lstatSync(target).isSymbolicLink() && !fs.existsSync(fs.realpathSync(target))
    } catch {
        return false
    }
}
