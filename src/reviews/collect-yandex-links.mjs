// Поиск страниц отзывов Яндекс Карт для каждой точки из таблицы dealers.
// Запуск с окном Chrome: без окна Яндекс отвечает 429.
//   node src/reviews/collect-yandex-links.mjs            — только показать найденное
//   node src/reviews/collect-yandex-links.mjs --apply    — записать ссылки в dealers.reviews_yandex
//   --limit=5 / --id=8,9                                 — обработать часть точек

import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {BROWSER_CHANNEL, BROWSER_PROFILE} from '../config.js'
import {closeDb, getDealersForReviewLinks, saveDealerReviewLink} from '../db.js'

const {values} = parseArgs({
    options: {
        apply: {type: 'boolean'},
        limit: {type: 'string'},
        id: {type: 'string'},
        debug: {type: 'boolean'},
    },
})

const apply = Boolean(values.apply)
const limit = values.limit ? Number(values.limit) : Infinity
const onlyIds = values.id
    ? new Set(values.id.split(',').map((id) => Number(id.trim())).filter(Boolean))
    : null

const GENERIC_WORDS = new Set([
    'улица', 'проспект', 'просп', 'шоссе', 'переулок', 'бульвар', 'пом', 'помещение',
    'строение', 'стр', 'дом', 'россия',
])

const NOT_DEALER = /станция зарядки|электромобил|шиномонтаж|автомойка|парковка|пункт выдачи/i
const IS_DEALER = /продажа автомобилей|автосалон|автомобилей с пробегом|дилерск|дилер/i

const normalize = (value) => String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tokens = (value) => normalize(value).split(' ').filter((token) => token.length >= 4 && !GENERIC_WORDS.has(token))

const houseNumber = (address) => {
    const match = normalize(address).match(/\b\d+[а-я]?\b/i)
    return match ? match[0] : ''
}

// слова улиц сравниваем по началу: в базе встречаются опечатки («Оснабрюксая»)
const tokenMatches = (dealerToken, snippetTokens) => snippetTokens.some((snippetToken) => {
    if (snippetToken === dealerToken) return true
    if (dealerToken.length < 6 || snippetToken.length < 6) return false
    return dealerToken.startsWith(snippetToken.slice(0, 6)) || snippetToken.startsWith(dealerToken.slice(0, 6))
})

const reviewCount = (text) => {
    const matches = [...text.matchAll(/([\d\s]{1,7})\s*(?:оцен|отзыв)/gi)]
    return matches.reduce((sum, match) => sum + (Number(match[1].replace(/\s/g, '')) || 0), 0)
}

const plainAddress = (address) => String(address ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim()

function pickBest(dealer, cards) {
    const cityTokens = tokens(dealer.city)
    const streetTokens = tokens(dealer.address)
    const house = houseNumber(dealer.address)

    let best = null

    for (const card of cards) {
        const text = card.text || ''
        if (!normalize(text).includes('автосеть')) continue

        const snippetTokens = normalize(text).split(' ')
        const cityMatch = cityTokens.every((token) => snippetTokens.includes(token))
        const streetMatch = streetTokens.some((token) => tokenMatches(token, snippetTokens))
        const houseMatch = Boolean(house) && snippetTokens.includes(house)

        let score = 0
        if (cityMatch) score += 2
        if (streetMatch) score += 3
        if (houseMatch) score += 2
        if (IS_DEALER.test(text)) score += 2
        if (NOT_DEALER.test(text)) score -= 5
        score += Math.min(reviewCount(text), 2000) / 2000

        if (!cityMatch || (!streetMatch && !houseMatch)) continue
        if (!best || score > best.score) best = {...card, score}
    }

    return best
}

const browser = await chromium.launchPersistentContext(BROWSER_PROFILE, {
    channel: BROWSER_CHANNEL,
    headless: false,
    viewport: {width: 1400, height: 900},
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    args: ['--disable-blink-features=AutomationControlled'],
})
const page = browser.pages()[0] || await browser.newPage()

const dealers = (await getDealersForReviewLinks())
    .filter((dealer) => !onlyIds || onlyIds.has(dealer.id))
    .slice(0, limit)

console.log(`Точек к обработке: ${dealers.length}${apply ? ' (ссылки будут записаны в базу)' : ' (режим проверки)'}`)

let found = 0
let notFound = 0
const results = []

try {
    for (const dealer of dealers) {
        const query = `Автосеть.рф ${dealer.city} ${plainAddress(dealer.address)}`
        const url = `https://yandex.ru/maps/?text=${encodeURIComponent(query)}`

        await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 90_000})
        await page.locator('a[href*="/maps/org/"]').first().waitFor({state: 'attached', timeout: 20_000}).catch(() => {})
        await page.waitForTimeout(1500)

        const bodyText = await page.locator('body').innerText().catch(() => '')
        if (/подтвердите, что вы не робот|captcha/i.test(bodyText)) {
            throw new Error('Яндекс показал капчу. Подождите немного и запустите сбор снова.')
        }

        const cards = await page.evaluate(() => {
            const out = []
            const seen = new Set()
            for (const a of document.querySelectorAll('a[href*="/maps/org/"]')) {
                const match = a.getAttribute('href').match(/^\/maps\/org\/([^/]+)\/(\d+)/)
                if (!match || seen.has(match[2])) continue
                seen.add(match[2])

                let node = a
                for (let i = 0; i < 8 && node; i++) {
                    if (node.className && String(node.className).includes('search-snippet-view')) break
                    node = node.parentElement
                }
                const text = node && node.className && String(node.className).includes('search-snippet-view')
                    ? node.innerText.replace(/\s+/g, ' ').trim()
                    : ''

                out.push({
                    id: match[2],
                    slug: match[1],
                    reviewsHref: `https://yandex.ru/maps/org/${match[1]}/${match[2]}/reviews/`,
                    text,
                })
            }
            return out
        })

        // при единственном совпадении Яндекс открывает карточку организации без списка результатов:
        // адрес и категорию берём из заголовка её страницы
        const orgTitle = async (card) => {
            await page.goto(`https://yandex.ru/maps/org/${card.slug}/${card.id}/`, {
                waitUntil: 'domcontentloaded',
                timeout: 90_000,
            })
            await page.waitForTimeout(2000)
            return page.title().catch(() => '')
        }

        for (const card of cards) {
            if (card.text) continue
            card.text = await orgTitle(card)
            card.enriched = true
        }

        let best = pickBest(dealer, cards)

        // в рекламных сниппетах адреса может не быть — тогда сверяем заголовки карточек организаций
        if (!best) {
            for (const card of cards) {
                if (card.enriched) continue
                card.text = `${await orgTitle(card)} ${card.text}`
                card.enriched = true
            }
            best = pickBest(dealer, cards)
        }
        const label = `${dealer.id} ${dealer.city}, ${dealer.address.replace(/<br\s*\/?>/gi, ' ')}`

        if (best) {
            found++
            results.push({id: dealer.id, city: dealer.city, address: dealer.address, url: best.reviewsHref})
            console.log(`✓ ${label} -> ${best.reviewsHref}  [${best.score.toFixed(2)}]`)
            if (apply) await saveDealerReviewLink(dealer.id, 'yandex', best.reviewsHref)
        } else {
            notFound++
            results.push({id: dealer.id, city: dealer.city, address: dealer.address, url: null})
            console.log(`— ${label}: не найдено (карточек: ${cards.length})`)
        }

        if (values.debug) {
            for (const card of cards) {
                console.log(`    [${card.id}] ${String(card.text).replace(/\s+/g, ' ').slice(0, 180)}`)
            }
        }

        await page.waitForTimeout(1200)
    }
} finally {
    await browser.close()
    await closeDb()
}

console.log(`\nНайдено: ${found}, не найдено: ${notFound}`)
if (!apply && found) console.log('Чтобы записать ссылки в базу, запустите с --apply')
