// Запись ссылок Авито в dealers.reviews_avito по адресу точки.
// Формат строки: «Казань, пр. Ямашева, 115а | https://www.avito.ru/...»
// либо по id:    «8 | https://www.avito.ru/...»
// Разделитель: | => ; или табуляция; пустые строки и #-комментарии пропускаются.
//   node src/reviews/apply-avito-links.mjs links.txt
//   node src/reviews/apply-avito-links.mjs links.txt --apply

import fs from 'fs'
import {closeDb, getDealersForReviewLinks, saveDealerReviewLink} from '../db.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const file = args.find((arg) => !arg.startsWith('--'))

if (!file) {
    console.error('Укажите файл со ссылками: node src/reviews/apply-avito-links.mjs links.txt [--apply]')
    process.exit(1)
}

const GENERIC_WORDS = new Set([
    'улица', 'проспект', 'просп', 'шоссе', 'переулок', 'бульвар', 'пом', 'помещение',
    'строение', 'стр', 'дом', 'россия', 'республика', 'область',
])

const normalize = (value) => String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tokens = (value) => normalize(value)
    .split(' ')
    .filter((token) => token.length >= 4 && !GENERIC_WORDS.has(token))

const tokenMatches = (dealerToken, lineTokens) => lineTokens.some((lineToken) => {
    if (lineToken === dealerToken) return true
    if (dealerToken.length < 6 || lineToken.length < 6) return false
    return dealerToken.startsWith(lineToken.slice(0, 6)) || lineToken.startsWith(dealerToken.slice(0, 6))
})

// дом сравниваем слитно: «115а», «10/22», «37 А, стр.1»
const houseNumber = (address) => {
    const parts = String(address ?? '').split(',')
    let tail = parts[parts.length - 1].trim()
    if (!/\d/.test(tail)) tail = String(address ?? '')
    return normalize(tail).replace(/^[^0-9]+/, '').replace(/[^0-9а-я]+/g, '')
}

function matchDealer(dealer, line) {
    const lineTokens = normalize(line).split(' ')
    const streetTokens = tokens(dealer.address)
    const cityTokens = tokens(dealer.city)
    const house = houseNumber(dealer.address)

    const streetMatch = streetTokens.some((token) => tokenMatches(token, lineTokens))
    if (!streetMatch) return 0

    let score = 3
    if (cityTokens.every((token) => lineTokens.includes(token))) score += 2
    if (house.length >= 2 && normalize(line).replace(/\s+/g, '').includes(house)) score += 2
    return score
}

const parseLine = (line) => {
    const cleaned = line.replace(/^\s*#.*$/, '').trim()
    if (!cleaned) return null
    const parts = cleaned.split(/\s*(?:\||=>|;|\t)\s*/)
    if (parts.length < 2) return null
    const url = parts[parts.length - 1].trim()
    const key = parts.slice(0, -1).join(' ').trim()
    return {key, url}
}

const isAvitoUrl = (url) => {
    try {
        const {hostname, protocol} = new URL(url)
        return protocol === 'https:' && (hostname === 'avito.ru' || hostname.endsWith('.avito.ru'))
    } catch {
        return false
    }
}

const dealers = await getDealersForReviewLinks()
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)

let saved = 0
let failed = 0

for (const raw of lines) {
    const entry = parseLine(raw)
    if (!entry) continue

    let dealer = null
    let how = ''

    if (/^\d+$/.test(entry.key)) {
        dealer = dealers.find((item) => item.id === Number(entry.key)) || null
        how = `id ${entry.key}`
    } else {
        let best = 0
        for (const candidate of dealers) {
            const score = matchDealer(candidate, entry.key)
            if (score > best) {
                best = score
                dealer = candidate
            }
        }
        how = `адрес (${best})`
    }

    if (!dealer) {
        failed++
        console.log(`✗ ${entry.key}: точка не найдена`)
        continue
    }
    if (!isAvitoUrl(entry.url)) {
        failed++
        console.log(`✗ ${dealer.id} ${dealer.city}, ${dealer.address}: не ссылка Авито — ${entry.url}`)
        continue
    }

    saved++
    console.log(`${apply ? '✓' : '·'} ${dealer.id} ${dealer.city}, ${dealer.address.replace(/<br\s*\/?>/gi, ' ')} ← ${entry.url}  [${how}]`)
    if (apply) await saveDealerReviewLink(dealer.id, 'avito', entry.url)
}

console.log(`\n${apply ? 'Записано' : 'Распознано'}: ${saved}, ошибок: ${failed}`)
if (!apply && saved) console.log('Чтобы записать в базу, запустите с --apply')

await closeDb()
