/**
 * Node ESM 解析钩子：让 Node 也能像 Vite / uni-app 那样解析「省略扩展名」和「目录」导入。
 *
 * uview-ultra 的源码里大量使用 `import x from '../../libs/function/test'` 这类写法，
 * 在 Vite 下没问题，但 Node 原生 ESM 会直接报
 * `Cannot find module ...` / `Directory import ... is not supported`。
 * 这些是解析差异，不是组件本身的 bug，所以这里补齐解析规则，避免门禁误报。
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const SUFFIXES = ['', '.js', '.mjs', '.json', '/index.js', '/index.mjs', '/index.json']

export async function resolve(specifier, context, nextResolve) {
    try {
        return await nextResolve(specifier, context)
    } catch (error) {
        if (!specifier.startsWith('.') || !context.parentURL) throw error
        const base = new URL(specifier, context.parentURL)
        for (const suffix of SUFFIXES) {
            const candidate = new URL(base.href + suffix)
            if (candidate.protocol !== 'file:') continue
            try {
                if (fs.statSync(fileURLToPath(candidate)).isFile()) {
                    return nextResolve(candidate.href, context)
                }
            } catch {
                // 继续尝试下一个后缀
            }
        }
        throw error
    }
}
