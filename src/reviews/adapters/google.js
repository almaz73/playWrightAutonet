// Отзывы Google Карт.
// Полный список Google отдаёт только авторизованному браузеру; вход выполняется
// один раз через `node login-google.mjs`, cookies остаются в профиле .browser-profile.
// Лента подгружается внутренним RPC batchexecute (rpcid qv9Egd) порциями по 10 отзывов:
// в разметке карточек только относительные даты, а в ответе — точные метки времени и ответы владельца.

const BATCH_PATH = 'batchexecute'
const BATCH_RPC = 'qv9Egd'
// мобильная и «ограниченная» версии отдают первые отзывы через listugcposts
const UGC_PATH = '/maps/rpc/listugcposts'

const REVIEW_CARD = '.jftiEf'
const SORT_CONTROL = 'button.FNe70d'
const SORT_NEWEST = 'Сначала новые'
const LIST_SCROLLER = '.m6QErb.DxyBCb'

export default {
    async collect(page, {url, years}) {
        const byId = new Map()
        const pending = []
        let batches = 0
        let batchWithRecent = 0

        const cutoff = cutoffIso(years)

        page.on('response', (response) => {
            const href = response.url()
            const isBatch = href.includes(BATCH_PATH) && href.includes(`rpcids=${BATCH_RPC}`)
            const isUgc = href.includes(UGC_PATH)
            if (!isBatch && !isUgc) return
            pending.push(readResponse(response, isBatch))
        })

        async function readResponse(response, isBatch) {
            try {
                const text = await response.text()
                const reviews = isBatch ? parseBatch(text) : parseUgc(text)
                if (!reviews?.length) return
                batches++
                const recent = reviews.some((item) => item.date && item.date >= cutoff)
                batchWithRecent = recent ? 0 : batchWithRecent + 1
                for (const item of reviews) {
                    if (!item.external_id || byId.has(item.external_id)) continue
                    byId.set(item.external_id, item)
                }
            } catch (error) {
                // не JSON — например, страница согласия
            }
        }

        async function drain() {
            while (pending.length) await Promise.all(pending.splice(0))
        }

        const response = await page.goto(toPlaceUrl(url), {waitUntil: 'domcontentloaded', timeout: 90_000})
        const status = response?.status()

        const loaded = await page.locator(REVIEW_CARD).first()
            .waitFor({state: 'attached', timeout: 45_000})
            .then(() => true)
            .catch(() => false)

        if (!loaded) {
            const title = await page.title().catch(() => '')
            throw new Error(`Страница отзывов Google не загрузилась (код ${status}, заголовок «${title}»).`)
        }

        await page.waitForTimeout(1500)
        await drain()

        const signIn = await page.getByText(/Войдите в аккаунт, чтобы пользоваться всеми возможностями/i).count()
        if (!byId.size && signIn) {
            throw new Error('Google показывает список отзывов только после входа в аккаунт. Выполните `node login-google.mjs` и повторите сбор.')
        }

        // сортировка по новизне: позволяет остановиться, дойдя до отзывов старше периода
        await sortByNewest(page).catch((error) => {
            if (process.env.DEBUG_REVIEWS) console.error('[google]', error.message)
        })
        await page.waitForTimeout(2000)
        await drain()

        let stagnant = 0
        for (let i = 0; i < 120; i++) {
            if (batchWithRecent >= 2) break

            const before = byId.size
            await scrollList(page)
            await page.waitForTimeout(1000)
            await drain()

            if (byId.size === before) stagnant++
            else stagnant = 0
            if (stagnant >= 6) break
        }

        if (!byId.size) {
            const cards = await page.locator(REVIEW_CARD).count().catch(() => 0)
            throw new Error(`Не удалось перехватить ответы RPC отзывов Google (карточек на странице: ${cards}).`)
        }

        if (process.env.DEBUG_REVIEWS) {
            console.error(`[google] порций: ${batches}, отзывов: ${byId.size}, самая старая: ${oldestDate(byId)}`)
        }

        return [...byId.values()].map((item) => toReview(item, url))
    },
}

function toPlaceUrl(url) {
    const parsed = new URL(url)
    parsed.searchParams.set('hl', 'ru')
    return parsed.toString()
}

async function sortByNewest(page) {
    const control = page.locator(SORT_CONTROL).first()
    if (!await control.count()) return

    const label = await control.textContent({timeout: 5000}).catch(() => '')
    if (/новые/i.test(label)) return

    await control.click({timeout: 10_000})
    await page.getByRole('menuitemradio', {name: SORT_NEWEST}).first().click({timeout: 10_000})
    await page.waitForTimeout(2500)
}

// лента листается внутри панели отзывов, а не в окне
async function scrollList(page) {
    const list = page.locator(LIST_SCROLLER).first()
    if (await list.count()) {
        const box = await list.boundingBox().catch(() => null)
        if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await page.mouse.wheel(0, 3500)
            return
        }
    }
    await page.mouse.wheel(0, 3500)
}

// batchexecute: после префикса )]}' идёт строка с длиной, затем JSON-массив,
// внутри которого строка вида ["wrb.fr", "qv9Egd", "<ещё один JSON>"]
function parseBatch(text) {
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('[["wrb.fr"')) continue
        let outer
        try {
            outer = JSON.parse(trimmed)
        } catch (error) {
            return null
        }
        if (outer?.[0]?.[1] !== BATCH_RPC) return null
        let inner
        try {
            inner = JSON.parse(outer[0][2])
        } catch (error) {
            return null
        }
        return toRawReviews(inner?.[2])
    }
    return null
}

function parseUgc(text) {
    const start = text.indexOf('\n')
    if (start === -1) return null
    let data
    try {
        data = JSON.parse(text.slice(start + 1))
    } catch (error) {
        return null
    }
    return toRawReviews(data?.[2])
}

function toRawReviews(entries) {
    if (!Array.isArray(entries)) return null
    const reviews = []
    for (const entry of entries) {
        const item = Array.isArray(entry) ? entry[0] : null
        if (!Array.isArray(item) || typeof item[0] !== 'string') continue
        reviews.push(toRawReview(item))
    }
    return reviews
}

// поля ответа: [0] id, [1][3] время отзыва (мкс), [1][4][5][0] автор,
// [2][0][0] оценка, [2][15][0][0] текст, [3][1] время ответа, [3][14][0][0] текст ответа
function toRawReview(item) {
    const reply = Array.isArray(item[3]) ? item[3] : null
    const permalink = item[4]?.[3]?.[0] || null
    const answer = reply?.[14]?.[0]?.[0] || null

    return {
        external_id: item[0],
        fio: item[1]?.[4]?.[5]?.[0] || null,
        date: microDate(item[1]?.[3] ?? item[1]?.[2]),
        ...(/^https?:/.test(permalink) ? {link: permalink} : {}),
        rating: item[2]?.[0]?.[0] ?? null,
        review: item[2]?.[15]?.[0]?.[0] || null,
        respondent: answer ? 'Официальный ответ' : null,
        dateAnswer: answer ? microDate(reply[1]) : null,
        answer,
    }
}

function toReview(raw, pageUrl) {
    return {...raw, link: raw.link || pageUrl}
}

function oldestDate(map) {
    let min = null
    for (const item of map.values()) {
        if (item.date && (!min || item.date < min)) min = item.date
    }
    return min
}

function cutoffIso(years) {
    const date = new Date()
    date.setFullYear(date.getFullYear() - years)
    return date.toISOString().slice(0, 10)
}

function microDate(value) {
    const micro = Number(value)
    if (!Number.isFinite(micro) || micro <= 0) return null
    const date = new Date(micro / 1000)
    return Number.isNaN(date.getTime())
        ? null
        : new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Europe/Moscow',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(date)
}
