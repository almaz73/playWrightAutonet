// Поиск страниц отзывов 2ГИС для каждой точки из таблицы dealers.
// 2ГИС отдаёт поиск только браузеру с исполнением JS, поэтому запускаем с окном Chrome.
//   node src/reviews/collect-2gis-links.mjs            — только показать найденное
//   node src/reviews/collect-2gis-links.mjs --apply    — записать ссылки в dealers.reviews_2gis
//   --limit=5 / --id=8,9                               — обработать часть точек

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
    'строение', 'стр', 'дом', 'россия', 'татарстан', 'республика',
])

// кузовной цех и сервис — отдельные организации 2ГИС с собственными отзывами
const NOT_DEALER = /станция зарядки|электромобил|шиномонтаж|автомойка|парковка|пункт выдачи|кузовн|малярн/i
const SHOWROOM = /автосалон|салон автомобилей|официальный дилер|продажа автомобилей|продажа легковых|автомобилей с пробегом|дилерск/i
const SERVICE = /сервисный центр|автосервис|техцентр|кузовн|малярн|шиномонтаж|автомойка/i

const normalize = (value) => String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tokens = (value) => normalize(value).split(' ').filter((token) => token.length >= 4 && !GENERIC_WORDS.has(token))

// дом берём из хвоста адреса и сравниваем «слитно»: 2ГИС пишет «212 к2», «10а»
const houseNumber = (address) => {
    const parts = normalize(address).split(',')
    let tail = parts[parts.length - 1].trim()
    if (!/\d/.test(tail)) tail = normalize(address)
    return tail.replace(/^[^0-9]+/, '').replace(/[^0-9а-я]+/g, '')
}

// слова улиц сравниваем по началу: в базе встречаются опечатки
const tokenMatches = (dealerToken, snippetTokens) => snippetTokens.some((snippetToken) => {
    if (snippetToken === dealerToken) return true
    if (dealerToken.length < 6 || snippetToken.length < 6) return false
    return dealerToken.startsWith(snippetToken.slice(0, 6)) || snippetToken.startsWith(dealerToken.slice(0, 6))
})

const reviewCount = (text) => {
    const matches = [...text.matchAll(/(\d{1,3}(?:\s\d{3})*)\s*(?:оцен|отзыв)/gi)]
    return matches.reduce((sum, match) => sum + (Number(match[1].replace(/\s/g, '')) || 0), 0)
}

const plainAddress = (address) => String(address ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim()

function pickBest(dealer, cards) {
    const cityTokens = tokens(dealer.city)
    const streetTokens = tokens(dealer.address)
    const house = houseNumber(dealer.address)
    // бренды точки: «Tenet Автосеть РФ Легковой автосервис» — на деле брендовый салон,
    // категория 2ГИС у таких карточек бывает сервисной
    const brandTokens = normalize(dealer.brands).split(' ').filter((token) => token.length >= 3)

    let best = null

    for (const card of cards) {
        const text = card.text || ''
        const normalized = normalize(text)
        if (!normalized.includes('автосеть')) continue

        const cardTokens = normalized.split(' ')
        const cityMatch = cityTokens.every((token) => cardTokens.includes(token))
        const streetMatch = streetTokens.some((token) => tokenMatches(token, cardTokens))
        const houseMatch = house.length >= 2 && normalized.replace(/\s+/g, '').includes(house)
        const brandMatch = brandTokens.some((token) => cardTokens.includes(token))
        const hasReviews = reviewCount(text) > 0 || /подтверждён\s*\(\d+\)/i.test(text)

        // карточка самой сети («Автосеть.РФ Автосалон»), а не брендового салона внутри неё
        const network = normalized.startsWith('автосеть ')
        const showroom = SHOWROOM.test(text) || brandMatch
        const service = SERVICE.test(text)

        let score = 0
        if (cityMatch) score += 2
        if (streetMatch) score += 3
        if (houseMatch) score += 2
        if (showroom) score += 3
        // пустую карточку сети пропускаем в пользу брендового салона с отзывами
        if (network && hasReviews) score += 2
        if (service && !showroom) score -= 4
        if (NOT_DEALER.test(text)) score -= 5
        score += Math.min(reviewCount(text), 2000) / 2000

        if (!cityMatch || (!streetMatch && !houseMatch)) continue
        card.score = score
        if (!best || score > best.score) best = {...card, score, network}
    }

    return best
}

const collectCards = (page) => page.evaluate(() => {
    const out = []
    const seen = new Set()

    for (const a of document.querySelectorAll('a[href*="/firm/"]')) {
        const href = a.href
        const match = href.match(/\/firm\/(\d+)/)
        if (!match || seen.has(match[1])) continue
        seen.add(match[1])

        // карточкой считаем ближайший контейнер ровно с одной ссылкой на организацию
        let node = a
        let card = null
        for (let i = 0; i < 12 && node; i++) {
            const text = (node.innerText || '').replace(/\s+/g, ' ').trim()
            const firmLinks = node.querySelectorAll('a[href*="/firm/"]').length
            if (firmLinks === 1 && text.length >= 40 && text.length <= 600) {
                card = text
                break
            }
            if (firmLinks > 1) break
            node = node.parentElement
        }

        const firmUrl = href.split('?')[0].split('/tab/')[0]
        out.push({
            id: match[1],
            reviewsHref: `${firmUrl}/tab/reviews`,
            text: card || (a.innerText || '').replace(/\s+/g, ' ').trim(),
        })
    }

    return out
})

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

async function search(query) {
    const url = `https://2gis.ru/search/${encodeURIComponent(query)}`
    const response = await page.goto(url, {waitUntil: 'commit', timeout: 90_000})
    const status = response?.status()
    if (status === 403 || status === 429) {
        throw new Error(`2ГИС ограничил доступ (код ${status}). Подождите и запустите сбор снова.`)
    }

    await page.locator('a[href*="/firm/"]').first().waitFor({state: 'attached', timeout: 30_000}).catch(() => {})
    await page.waitForTimeout(4000)

    const bodyText = await page.locator('body').innerText().catch(() => '')
    if (/подтвердите, что вы не робот|captcha/i.test(bodyText)) {
        throw new Error('2ГИС показал капчу. Подождите немного и запустите сбор снова.')
    }

    return collectCards(page)
}

try {
    for (const dealer of dealers) {
        const address = plainAddress(dealer.address)
        const label = `${dealer.id} ${dealer.city}, ${address}`

        try {
            let cards = await search(`Автосеть.рф ${dealer.city} ${address}`)
            let best = pickBest(dealer, cards)

            // по точному адресу 2ГИС может показать только сервис или брендовый салон,
            // тогда ищем карточку самой сети по всему городу
            if (!best || !best.network) {
                const wide = await search(`Автосеть.рф ${dealer.city}`)
                const byId = new Map(cards.map((card) => [card.id, card]))
                for (const card of wide) if (!byId.has(card.id)) byId.set(card.id, card)
                cards = [...byId.values()]
                best = pickBest(dealer, cards)
            }

            if (best) {
                found++
                console.log(`✓ ${label} -> ${best.reviewsHref}  [${best.score.toFixed(2)}]`)
                if (apply) await saveDealerReviewLink(dealer.id, '2gis', best.reviewsHref)
            } else {
                notFound++
                console.log(`— ${label}: не найдено (карточек: ${cards.length})`)
            }

            if (values.debug) {
                for (const card of cards) {
                    const mark = best && card.id === best.id ? '*' : ' '
                    console.log(`  ${mark} [${card.id}] ${card.score !== undefined ? card.score.toFixed(2) : '—'} ${String(card.text).replace(/\s+/g, ' ').slice(0, 180)}`)
                }
            }
        } catch (error) {
            notFound++
            console.log(`! ${label}: ${error.message}`)
        }

        await page.waitForTimeout(1500)
    }
} finally {
    await browser.close()
    await closeDb()
}

console.log(`\nНайдено: ${found}, не найдено: ${notFound}`)
if (!apply && found) console.log('Чтобы записать ссылки в базу, запустите с --apply')
