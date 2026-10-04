import App from './App'
import uviewUltra from '@/uni_modules/uview-ultra/index.js'
import { createSSRApp } from 'vue'

export function createApp() {
    const app = createSSRApp(App)
    app.use(uviewUltra)
    return {
        app,
    }
}
