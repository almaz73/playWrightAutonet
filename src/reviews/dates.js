const MONTHS = {
    январь: 1, января: 1,
    февраль: 2, февраля: 2,
    март: 3, марта: 3,
    апрель: 4, апреля: 4,
    май: 5, мая: 5,
    июнь: 6, июня: 6,
    июль: 7, июля: 7,
    август: 8, августа: 8,
    сентябрь: 9, сентября: 9,
    октябрь: 10, октября: 10,
    ноябрь: 11, ноября: 11,
    декабрь: 12, декабря: 12,
}

const pad = (value) => String(value).padStart(2, '0')

// приводит дату отзыва к YYYY-MM-DD; понимает ISO, DD.MM.YYYY и «12 ноября 2025»
export function parseReviewDate(value) {
    if (!value) return null
    const text = String(value).trim()
    if (!text) return null

    let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (match) return `${match[1]}-${match[2]}-${match[3]}`

    match = text.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/)
    if (match) return `${match[3]}-${pad(match[2])}-${pad(match[1])}`

    match = text.toLowerCase().match(/^(\d{1,2})\s+([а-яё]+)\s+(\d{4})/)
    if (match && MONTHS[match[2]]) return `${match[3]}-${pad(MONTHS[match[2]])}-${pad(match[1])}`

    const parsed = new Date(text)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
    return null
}

// отзыв попадает в выборку, если он не старше указанного числа лет; дата без года считается свежей
export function isWithinYears(date, years, now = new Date()) {
    if (!date) return true
    const border = new Date(now)
    border.setFullYear(border.getFullYear() - years)
    return new Date(`${date}T00:00:00Z`) >= new Date(`${border.toISOString().slice(0, 10)}T00:00:00Z`)
}
