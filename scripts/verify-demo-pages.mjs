#!/usr/bin/env node
/**
 * 逐个打开示例页做运行时冒烟，收集控制台错误、页面异常、请求失败，并留截图。
 *
 * 前置：dev server 已启动（`pnpm dev:h5`，默认 http://localhost:5200）。
 *
 * 用法：
 *   node scripts/verify-demo-pages.mjs
 *   node scripts/verify-demo-pages.mjs --base http://localhost:5200
 *   node scripts/verify-demo-pages.mjs --only componentsA/button,componentsC/tabs
 *   node scripts/verify-demo-pages.mjs --no-screenshot
 *
 * playwright 解析顺序：环境变量 PLAYWRIGHT_MODULE → 本地依赖 → 托管 node 工作区。
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argOf = (name, fallback) => {
    const index = process.argv.indexOf(name)
    return index === -1 ? fallback : process.argv[index + 1]
}

const BASE = argOf('--base', 'http://localhost:5200')
const ONLY = argOf('--only', '')
const WANT_SCREENSHOT = !process.argv.includes('--no-screenshot')
const OUT_JSON = path.join(ROOT, '.demo-report.json')
const SHOT_DIR = path.join(ROOT, '.demo-screenshots')

function loadPlaywright() {
    const candidates = [
        process.env.PLAYWRIGHT_MODULE,
        'playwright',
        'C:/Users/Admin/.workbuddy/binaries/node/workspace/node_modules/playwright',
    ].filter(Boolean)
    for (const candidate of candidates) {
        try {
            return require(candidate)
        } catch {
            // 试下一个
        }
    }
    throw new Error(
        '找不到 playwright。请先 pnpm add -D playwright，或设置 PLAYWRIGHT_MODULE 指向 playwright 包目录。'
    )
}

const { chromium } = loadPlaywright()

const { default: groups } = await import('../src/pages/index/demo-manifest.js')
const allPages = groups.flatMap((group) => group.items.map((item) => ({ ...item, group: group.name })))
const filters = ONLY ? ONLY.split(',').map((item) => item.trim()).filter(Boolean) : []
const pages = filters.length
    ? allPages.filter((page) => filters.some((filter) => page.path.includes(filter)))
    : allPages

/** 已知噪声：不影响示例页本身的报错 */
const IGNORED = [
    /favicon\.ico/i,
    /Failed to load resource: the server responded with a status of 404/i,
]

function isNoise(text) {
    return IGNORED.some((pattern) => pattern.test(text))
}

const results = []

async function main() {
    console.log('示例页运行时冒烟：' + pages.length + ' 个页面')
    console.log('dev server：' + BASE)
    if (WANT_SCREENSHOT) {
        fs.mkdirSync(SHOT_DIR, { recursive: true })
    }

    const browser = await chromium.launch({ channel: 'chromium' })
    const context = await browser.newContext({ viewport: { width: 420, height: 860 } })
    const page = await context.newPage()

    const consoleErrors = []
    const pageErrors = []
    const failedRequests = []
    const externalWarnings = []
    const isLocal = (url) => url.startsWith(BASE)
    page.on('console', (message) => {
        if (message.type() !== 'error') return
        const text = message.text()
        if (isNoise(text)) return
        // 「Failed to load resource」既可能是本地资源也可能是外链，从这里分辨不了，
        // 统一降级为外部资源告警；本地资源真缺了会同时触发 requestfailed，那条算错误
        if (/Failed to load resource/.test(text)) externalWarnings.push(text)
        else consoleErrors.push(text)
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('requestfailed', (request) => {
        const url = request.url()
        if (isNoise(url)) return
        const entry = url + ' —— ' + (request.failure()?.errorText || '')
        // 外链 CDN / 图床被 ORB、防盗链、跨域策略拦掉，不是组件的问题，单独记为告警
        if (isLocal(url)) failedRequests.push(entry)
        else externalWarnings.push(entry)
    })

    for (let index = 0; index < pages.length; index += 1) {
        const item = pages[index]
        consoleErrors.length = 0
        pageErrors.length = 0
        failedRequests.length = 0
        externalWarnings.length = 0

        const url = BASE + '/#/' + item.path
        let status = 'ok'
        let domStats = { elements: 0, text: 0 }
        try {
            // 只改 hash 的 goto 不会重新加载文档（uni-app 是 hash 路由），
            // 先切到空白页强制拿到干净的应用实例，否则上一个页面的状态会串进来
            await page.goto('about:blank')
            await page.goto(url, { waitUntil: 'load', timeout: 60000 })
            await page.waitForTimeout(1500)
            domStats = await page.evaluate(() => {
                const app = document.querySelector('#app')
                return {
                    elements: app ? app.querySelectorAll('*').length : 0,
                    text: ((document.body && document.body.innerText) || '').replace(/\s+/g, '').length,
                }
            })
        } catch (error) {
            status = '导航失败：' + String(error.message).split('\n')[0]
        }

        const errors = [
            ...pageErrors.map((text) => '未捕获异常：' + text),
            ...consoleErrors.map((text) => '控制台错误：' + text),
            ...failedRequests.map((text) => '请求失败：' + text),
        ]

        // 用 DOM 元素数判断有没有真的渲染：纯图片页 / 极简页的文本长度天然接近 0，
        // 拿文本长度当阈值会误判（test / lazyLoad / jump 三个页面就是这么被误报的）
        if (status === 'ok' && domStats.elements === 0) {
            status = '页面未渲染'
        } else if (status === 'ok' && errors.length > 0) {
            status = '有报错'
        }

        if (WANT_SCREENSHOT) {
            const slug = item.path.replace(/^pages\//, '').replace(/\//g, '__')
            try {
                await page.screenshot({ path: path.join(SHOT_DIR, slug + '.png') })
            } catch {
                // 截图失败不影响结论
            }
        }

        results.push({
            ...item,
            status,
            domElements: domStats.elements,
            textLength: domStats.text,
            errors,
            externalWarnings: [...externalWarnings],
        })
        const mark = status === 'ok' ? '·' : '✗'
        console.log(
            '  ' + mark + ' [' + String(index + 1).padStart(3) + '/' + pages.length + '] '
            + item.path + '  ' + (status === 'ok' ? '' : status)
        )
    }

    await browser.close()

    fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2))

    const failed = results.filter((item) => item.status !== 'ok')
    const warned = results.filter((item) => item.externalWarnings.length > 0)
    console.log('')
    console.log('=== 结论 ===')
    console.log('页面总数   : ' + results.length)
    console.log('通过       : ' + (results.length - failed.length))
    console.log('异常       : ' + failed.length)
    if (warned.length > 0) {
        console.log('外链告警   : ' + warned.length + ' 个页面（远程图片/视频被 ORB、防盗链、CDN abort 拦掉，不计为失败）')
        for (const item of warned) {
            console.log('  ~ ' + item.path + '  →  ' + item.externalWarnings[0].slice(0, 120))
        }
    }
    console.log('报告       : ' + path.relative(ROOT, OUT_JSON).split(path.sep).join('/'))
    if (WANT_SCREENSHOT) {
        console.log('截图       : ' + path.relative(ROOT, SHOT_DIR).split(path.sep).join('/'))
    }
    if (failed.length > 0) {
        console.log('')
        for (const item of failed) {
            console.log('  ✗ ' + item.path + '  →  ' + item.status)
            for (const error of item.errors.slice(0, 3)) {
                console.log('      ' + error.slice(0, 200))
            }
        }
        process.exit(1)
    }
    console.log('')
    console.log('verify-demo-pages: OK')
}

main().catch((error) => {
    console.error('verify-demo-pages: 运行异常')
    console.error(error)
    process.exit(1)
})
