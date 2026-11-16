import {chromium} from 'playwright'

// окружения, между которыми переключается проверка
export const SMOKE_ENVIRONMENTS = {
    local: {label: 'Локально', baseUrl: 'http://localhost:3000'},
    prod: {label: 'Продакшен', baseUrl: 'https://xn--80aej9aped4f.xn--p1ai'},
}

// панель из partials/header/header.hbs
const NAV_SELECTOR = '.main-nav.menu a[href]'

// собираем внутренние ссылки из панели: внешние, tel:, mailto: и якоря не проверяем
async function collectNavLinks(page, baseUrl) {
    const origin = new URL(baseUrl).origin
    const links = await page.$$eval(NAV_SELECTOR, (anchors) => anchors.map((anchor) => ({
        href: anchor.getAttribute('href') || '',
        label: (anchor.innerText || '').replace(/\s+/g, ' ').trim(),
    })))

    const pages = []
    const external = []
    const seen = new Set()

    for (const {href, label} of links) {
        if (!href || href.startsWith('#') || /^(tel|mailto|javascript):/i.test(href)) continue

        let url
        try {
            url = new URL(href, baseUrl)
        } catch {
            continue
        }

        if (url.origin !== origin) {
            external.push(label || url.href)
            continue
        }

        const path = url.pathname + url.search
        if (seen.has(path)) continue
        seen.add(path)
        pages.push({path, label: label || path})
    }

    return {pages, external}
}

// проверка доступности страниц: открывается, отвечает 200, не падает с JS-ошибкой
export async function runSmoke({environment, timeout = 30000} = {}) {
    const env = SMOKE_ENVIRONMENTS[environment]
    if (!env) throw new Error('Неизвестное окружение')

    const baseUrl = env.baseUrl.replace(/\/+$/, '')
    const startedAt = new Date()
    const browser = await chromium.launch()
    const results = []
    let external = []

    try {
        const navContext = await browser.newContext({locale: 'ru-RU'})
        const navPage = await navContext.newPage()

        let nav
        try {
            const response = await navPage.goto(`${baseUrl}/`, {waitUntil: 'domcontentloaded', timeout})
            if (response?.status() !== 200) {
                throw new Error(`главная ответила ${response?.status() ?? 'без статуса'}`)
            }
            nav = await collectNavLinks(navPage, baseUrl)
        } catch (error) {
            throw new Error(`Не удалось прочитать меню на главной: ${error.message}`)
        } finally {
            await navContext.close()
        }

        external = nav.external
        if (!nav.pages.length) throw new Error('В панели .main-nav menu не найдено внутренних ссылок')

        for (const {path, label} of nav.pages) {
            const url = baseUrl + path
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
        baseUrl,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        ok: results.length > 0 && results.every((result) => result.ok),
        skippedExternal: external,
        results,
    }
}
