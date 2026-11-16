import path from 'path'
import {fileURLToPath} from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = path.resolve(__dirname, '..')

// база основного сайта; на сервере путь можно переопределить через CLIENT_DB_PATH
export const CLIENT_DB_PATH = process.env.CLIENT_DB_PATH
    || path.resolve(PROJECT_ROOT, '../autonet/autonet_backend/client.sqlite')

// за какой период собираем отзывы
export const REVIEW_YEARS = Number(process.env.REVIEW_YEARS) || 1

// Яндекс.Карты отвечают 429 на headless-запросы, поэтому по умолчанию открываем окно Chrome.
// HEADLESS=1 — принудительно запустить без окна (остальные площадки могут это позволять).
export const HEADLESS = process.env.HEADLESS === '1'

// постоянный профиль браузера: хранит cookies и не показывает окно авторизации при каждом сборе
export const BROWSER_PROFILE = process.env.BROWSER_PROFILE || path.resolve(PROJECT_ROOT, '.browser-profile')

// Chrome с обычным набором функций выглядит для площадок естественнее встроенного Chromium
export const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chrome'

// адрес локальной версии сайта для будущих тестов
export const LOCAL_SITE_URL = process.env.LOCAL_SITE_URL || 'http://127.0.0.1:3000'
