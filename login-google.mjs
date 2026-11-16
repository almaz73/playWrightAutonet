import {chromium} from 'playwright'
import {BROWSER_PROFILE, BROWSER_CHANNEL} from './src/config.js'

const context = await chromium.launchPersistentContext(BROWSER_PROFILE, {
    channel: BROWSER_CHANNEL,
    headless: false,
    viewport: {width: 1400, height: 900},
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    args: ['--disable-blink-features=AutomationControlled'],
})
const page = context.pages()[0] || await context.newPage()
await page.goto('https://accounts.google.com/ServiceLogin?hl=ru', {waitUntil: 'domcontentloaded', timeout: 90_000})
console.log('Войдите в Google-аккаунт в открывшемся окне. Ожидание до 10 минут...')

const deadline = Date.now() + 10 * 60 * 1000
let signedIn = false
while (Date.now() < deadline) {
    await page.waitForTimeout(2000)
    const cookies = await context.cookies('https://www.google.com')
    if (cookies.some((cookie) => cookie.name === 'SID' || cookie.name === 'SAPISID')) {
        signedIn = true
        break
    }
}

if (signedIn) {
    console.log('Вход выполнен, cookies сохранены в профиле. Закрываю окно через 5 секунд.')
    await page.waitForTimeout(5000)
} else {
    console.log('Вход не выполнен за 10 минут. Окно закрыто.')
}
await context.close()
