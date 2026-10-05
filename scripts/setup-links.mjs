#!/usr/bin/env node
/**
 * 决定 uview-plus4-vue3 用哪一份 uview-ultra 源码，以及示例资源从哪来。
 *
 * 两种「库源」：
 *   link（默认）—— src/uni_modules/uview-ultra 是指向 ../uview-plus4/uni_modules/uview-ultra
 *                  的目录联接，改源码即时生效，适合改库的时候用。
 *   npm          —— 把 npm 上发布的包解压到 src/uni_modules/uview-ultra，
 *                  这样门禁与逐页冒烟验证的是「线上发布物」，
 *                  能抓出「改了没提交 / 提交了没发版」这类问题。
 *
 * 两种模式下 src/static、src/common 都是指向 ../uview-plus4 的目录联接
 * （示例页的图片与省市区数据只存在于那个仓库里，npm 包不含这些）。
 *
 * 用法：
 *   node scripts/setup-links.mjs                        # 切到联接模式
 *   node scripts/setup-links.mjs --from-npm             # 切到 npm 包，默认取 package.json 的 uvLib.npmSpec
 *   node scripts/setup-links.mjs --from-npm uview-ultra@4.5.46
 *   node scripts/setup-links.mjs --status                # 只看当前是哪种模式
 *   node scripts/setup-links.mjs --source <uview-plus4 路径>
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB_DIR = path.join(ROOT, 'src', 'uni_modules', 'uview-ultra')
const TMP_DIR = path.join(ROOT, 'cachePath', 'npm-extract')
const LOG_PATH = path.join(ROOT, 'cachePath', 'setup-links.log')

const sourceIndex = process.argv.indexOf('--source')
const SOURCE_ROOT = sourceIndex === -1
    ? path.resolve(ROOT, '..', 'uview-plus4')
    : path.resolve(process.argv[sourceIndex + 1])

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const DEFAULT_NPM_SPEC = (pkg.uvLib && pkg.uvLib.npmSpec) || 'uview-ultra@latest'

/** 示例资源永远指向 uview-plus4 仓库 */
const ASSET_LINKS = [
    { link: path.join(ROOT, 'src', 'static'), target: path.join(SOURCE_ROOT, 'static'), label: '示例静态资源' },
    { link: path.join(ROOT, 'src', 'common'), target: path.join(SOURCE_ROOT, 'common'), label: '示例数据与 demo.scss' },
]

const rel = (target) => path.relative(ROOT, target).split(path.sep).join('/')

function isJunction(target) {
    try {
        return fs.lstatSync(target).isSymbolicLink()
    } catch {
        return false
    }
}

function readLibVersion() {
    try {
        return JSON.parse(fs.readFileSync(path.join(LIB_DIR, 'package.json'), 'utf8')).version
    } catch {
        return '(读不到)'
    }
}

/** spawnSync 带 pipe 会被本机杀软拦成 EBUSY，输出必须走文件描述符 */
function run(command, args, cwd) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    const fd = fs.openSync(LOG_PATH, 'w')
    const isWin = process.platform === 'win32'
    const result = spawnSync(isWin ? command + '.cmd' : command, args, {
        cwd,
        stdio: ['ignore', fd, fd],
        shell: isWin && command === 'npm',
    })
    fs.closeSync(fd)
    return {
        ok: result.status === 0,
        log: fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8').trim() : '',
        error: result.error ? String(result.error.message || result.error) : '',
    }
}

function reportFailure(title, result) {
    console.log('✗ ' + title)
    if (result.error) console.log('    进程错误：' + result.error)
    const lines = result.log.split('\n').filter(Boolean).slice(-8)
    if (lines.length > 0) {
        console.log(lines.map((line) => '    ' + line).join('\n'))
    }
}

function removeLibDir() {
    if (!fs.existsSync(LIB_DIR) && !isJunction(LIB_DIR)) return
    fs.rmSync(LIB_DIR, { recursive: true, force: true })
}

function setupAssetLinks() {
    let failed = 0
    for (const { link, target, label } of ASSET_LINKS) {
        if (!fs.existsSync(target)) {
            console.log('  ✗ ' + label + '：源目录不存在 ' + target)
            failed += 1
            continue
        }
        if (isJunction(link)) {
            let already = false
            try {
                already = path.resolve(fs.readlinkSync(link)) === path.resolve(target)
            } catch {
                already = false // 断链，重建
            }
            if (already) {
                console.log('  · ' + rel(link) + '（已就绪）')
                continue
            }
            fs.unlinkSync(link)
        } else if (fs.existsSync(link)) {
            console.log('  ✗ ' + rel(link) + ' 已存在且不是目录联接，请先自行处理')
            failed += 1
            continue
        }
        fs.mkdirSync(path.dirname(link), { recursive: true })
        fs.symlinkSync(target, link, 'junction')
        console.log('  ✓ ' + rel(link) + ' → ' + target)
    }
    return failed
}

function switchToLink() {
    const target = path.join(SOURCE_ROOT, 'uni_modules', 'uview-ultra')
    if (!fs.existsSync(target)) {
        console.log('✗ 源目录不存在：' + target)
        return 1
    }
    removeLibDir()
    fs.mkdirSync(path.dirname(LIB_DIR), { recursive: true })
    fs.symlinkSync(target, LIB_DIR, 'junction')
    console.log('✓ 库源 = link   ' + rel(LIB_DIR) + ' → ' + target)
    return 0
}

function switchToNpm(spec) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
    fs.mkdirSync(TMP_DIR, { recursive: true })

    const packed = run('npm', ['pack', spec, '--pack-destination', TMP_DIR, '--silent'], ROOT)
    if (!packed.ok) {
        reportFailure('npm pack ' + spec + ' 失败：', packed)
        return 1
    }
    const tarballs = fs.readdirSync(TMP_DIR).filter((name) => name.endsWith('.tgz'))
    if (tarballs.length !== 1) {
        console.log('✗ 期望恰好一个 .tgz，实际 ' + tarballs.length + ' 个：' + tarballs.join(', '))
        return 1
    }

    // 用 npm 自己装这个 tarball，而不是调 tar：
    // Git Bash 的 PATH 是 POSIX 形式（/usr/bin），Windows 原生的 spawnSync 解析不到 tar.exe。
    const tarball = path.join(TMP_DIR, tarballs[0])
    const installed = run('npm', [
        'install', tarball,
        '--prefix', TMP_DIR,
        '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error',
    ], ROOT)
    if (!installed.ok) {
        reportFailure('从 tarball 安装失败：', installed)
        return 1
    }
    const extracted = path.join(TMP_DIR, 'node_modules', 'uview-ultra')
    if (!fs.existsSync(extracted)) {
        console.log('✗ 安装后没有找到 ' + extracted)
        return 1
    }

    removeLibDir()
    fs.mkdirSync(LIB_DIR, { recursive: true })
    fs.cpSync(extracted, LIB_DIR, { recursive: true, dereference: true })
    console.log('✓ 库源 = npm    ' + rel(LIB_DIR) + ' ← ' + tarballs[0] + '（uview-ultra@' + readLibVersion() + '）')
    console.log('  提示：此时门禁验证的是线上发布物，改 uview-plus4 的源码不会体现在这里。')
    return 0
}

function status() {
    if (isJunction(LIB_DIR)) {
        const target = fs.existsSync(LIB_DIR) ? fs.readlinkSync(LIB_DIR) : '(断链)'
        console.log('库源: link → ' + target)
        console.log('版本: uview-ultra@' + readLibVersion())
    } else if (fs.existsSync(LIB_DIR)) {
        console.log('库源: npm  （已解压到工作区，不是联接）')
        console.log('版本: uview-ultra@' + readLibVersion())
    } else {
        console.log('库源: 未设置，跑一次 node scripts/setup-links.mjs 或 --from-npm')
    }
}

let failed = 0

if (process.argv.includes('--status')) {
    status()
} else if (process.argv.includes('--from-npm')) {
    const at = process.argv.indexOf('--from-npm')
    const next = process.argv[at + 1]
    const spec = next && !next.startsWith('--') ? next : DEFAULT_NPM_SPEC
    console.log('切到 npm 库源：' + spec)
    failed += switchToNpm(spec)
} else {
    failed += switchToLink()
}

console.log('')
console.log('示例资源（两种库源下都指向 uview-plus4）：')
failed += setupAssetLinks()

console.log('')
console.log('setup-links: ' + (failed === 0 ? 'OK' : 'FAILED（' + failed + ' 项）'))
process.exit(failed === 0 ? 0 : 1)