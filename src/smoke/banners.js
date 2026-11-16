import {chromium} from 'playwright'
import {SMOKE_ENVIRONMENTS} from './smoke.js'

const TARGETS = [
    {
        key: 'main',
        path: '/',
        where: 'главной',
        containerSel: '#main_swiper',
        swiperSel: '#main_swiper .swiper.mySwiper',
        areaSel: '.filter',
        areaLabel: 'фильтром',
    },
    {
        key: 'cars',
        path: '/cars/',
        where: '/cars',
        containerSel: 'swiper_buy',
        swiperSel: 'swiper_buy .swiper.mySwiper',
        areaSel: 'cards',
        areaLabel: 'карточками авто',
    },
]

// ожидаемые размеры файлов по суффиксу в имени
const SIZE_RULES = {
    _h_b: {width: 1200, height: 410},
    _h_l: {width: 585, height: 200},
    _v_l: {width: 278, height: 402},
    _v_b: {width: 500, height: 723},
    _h_m: {width: 1201, height: 501},
}

const fileName = (url) => decodeURIComponent(url.split('?')[0].split('/').pop() || url)

const waitForCarousel = async (page, target, timeout) => {
    await page.waitForFunction(
        ({containerSel}) => {
            const container = document.querySelector(containerSel)
            return !!container && container.querySelectorAll('.swiper-slide').length > 0
        },
        {containerSel: target.containerSel},
        {timeout},
    )

    await page.waitForFunction(
        ({swiperSel}) => !!document.querySelector(swiperSel)?.classList.contains('swiper-initialized'),
        {swiperSel: target.swiperSel},
        {timeout},
    )

    const slides = page.locator(`${target.swiperSel} .swiper-slide:not(.swiper-slide-duplicate)`)
    const count = await slides.count()
    if (!count) throw new Error('в карусели нет слайдов')

    const withoutLink = await slides.evaluateAll((nodes) => nodes.filter((node) => {
        const link = node.querySelector('a[href]')
        return !link || !link.getAttribute('href').startsWith('/promo/')
    }).length)
    if (withoutLink) throw new Error(`у ${withoutLink} слайдов нет ссылки на акцию`)

    return `${count} ${count === 1 ? 'слайд' : 'слайдов'} · Swiper запущен`
}

const waitForImages = async (page, target, timeout) => {
    await page.locator(target.swiperSel).scrollIntoViewIfNeeded()

    // фото текущего слайда действительно отрисовано, а не битая иконка
    await page.waitForFunction(
        ({swiperSel}) => {
            const active = document.querySelector(`${swiperSel} .swiper-slide-active`)
            if (!active) return false
            const images = [...active.querySelectorAll('img')].filter((img) => {
                const rect = img.getBoundingClientRect()
                return rect.width > 0 && rect.height > 0 && getComputedStyle(img).display !== 'none'
            })
            return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0)
        },
        {swiperSel: target.swiperSel},
        {timeout},
    )

    const urls = await page.evaluate(({swiperSel}) => {
        const all = [...document.querySelectorAll(`${swiperSel} img`)].map((img) => img.getAttribute('src'))
        return all.filter((src) => src).filter((src, index, list) => list.indexOf(src) === index)
    }, {swiperSel: target.swiperSel})
    if (!urls.length) throw new Error('в карусели нет изображений')

    // проверяем каждый уникальный адрес: отдаётся 200, это картинка, и запоминаем её реальные размеры
    const result = await page.evaluate(async (list) => {
        const problems = []
        const images = []
        let cursor = 0
        const worker = async () => {
            while (cursor < list.length) {
                const url = list[cursor++]
                try {
                    const response = await fetch(url, {cache: 'no-store'})
                    const type = response.headers.get('content-type') || ''
                    if (!response.ok || !type.startsWith('image/')) {
                        problems.push(`${url} → ${response.status} ${type || 'без типа'}`)
                        continue
                    }
                    const bitmap = await createImageBitmap(await response.blob())
                    images.push({url, width: bitmap.width, height: bitmap.height})
                    bitmap.close()
                } catch {
                    problems.push(`${url} → не удалось прочитать картинку`)
                }
            }
        }
        await Promise.all([worker(), worker(), worker(), worker()])
        return {problems, images}
    }, urls)

    if (result.problems.length) {
        const shown = result.problems.slice(0, 3).join(', ')
        throw new Error(`не загрузились фото: ${shown}${result.problems.length > 3 ? ` и ещё ${result.problems.length - 3}` : ''}`)
    }

    return {detail: `${urls.length} фото, все отвечают 200`, images: result.images}
}

const checkImageSizes = (images) => {
    const mismatched = []
    let checked = 0

    for (const image of images) {
        const name = fileName(image.url)
        const rule = SIZE_RULES[name.replace(/\.[^.]+$/, '').slice(-4)]
        if (!rule) continue

        checked++
        if (image.width !== rule.width || image.height !== rule.height) {
            mismatched.push(`${name} ${image.width}×${image.height} вместо ${rule.width}×${rule.height}`)
        }
    }

    if (mismatched.length) {
        const shown = mismatched.slice(0, 5).join('; ')
        throw new Error(`неверный размер у ${mismatched.length}: ${shown}${mismatched.length > 5 ? `; и ещё ${mismatched.length - 5}` : ''}`)
    }

    if (!checked) return 'нет фото с суффиксами _h_b/_h_l/_v_l/_v_b/_h_m'
    return `${checked} фото · размеры соответствуют`
}

const checkPlacement = async (page, target, timeout) => {
    await page.locator(target.swiperSel).scrollIntoViewIfNeeded()

    await page.waitForFunction(
        ({swiperSel}) => {
            const swiper = document.querySelector(swiperSel)
            if (!swiper) return false
            const rect = swiper.getBoundingClientRect()
            const style = getComputedStyle(swiper)
            return rect.width > 100 && rect.height > 50
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity) > 0
        },
        {swiperSel: target.swiperSel},
        {timeout},
    )

    const info = await page.evaluate(({swiperSel, containerSel, areaSel}) => {
        const toDoc = (el) => {
            if (!el) return null
            const rect = el.getBoundingClientRect()
            return {
                left: rect.left,
                top: rect.top + window.scrollY,
                right: rect.right,
                bottom: rect.bottom + window.scrollY,
                width: rect.width,
                height: rect.height,
            }
        }
        const header = document.querySelector('.header')
        return {
            swiper: toDoc(document.querySelector(swiperSel)),
            container: toDoc(document.querySelector(containerSel)),
            area: toDoc(document.querySelector(areaSel)),
            headerBottom: header ? header.getBoundingClientRect().bottom + window.scrollY : null,
            docWidth: document.documentElement.clientWidth,
        }
    }, {swiperSel: target.swiperSel, containerSel: target.containerSel, areaSel: target.areaSel})

    const {swiper, container, area} = info
    if (!swiper) throw new Error('карусель не найдена на странице')
    if (!container) throw new Error(`не найден контейнер ${target.containerSel}`)
    if (!area) throw new Error(`не найдена область с ${target.areaLabel}`)

    const tolerance = 4
    const inside = (inner, outer) => inner.left >= outer.left - tolerance
        && inner.right <= outer.right + tolerance
        && inner.top >= outer.top - tolerance
        && inner.bottom <= outer.bottom + tolerance

    if (!inside(swiper, container)) throw new Error('карусель вышла за пределы своего контейнера')
    if (target.key === 'cars' && !inside(container, area)) {
        throw new Error(`карусель оказалась вне области с ${target.areaLabel}`)
    }
    if (swiper.left < -tolerance || swiper.right > info.docWidth + tolerance) {
        throw new Error('карусель выходит за границы экрана по ширине')
    }

    if (target.key === 'main') {
        if (info.headerBottom === null) throw new Error('не найден хедер страницы')
        if (container.top < info.headerBottom - tolerance) throw new Error('карусель перекрывает хедер')
        if (container.bottom > area.top + tolerance) throw new Error('карусель оказалась ниже фильтра')
    }

    return `${Math.round(swiper.width)}×${Math.round(swiper.height)} px · в своём блоке`
}

// проверка карусели баннеров на главной и на /cars: слайды, позиция и загрузка фото
export async function runBannerTest({environment, timeout = 30000, onProgress} = {}) {
    const env = SMOKE_ENVIRONMENTS[environment]
    if (!env) throw new Error('Неизвестное окружение')

    const baseUrl = env.baseUrl.replace(/\/+$/, '')
    const startedAt = new Date()
    const total = 10
    const steps = []
    let failure = null
    const stats = {}
    const photos = {}

    const step = async (label, action, {fatal = true} = {}) => {
        onProgress?.({phase: 'running', done: steps.length, total, current: label})
        const started = Date.now()
        try {
            const detail = await action()
            steps.push({label, detail, ok: true, durationMs: Date.now() - started})
            return detail
        } catch (error) {
            steps.push({label, detail: error.message, ok: false, durationMs: Date.now() - started})
            if (fatal) throw error
            return error.message
        }
    }

    let browser
    try {
        browser = await chromium.launch()
        const context = await browser.newContext({locale: 'ru-RU'})
        const page = await context.newPage()

        for (const target of TARGETS) {
            await step(target.key === 'main' ? 'Главная открыта' : `${target.path} открыт`, async () => {
                const response = await page.goto(`${baseUrl}${target.path}`, {waitUntil: 'domcontentloaded', timeout})
                const status = response?.status() ?? null
                if (status !== 200) throw new Error(`страница ответила ${status ?? 'без статуса'}`)
                return `${target.path} · ${status}`
            })

            await step(`Карусель на ${target.where}`, async () => {
                const detail = await waitForCarousel(page, target, timeout)
                stats[target.key] = {carousel: detail}
                return detail
            })

            await step(`Карусель на ${target.where} на своём месте`, () => checkPlacement(page, target, timeout))
            await step(`Фото на ${target.where} загружаются`, async () => {
                const {detail, images} = await waitForImages(page, target, timeout)
                photos[target.key] = images
                stats[target.key] = {...stats[target.key], photos: detail}
                return detail
            })
            await step(`Размеры фото на ${target.where}`, () => {
                const detail = checkImageSizes(photos[target.key] || [])
                stats[target.key] = {...stats[target.key], sizes: detail}
                return detail
            }, {fatal: false})
        }
    } catch (error) {
        failure = error.message
    } finally {
        if (browser) await browser.close()
    }

    onProgress?.({phase: 'done', done: steps.length, total, current: null})

    if (!failure) {
        const failed = steps.filter((item) => !item.ok)
        if (failed.length) failure = failed.map((item) => `${item.label}: ${item.detail}`).join('; ')
    }

    return {
        environment,
        label: env.label,
        baseUrl,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        ok: !failure && steps.length === total && steps.every((item) => item.ok),
        error: failure,
        stats,
        steps,
    }
}
