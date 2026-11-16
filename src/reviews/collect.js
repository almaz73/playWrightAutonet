import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {BROWSER_CHANNEL, BROWSER_PROFILE, HEADLESS, REVIEW_YEARS} from '../config.js'
import {detectPlatform, loadAdapter} from './adapters/index.js'
import {isWithinYears, parseReviewDate} from './dates.js'
import {closeDb, saveReviews} from '../db.js'

const USAGE = `
Использование:
  node src/reviews/collect.js <url> [опции]

Опции:
  --platform=yandex|2gis|avito|google  площадка (по умолчанию определяется по адресу)
  --limit=50                           сохранить не больше N отзывов
  --dry-run                            только показать собранное, в базу не писать
  --headless=1                         запустить браузер без окна (Яндекс на это отвечает 429)

Google отдаёт полный список отзывов только после входа в аккаунт:
один раз выполните node login-google.mjs — cookies сохранятся в профиле браузера.
`

const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
        platform: {type: 'string'},
        limit: {type: 'string'},
        'dry-run': {type: 'boolean'},
        headless: {type: 'string'},
    },
})

const url = positionals[0]
if (!url) {
    console.error(USAGE)
    process.exit(1)
}

const platform = values.platform || detectPlatform(url)
if (!platform) {
    console.error(`Не удалось определить площадку по адресу ${url}. Укажите --platform.`)
    process.exit(1)
}

const limit = values.limit ? Number(values.limit) : Infinity
const headless = values.headless === undefined ? HEADLESS : values.headless === '1'

let context
try {
    const adapter = await loadAdapter(platform)

    // постоянный профиль сохраняет cookies и проходит антибот-проверки площадок
    context = await chromium.launchPersistentContext(BROWSER_PROFILE, {
        channel: BROWSER_CHANNEL,
        headless,
        viewport: {width: 1400, height: 900},
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        args: ['--disable-blink-features=AutomationControlled'],
    })
    const page = context.pages()[0] || await context.newPage()

    console.log(`Площадка: ${platform}; сбор: ${url}`)
    // адаптер сам открывает нужную страницу: у площадок разные адреса лент отзывов
    const raw = await adapter.collect(page, {url, years: REVIEW_YEARS})
    const normalized = normalize(raw, url)
    const items = normalized.slice(0, limit)

    const limited = items.length < normalized.length ? ` (сохраним ${items.length})` : ''
    console.log(`Собрано отзывов: ${raw.length}, за последние ${REVIEW_YEARS} г.: ${normalized.length}${limited}`)

    if (values['dry-run']) {
        console.log(JSON.stringify(items, null, 2))
    } else {
        const stats = await saveReviews(platform, items)
        console.log(`Сохранено: добавлено ${stats.added}, обновлено ${stats.updated}`)
    }
} catch (error) {
    console.error('Ошибка сбора отзывов:', error.message)
    process.exitCode = 1
} finally {
    if (context) await context.close()
    await closeDb()
}

function normalize(raw, pageUrl) {
    const seen = new Set()

    return raw
        .map((item) => ({
            external_id: item.external_id ? String(item.external_id) : null,
            fio: text(item.fio),
            date: parseReviewDate(item.date),
            review: text(item.review),
            link: item.link || pageUrl,
            respondent: text(item.respondent),
            dateAnswer: parseReviewDate(item.dateAnswer),
            answer: text(item.answer),
            rating: toRating(item.rating),
        }))
        .filter((item) => item.review)
        .filter((item) => isWithinYears(item.date, REVIEW_YEARS))
        .filter((item) => {
            const key = item.external_id || `${item.link}|${item.fio}|${item.date}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
        })
}

function text(value) {
    const result = String(value ?? '').replace(/\s+/g, ' ').trim()
    return result || null
}

function toRating(value) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? Math.round(number) : null
}
