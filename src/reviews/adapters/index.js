// площадка определяется по адресу страницы
const PLATFORMS = [
    {name: 'yandex', host: /(^|\.)yandex\.[a-z.]+$/i},
    {name: '2gis', host: /(^|\.)2gis\.[a-z.]+$/i},
    {name: 'avito', host: /(^|\.)avito\.[a-z.]+$/i},
    {name: 'google', host: /(^|\.)(google\.[a-z.]+|googleusercontent\.com|maps\.app\.goo\.gl|goo\.gl)$/i},
]

export function detectPlatform(url) {
    let host
    try {
        host = new URL(url).hostname
    } catch (error) {
        return null
    }
    return PLATFORMS.find((platform) => platform.host.test(host))?.name ?? null
}

// адаптер площадки должен экспортировать collect(page, {url, years}) и вернуть массив отзывов:
// {external_id, fio, date: 'YYYY-MM-DD', review, link, respondent, dateAnswer: 'YYYY-MM-DD', answer, rating}
// адаптер сам открывает нужную страницу: у площадок разные адреса лент отзывов
export async function loadAdapter(platform) {
    try {
        const module = await import(`./${platform}.js`)
        return module.default
    } catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND') {
            throw new Error(`Адаптер для площадки «${platform}» ещё не реализован: src/reviews/adapters/${platform}.js`)
        }
        throw error
    }
}
