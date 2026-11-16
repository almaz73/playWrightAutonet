import {chromium} from 'playwright'
import {SMOKE_ENVIRONMENTS} from './smoke.js'

const BRAND_COMBO = '[data-placeholder="Марка"]'
const BRAND_OPTIONS = `${BRAND_COMBO} .big_comb__items div[data-parent="Марка"]`
const CITY_COMBO = '[data-placeholder="Город"]'
const CITY_OPTIONS = `${CITY_COMBO} .big_comb__items div[data-parent="Город"]`
const WHEEL_COMBO = '[data-placeholder="Руль"]'
const WHEEL_OPTIONS = `${WHEEL_COMBO} .big_comb__items div[data-parent="Руль"]`
const YEAR_FROM_INPUT = 'input[oninput*="yearReleasedFrom"]'
const ADVANCED_BUTTON = '.frame-filter__controls-advanced-text'
const COUNT_FIELD = '#set_filter .filter_number'

const YEAR_FROM = '2015'
const WHEEL = 'Левый'
const PREFERRED_CITY = 'Казань'

const digits = (value) => Number(String(value).replace(/[^\d]/g, '')) || 0

const plural = (count, [one, few, many]) => {
    const mod10 = count % 10
    const mod100 = count % 100
    if (mod10 === 1 && mod100 !== 11) return one
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
    return many
}

// ждём getList, у которого в query есть нужные параметры фильтра
const waitForList = (page, expected, timeout) => page.waitForResponse((response) => {
    if (!response.url().includes('/api/getList') || response.status() !== 200) return false
    const params = new URL(response.url()).searchParams
    return Object.entries(expected).every(([key, value]) => params.get(key) === value)
}, {timeout})

// проверка фильтра: марка, город, год от, расширенный фильтр и руль обновляют счётчик и витрину
export async function runFilterTest({environment, path: startPath = '/', timeout = 30000, onProgress} = {}) {
    const env = SMOKE_ENVIRONMENTS[environment]
    if (!env) throw new Error('Неизвестное окружение')

    const isCarsPage = startPath !== '/'
    const baseUrl = env.baseUrl.replace(/\/+$/, '')
    const startedAt = new Date()
    const total = 10
    const steps = []
    let failure = null
    let brand = ''
    let city = ''
    let totalCount = 0
    let resultPath = ''

    const step = async (label, action) => {
        onProgress?.({phase: 'running', done: steps.length, total, current: label})
        const started = Date.now()
        try {
            const detail = await action()
            steps.push({label, detail, ok: true, durationMs: Date.now() - started})
            return detail
        } catch (error) {
            steps.push({label, detail: error.message, ok: false, durationMs: Date.now() - started})
            throw error
        }
    }

    const readCount = async (response) => {
        const data = await response.json()
        const count = Number(data?.totalCount) || 0
        if (!count) throw new Error('фильтр не нашёл ни одного автомобиля')
        totalCount = count
        return count
    }

    let browser
    try {
        browser = await chromium.launch()
        const context = await browser.newContext({locale: 'ru-RU'})
        const page = await context.newPage()

        await step(isCarsPage ? `${startPath} открыт` : 'Главная открыта', async () => {
            const response = await page.goto(`${baseUrl}${startPath}`, {waitUntil: 'domcontentloaded', timeout})
            const status = response?.status() ?? null
            if (status !== 200) throw new Error(`страница ответила ${status ?? 'без статуса'}`)
            return `${startPath} · ${status}`
        })

        await step('Марки загружены', async () => {
            await page.waitForSelector(BRAND_OPTIONS, {state: 'attached', timeout})
            const count = await page.locator(BRAND_OPTIONS).count()
            if (!count) throw new Error('в комбобоксе «Марка» нет вариантов')
            return `${count} марок`
        })

        await step('Счётчик найденных авто', async () => {
            await page.waitForFunction(
                (selector) => /\d/.test(document.querySelector(selector)?.textContent || ''),
                COUNT_FIELD,
                {timeout},
            )
            const initial = digits(await page.locator(COUNT_FIELD).innerText())
            if (!initial) throw new Error('количество предложений не загрузилось')
            return `Всего ${initial} ${plural(initial, ['предложение', 'предложения', 'предложений'])}`
        })

        // раскрываем расширенный фильтр первым: он перезагружает комбобоксы и сбрасывает выбранные значения
        await step('Расширенный фильтр раскрыт', async () => {
            const colorsLoaded = page.waitForResponse(
                (response) => response.url().includes('/api/getColorList') && response.status() === 200,
                {timeout},
            )
            await page.locator(ADVANCED_BUTTON).click()
            await colorsLoaded
            await page.waitForSelector(WHEEL_OPTIONS, {state: 'attached', timeout})

            const active = await page.locator('.filter-fields.active').count()
            if (!active) throw new Error('класс active не появился у .filter-fields')
            if (!(await page.locator(WHEEL_COMBO).isVisible())) throw new Error('поле «Руль» осталось скрытым')
            return 'Дополнительные поля доступны'
        })

        await step('Марка выбрана', async () => {
            brand = ((await page.locator(BRAND_OPTIONS).first().textContent()) || '').trim()
            if (!brand) throw new Error('не удалось прочитать название марки')

            const listResponse = waitForList(page, {brand}, timeout)
            await page.locator(BRAND_COMBO).click()
            await page.locator(BRAND_OPTIONS).first().click()
            await readCount(await listResponse)
            return brand
        })

        await step('Город выбран', async () => {
            const texts = (await page.locator(CITY_OPTIONS).allTextContents()).map((item) => item.trim())
            city = texts.includes(PREFERRED_CITY)
                ? PREFERRED_CITY
                : texts.find((item) => item && item !== 'Все') || ''
            if (!city) throw new Error('в комбобоксе «Город» нет вариантов')

            const listResponse = waitForList(page, {city}, timeout)
            await page.locator(CITY_COMBO).click()
            await page.locator(`${CITY_COMBO} .big_comb__items`).getByText(city, {exact: true}).click()
            const count = await readCount(await listResponse)
            return `${city} · ${count} ${plural(count, ['предложение', 'предложения', 'предложений'])}`
        })

        await step(`Год от ${YEAR_FROM}`, async () => {
            const listResponse = waitForList(page, {yearReleasedFrom: YEAR_FROM}, timeout)
            await page.locator(YEAR_FROM_INPUT).fill(YEAR_FROM)
            await page.keyboard.press('Tab')
            const count = await readCount(await listResponse)
            return `с ${YEAR_FROM} года · ${count} ${plural(count, ['предложение', 'предложения', 'предложений'])}`
        })

        await step(`Руль «${WHEEL}» выбран`, async () => {
            const listResponse = waitForList(page, {wheelType: WHEEL}, timeout)
            await page.locator(WHEEL_COMBO).click()
            await page.locator(`${WHEEL_COMBO} .big_comb__items`).getByText(WHEEL, {exact: true}).click()
            const count = await readCount(await listResponse)
            return `${WHEEL} · ${count} ${plural(count, ['предложение', 'предложения', 'предложений'])}`
        })

        await step('Фильтр применился', async () => {
            await page.waitForFunction(
                ({selector, count}) => Number(String(document.querySelector(selector)?.textContent || '').replace(/[^\d]/g, '')) === count,
                {selector: COUNT_FIELD, count: totalCount},
                {timeout},
            )

            const selectedBrand = (await page.locator(`${BRAND_COMBO} .big-comb__placeholder`).innerText()).trim()
            if (selectedBrand !== brand) throw new Error(`в поле марки «${selectedBrand}», ожидали «${brand}»`)

            const selectedCity = (await page.locator(`${CITY_COMBO} .big-comb__placeholder`).innerText()).trim()
            if (selectedCity !== city) throw new Error(`в поле города «${selectedCity}», ожидали «${city}»`)

            const selectedYear = (await page.locator(YEAR_FROM_INPUT).inputValue()).trim()
            if (selectedYear !== YEAR_FROM) throw new Error(`в поле «Год от» значение «${selectedYear}», ожидали «${YEAR_FROM}»`)

            const selectedWheel = (await page.locator(`${WHEEL_COMBO} .big-comb__placeholder`).innerText()).trim()
            if (selectedWheel !== WHEEL) throw new Error(`в поле «Руль» значение «${selectedWheel}», ожидали «${WHEEL}»`)

            // на /cars витрина обновляется без перехода — проверяем заголовок и карточки сразу
            if (isCarsPage) {
                await page.waitForFunction(
                    (name) => (document.querySelector('#vitrina_name')?.textContent || '').includes(name),
                    brand,
                    {timeout},
                )
                await page.waitForFunction(
                    () => document.querySelectorAll('.cards .cart').length > 0,
                    null,
                    {timeout},
                )
            }

            return `${totalCount} ${plural(totalCount, ['предложение', 'предложения', 'предложений'])} · ${brand} · ${city} · с ${YEAR_FROM} · руль ${WHEEL.toLowerCase()}${isCarsPage ? ' · список обновлён' : ''}`
        })

        await step('Переход на витрину', async () => {
            await page.locator('#set_filter').click()
            await page.waitForURL((url) => url.pathname.startsWith('/cars/0/'), {timeout})

            const url = new URL(page.url())
            resultPath = decodeURI(`${url.pathname}${url.search}`)
            if (url.searchParams.get('yearReleasedFrom') !== YEAR_FROM) throw new Error('в адресе витрины нет года от')
            if (url.searchParams.get('wheelType') !== WHEEL) throw new Error('в адресе витрины нет руля')

            await page.waitForFunction(
                () => /^Автомобили/.test(document.querySelector('#vitrina_name')?.textContent || ''),
                null,
                {timeout},
            )
            await page.waitForFunction(
                () => document.querySelectorAll('.cards .cart').length > 0,
                null,
                {timeout},
            )
            return resultPath
        })
    } catch (error) {
        failure = error.message
    } finally {
        if (browser) await browser.close()
    }

    onProgress?.({phase: 'done', done: steps.length, total, current: null})

    return {
        environment,
        label: env.label,
        baseUrl,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        ok: !failure && steps.length === total && steps.every((item) => item.ok),
        error: failure,
        brand,
        city,
        yearFrom: YEAR_FROM,
        wheel: WHEEL,
        totalCount,
        resultPath,
        steps,
    }
}

export const runCarsFilterTest = (options = {}) => runFilterTest({...options, path: '/cars/'})
