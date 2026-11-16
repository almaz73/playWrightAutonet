import {chromium} from 'playwright'

// окружения, между которыми переключается проверка
export const SMOKE_ENVIRONMENTS = {
    local: {label: 'Локально', baseUrl: 'http://localhost:3000'},
    prod: {label: 'Продакшен', baseUrl: 'https://xn--80aej9aped4f.xn--p1ai'},
}

export const SMOKE_PAGES = [
    {path: '/', label: 'Главная'},
    {path: '/cars', label: 'Витрина /cars'},
]

// простая проверка запуска страниц: открывается, отвечает 200, не падает с JS-ошибкой
export async function runSmoke({environment, pages, timeout = 30000} = {}) {
    const env = SMOKE_ENVIRONMENTS[environment]
    if (!env) throw new Error('Неизвестное окружение')

    const paths = Array.isArray(pages) && pages.length
        ? pages.filter((path) => SMOKE_PAGES.some((page) => page.path === path))
        : SMOKE_PAGES.map((page) => page.path)
    if (!paths.length) throw new Error('Выберите хотя бы одну страницу')

    const startedAt = new Date()
    const browser = await chromium.launch()
    const results = []

    try {
        for (const path of paths) {
            const label = SMOKE_PAGES.find((page) => page.path === path)?.label || path
            const url = env.baseUrl + path
            const started = Date.now()
            const context = await browser.newContext({locale: 'ru-RU'})
            const page = await context.newPage()
            const pageErrors = []
            page.on('pageerror', (error) => pageErrors.push(error.message))

            let status = null
            let title = ''
            let finalUrl = url
            let error = null

            try {
                const response = await page.goto(url, {waitUntil: 'domcontentloaded', timeout})
                status = response?.status() ?? null
                title = await page.title()
                finalUrl = page.url()
                // даём клиентским скриптам время выполниться
                await page.waitForTimeout(1000)
            } catch (navigateError) {
                error = navigateError.message
            }

            await context.close()

            results.push({
                path,
                label,
                url,
                finalUrl,
                status,
                title,
                ok: !error && status === 200,
                error,
                pageErrors,
                durationMs: Date.now() - started,
            })
        }
    } finally {
        await browser.close()
    }

    return {
        environment,
        label: env.label,
        baseUrl: env.baseUrl,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        ok: results.every((result) => result.ok),
        results,
    }
}
