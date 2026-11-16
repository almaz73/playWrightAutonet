// Поиск страниц отзывов Google Карт для каждой точки из таблицы dealers.
// Google отдаёт места в браузере; в ссылке карточки есть place id (!19sChIJ…),
// из него собираем стабильный адрес https://www.google.com/maps/place/?q=place_id:…
//   node src/reviews/collect-google-links.mjs            — только показать найденное
//   node src/reviews/collect-google-links.mjs --apply    — записать ссылки в dealers.reviews_google
//   --limit=5 / --id=8,9 / --debug                       — обработать часть точек

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
    'строение', 'стр', 'дом', 'россия', 'татарстан', 'республика', 'область',
])

const normalize = (value) => String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tokens = (value) => normalize(value).split(' ').filter((token) => token.length >= 4 && !GENERIC_WORDS.has(token))

// дом берём из хвоста адреса: полный номер без разделителей и его числовая основа
// («182/1» в базе и «182» в Google — один дом)
const houseParts = (address) => {
    const parts = String(address ?? '').split(',')
    let tail = parts[parts.length - 1]
    if (!/\d/.test(tail)) tail = String(address ?? '')
    tail = normalize(tail)
    return {
        base: (tail.match(/^\d+[а-я]?/) || [''])[0],
        full: tail.replace(/^[^0-9]+/, '').replace(/[^0-9а-я]+/g, ''),
    }
}

const tokenMatches = (dealerToken, cardTokens) => cardTokens.some((cardToken) => {
    if (cardToken === dealerToken) return true
    if (dealerToken.length < 6 || cardToken.length < 6) return false
    return dealerToken.startsWith(cardToken.slice(0, 6)) || cardToken.startsWith(dealerToken.slice(0, 6))
})

const plainAddress = (address) => String(address ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim()

function pickBest(dealer, cards) {
    const cityTokens = tokens(dealer.city)
    const streetTokens = tokens(dealer.address)
    const {full: house, base: baseHouse} = houseParts(dealer.address)

    let best = null

    for (const card of cards) {
        const text = card.text || ''
        const normalized = normalize(text)
        if (!normalized.includes('автосеть')) continue

        const cardTokens = normalized.split(' ')
        const compact = normalized.replace(/\s+/g, '')
        const cityMatch = cityTokens.every((token) => cardTokens.includes(token))
        // в списке результатов Google адрес без города, поэтому улица — главный признак
        const streetMatch = streetTokens.some((token) => tokenMatches(token, cardTokens))
        const houseMatch = house.length >= 2 && (compact.includes(house) || (baseHouse.length >= 2 && compact.includes(baseHouse)))

        let score = 0
        if (cityMatch) score += 2
        if (streetMatch) score += 3
        if (houseMatch) score += 2
        if (/автосалон|официальный дилер|автомобилей с пробегом|дилер/i.test(text)) score += 2

        if (!streetMatch) continue
        card.score = score
        if (!best || score > best.score) best = {...card, score}
    }

    return best
}

// Координатная пара места в ссылке Google: !1s0x<hex>:0x<hex>; cid — это второй hex в десятичном виде
const FTID_PAIR_RE = /(0x[0-9a-f]+):(0x[0-9a-f]+)/i

const toCid = (ftid) => {
    const match = String(ftid).match(FTID_PAIR_RE)
    return match ? BigInt(match[2]).toString() : ''
}

const collectCards = (page) => page.evaluate(() => {
    const out = []
    const seen = new Set()

    for (const a of document.querySelectorAll('a[href*="/maps/place/"]')) {
        const href = a.href
        const match = href.match(/!1s(0x[0-9a-f]+):(0x[0-9a-f]+)/i)
        if (!match) continue
        const ftid = `${match[1]}:${match[2]}`
        if (seen.has(ftid)) continue
        seen.add(ftid)

        // карточкой считаем ближайший контейнер ровно с одной ссылкой на место
        let node = a
        let text = ''
        for (let i = 0; i < 12 && node; i++) {
            const inner = (node.innerText || '').replace(/\s+/g, ' ').trim()
            const placeLinks = node.querySelectorAll('a[href*="/maps/place/"]').length
            if (placeLinks === 1 && inner.length >= 20 && inner.length <= 600) {
                text = inner
                break
            }
            if (placeLinks > 1) break
            node = node.parentElement
        }

        out.push({ftid, text: text || (a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()})
    }

    return out
})

async function scrollFeed(page) {
    const feed = page.locator('div[role="feed"]').first()
    if (!(await feed.count())) return

    let previous = 0
    for (let i = 0; i < 12; i++) {
        const count = await page.locator('a[href*="/maps/place/"]').count()
        if (count === previous && i > 1) break
        previous = count
        await feed.evaluate((node) => { node.scrollTop = node.scrollHeight })
        await page.waitForTimeout(1200)
    }
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

async function search(dealer) {
    const query = `Автосеть.рф ${dealer.city} ${plainAddress(dealer.address)}`
    return searchQuery(query)
}

async function searchQuery(query) {
    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=ru`
    const response = await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 90_000})
    if (response?.status() === 429) {
        throw new Error('Google ограничил доступ (код 429). Подождите и запустите сбор снова.')
    }

    // список результатов или сразу карточка единственного места
    await page.waitForSelector('div[role="feed"] a[href*="/maps/place/"], [data-item-id="address"]', {timeout: 30_000}).catch(() => {})
    await page.waitForTimeout(4000)

    const bodyText = await page.locator('body').innerText().catch(() => '')
    if (/unusual traffic|необычный трафик|подтвердите, что вы не робот/i.test(bodyText)) {
        throw new Error('Google показал проверку на робота. Подождите немного и запустите сбор снова.')
    }

    const cards = await collectCards(page)
    if (cards.length) return cards

    // единственный результат открывается сразу карточкой места: ftid берём из адреса страницы
    const current = page.url()
    const match = current.match(/!1s(0x[0-9a-f]+):(0x[0-9a-f]+)/i)
    if (match) {
        const title = await page.title().catch(() => '')
        // заголовок одиночной карточки содержит название места — отсекаем чужие организации
        if (!normalize(title).includes('автосеть')) return []
        const address = await page.locator('[data-item-id="address"]').first()
            .getAttribute('aria-label')
            .catch(() => null)
            || await page.locator('[data-item-id="address"]').first().innerText().catch(() => '')
        return [{ftid: `${match[1]}:${match[2]}`, text: `${title} ${address}`}]
    }

    return []
}

try {
    for (const dealer of dealers) {
        const label = `${dealer.id} ${dealer.city}, ${plainAddress(dealer.address)}`

        try {
            let cards = await search(dealer)
            let best = pickBest(dealer, cards)

            // если по адресу ничего не нашлось, ищем всю сеть в городе и сверяем адреса карточек
            if (!best) {
                cards = await searchQuery(`Автосеть.рф ${dealer.city}`)
                await scrollFeed(page)
                cards = await collectCards(page)
                best = pickBest(dealer, cards)
            }

            if (best) {
                found++
                const href = `https://www.google.com/maps?cid=${toCid(best.ftid)}`
                console.log(`✓ ${label} -> ${href}  [${best.score.toFixed(2)}]`)
                if (apply) await saveDealerReviewLink(dealer.id, 'google', href)
            } else {
                notFound++
                console.log(`— ${label}: не найдено (карточек: ${cards.length})`)
            }

            if (values.debug) {
                for (const card of cards) {
                    const mark = best && card.ftid === best.ftid ? '*' : ' '
                    console.log(`  ${mark} [${card.ftid}] ${card.score !== undefined ? card.score.toFixed(2) : '—'} ${String(card.text).replace(/\s+/g, ' ').slice(0, 180)}`)
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
