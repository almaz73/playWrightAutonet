import fs from 'fs'
import {open} from 'sqlite'
import sqlite3 from 'sqlite3'
import {CLIENT_DB_PATH} from './config.js'

let db

async function getDb() {
    if (db) return db
    if (!fs.existsSync(CLIENT_DB_PATH)) {
        throw new Error(`Не найден файл базы ${CLIENT_DB_PATH}. Укажите путь в CLIENT_DB_PATH.`)
    }
    // только чтение/запись существующей базы: пустой файл по ошибке не создаём
    db = await open({filename: CLIENT_DB_PATH, driver: sqlite3.Database})
    return db
}

const INSERT_SQL = `
    INSERT INTO review (platform, external_id, fio, date, review, link, respondent, dateAnswer, answer, rating, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, external_id) DO UPDATE SET
        fio        = excluded.fio,
        date       = excluded.date,
        review     = excluded.review,
        link       = excluded.link,
        respondent = excluded.respondent,
        dateAnswer = excluded.dateAnswer,
        answer     = excluded.answer,
        rating     = excluded.rating
`

const UPDATE_SQL = `
    UPDATE review
    SET fio        = ?,
        date       = ?,
        review     = ?,
        link       = ?,
        respondent = ?,
        dateAnswer = ?,
        answer     = ?,
        rating     = ?
    WHERE platform = ?
      AND link IS ?
      AND fio IS ?
      AND date IS ?
`

// сохранение собранных отзывов: повторный сбор обновляет запись, а не создаёт дубль
export async function saveReviews(platform, items) {
    const conn = await getDb()
    const before = await countReviews(platform)

    await conn.exec('BEGIN')
    try {
        for (const item of items) {
            const values = [
                item.fio ?? null,
                item.date ?? null,
                item.review ?? null,
                item.link ?? null,
                item.respondent ?? null,
                item.dateAnswer ?? null,
                item.answer ?? null,
                item.rating ?? null,
            ]

            if (item.external_id) {
                await conn.run(INSERT_SQL, [platform, String(item.external_id), ...values, new Date().toISOString()])
            } else {
                // без внешнего id обновляем по совокупности полей отзыва
                const result = await conn.run(UPDATE_SQL, [...values, platform, item.link ?? null, item.fio ?? null, item.date ?? null])
                if (!result.changes) {
                    await conn.run(INSERT_SQL, [platform, null, ...values, new Date().toISOString()])
                }
            }
        }
        await conn.exec('COMMIT')
    } catch (error) {
        await conn.exec('ROLLBACK')
        throw error
    }

    const after = await countReviews(platform)
    return {added: after - before, updated: items.length - (after - before)}
}

export async function countReviews(platform) {
    const conn = await getDb()
    const row = platform
        ? await conn.get('SELECT COUNT(*) AS n FROM review WHERE platform = ?', [platform])
        : await conn.get('SELECT COUNT(*) AS n FROM review')
    return row.n
}

export async function closeDb() {
    if (!db) return
    await db.close()
    db = undefined
}

// дилерские центры, для которых ищем страницы отзывов на площадках
export async function getDealersForReviewLinks() {
    const conn = await getDb()
    return conn.all(`
        SELECT id, city, address, profile, brands, link
        FROM dealers
        ORDER BY id
    `)
}

const REVIEW_LINK_COLUMNS = {
    yandex: 'reviews_yandex',
    google: 'reviews_google',
    '2gis': 'reviews_2gis',
    avito: 'reviews_avito',
}

export async function saveDealerReviewLink(id, platform, url) {
    const column = REVIEW_LINK_COLUMNS[platform]
    if (!column) throw new Error(`Площадка ${platform} пока не поддерживается`)
    const conn = await getDb()
    await conn.run(`UPDATE dealers SET ${column} = ? WHERE id = ?`, [url, id])
}
