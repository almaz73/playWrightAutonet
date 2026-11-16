// Отзывы Яндекс.Карт.
// Страница отдаёт ленту через внутренний JSON API /maps/api/business/fetchReviews,
// поэтому надёжнее перехватывать его ответы, чем разбирать разметку карточек.
// Headless-браузер Яндекс встречает кодом 429, поэтому запускать нужно с окном.

const REVIEW_CARD = '[class~="business-review-view"]'
const SORT_CONTROL = '.rating-ranking-view'
const SORT_NEWEST = 'По новизне'
const API_PATH = '/maps/api/business/fetchReviews'

export default {
    async collect(page, {url, years}) {
        const reviewsUrl = toReviewsUrl(url)
        const byTime = new Map()
        const anyRanking = new Map()
        const pending = []
        let sawResponse = false

        page.on('response', (response) => {
            if (!response.url().includes(API_PATH) || response.status() !== 200) return
            pending.push(readResponse(response))
        })

        async function readResponse(response) {
            try {
                const payload = await response.json()
                const list = payload?.data?.reviews
                if (!Array.isArray(list)) return
                sawResponse = true
                const ranking = new URL(response.url()).searchParams.get('ranking')
                for (const item of list) {
                    if (!item?.reviewId) continue
                    const target = ranking === 'by_time' ? byTime : anyRanking
                    if (!target.has(String(item.reviewId))) target.set(String(item.reviewId), item)
                }
            } catch (error) {
                // не JSON — например, страница капчи
            }
        }

        async function drain() {
            while (pending.length) await Promise.all(pending.splice(0))
        }

        const response = await page.goto(reviewsUrl, {waitUntil: 'domcontentloaded', timeout: 90_000})
        const status = response?.status()
        if (status === 429 || status === 403) {
            throw new Error(`Яндекс ограничил доступ (код ${status}). Сбор нужно запускать с окном браузера: --headless=1 блокируется.`)
        }

        // карточки появляются после отрисовки React-приложения; даём интерфейсу устояться,
        // иначе клик по сортировке может не сработать
        const loaded = await page.locator(REVIEW_CARD).first()
            .waitFor({state: 'attached', timeout: 45_000})
            .then(() => true)
            .catch(() => false)

        if (!loaded) {
            const title = await page.title().catch(() => '')
            throw new Error(`Страница отзывов не загрузилась (код ${status}, заголовок «${title}»). Возможно, Яндекс показал капчу или ограничил доступ.`)
        }

        await page.waitForTimeout(3000)
        await drain()

        const orgName = await page.locator('h1').first().textContent({timeout: 5000})
            .then((text) => text.replace(/\s+/g, ' ').trim() || null)
            .catch(() => null)

        // сортировка по новизне обязательна: по ней видно, когда пора остановить прокрутку
        await sortByNewest(page)
        await drain()
        if (process.env.DEBUG_REVIEWS) {
            console.error(`[yandex] после сортировки: by_time=${byTime.size}, default=${anyRanking.size}`)
        }

        // лента листается колесом внутри левой панели, поэтому курсор должен быть над ней
        const cardBox = await page.locator(REVIEW_CARD).first().boundingBox().catch(() => null)
        if (cardBox) await page.mouse.move(cardBox.x + Math.min(cardBox.width / 2, 200), cardBox.y + Math.min(cardBox.height / 2, 100))
        else await page.mouse.move(420, 600)

        const cutoff = cutoffIso(years)
        let stagnant = 0

        for (let i = 0; i < 100; i++) {
            const oldest = oldestDate(byTime)
            if (oldest && oldest < cutoff) break

            const before = byTime.size
            await page.mouse.wheel(0, 7000)
            await page.waitForTimeout(900)
            await drain()

            if (byTime.size === before) stagnant++
            else stagnant = 0
            if (stagnant >= 5) break
        }

        const collected = byTime.size ? byTime : anyRanking
        if (process.env.DEBUG_REVIEWS) {
            console.error(`[yandex] итог: by_time=${byTime.size}, default=${anyRanking.size}, oldest=${oldestDate(collected)}`)
        }
        if (!collected.size && !sawResponse) {
            const cards = await page.locator(REVIEW_CARD).count().catch(() => 0)
            throw new Error(`Не удалось перехватить ответы API отзывов (карточек на странице: ${cards}). Вероятно, изменился интерфейс Яндекса.`)
        }

        return [...collected.values()].map((item) => toReview(item, reviewsUrl, orgName))
    },
}

function toReviewsUrl(url) {
    const parsed = new URL(url)
    const match = parsed.pathname.match(/^\/maps\/org\/([^/]+)\/(\d+)/)
    if (!match) {
        throw new Error(`Не удалось определить организацию в адресе ${url}. Ожидается ссылка вида https://yandex.ru/maps/org/<название>/<id>/`)
    }
    const [, slug, id] = match
    return `${parsed.origin}/maps/org/${slug}/${id}/reviews/`
}

async function sortByNewest(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const label = await page.locator(SORT_CONTROL).first().textContent({timeout: 10_000}).catch(() => '')
        if (/новизне/i.test(label)) return

        await page.locator(SORT_CONTROL).first().click({timeout: 15_000})
        const option = page.getByText(SORT_NEWEST, {exact: true}).first()
        const opened = await option.waitFor({state: 'visible', timeout: 8000}).then(() => true).catch(() => false)

        if (opened) {
            await option.click({timeout: 10_000})
            await page.waitForTimeout(3000)
            continue
        }

        // меню не успело открыться — закрываем и пробуем ещё раз
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(1000)
    }

    const label = await page.locator(SORT_CONTROL).first().textContent({timeout: 5000}).catch(() => '')
    if (!/новизне/i.test(label)) {
        throw new Error(`Не удалось переключить сортировку отзывов на «${SORT_NEWEST}» (текущая: «${label.trim()}»).`)
    }
}

function oldestDate(map) {
    let min = null
    for (const item of map.values()) {
        const date = toIsoDate(item.updatedTime)
        if (date && (!min || date < min)) min = date
    }
    return min
}

function cutoffIso(years) {
    const date = new Date()
    date.setFullYear(date.getFullYear() - years)
    return date.toISOString()
}

function toIsoDate(value) {
    if (!value) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

// дата отзыва на сайте показывается по Москве; sv-SE даёт формат YYYY-MM-DD
function moscowDate(value) {
    const date = toIsoDate(value)
    if (!date) return null
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(date))
}

function toReview(item, pageUrl, orgName) {
    const comment = item.businessComment
    return {
        external_id: String(item.reviewId),
        fio: item.author?.name || null,
        date: moscowDate(item.updatedTime),
        review: item.text || null,
        link: pageUrl,
        respondent: comment ? (orgName || 'Официальный ответ') : null,
        dateAnswer: comment ? moscowDate(comment.updatedTime) : null,
        answer: comment?.text || null,
        rating: toRating(item.rating),
    }
}

function toRating(value) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? Math.round(number) : null
}
