import {computed, createApp, onMounted, ref} from '/vue.js'

createApp({
    setup() {
        const environments = ref([])
        const environment = ref('local')
        const running = ref(false)
        const result = ref(null)
        const error = ref('')
        const progress = ref({phase: 'idle', total: 0, done: 0, current: null})
        const detailsHidden = ref(false)
        let progressTimer = null
        const filterRunning = ref(false)
        const filterResult = ref(null)
        const filterError = ref('')
        const filterProgress = ref({phase: 'idle', total: 0, done: 0, current: null})
        const filterDetailsHidden = ref(false)
        let filterTimer = null
        const carsFilterRunning = ref(false)
        const carsFilterResult = ref(null)
        const carsFilterError = ref('')
        const carsFilterProgress = ref({phase: 'idle', total: 0, done: 0, current: null})
        const carsFilterDetailsHidden = ref(false)
        let carsFilterTimer = null
        const bannersRunning = ref(false)
        const bannersResult = ref(null)
        const bannersError = ref('')
        const bannersProgress = ref({phase: 'idle', total: 0, done: 0, current: null})
        const bannersDetailsHidden = ref(false)
        let bannersTimer = null

        const currentBase = computed(() => environments.value.find((env) => env.value === environment.value)?.baseUrl || '')
        const canRun = computed(() => !running.value)
        const progressText = computed(() => {
            const state = progress.value
            if (state.phase === 'starting' || state.phase === 'discovering') return 'Читаем меню на главной…'
            if (state.total) return `Проверено ${state.done} из ${state.total}`
            return 'Проверяем…'
        })
        const filterProgressText = computed(() => {
            const state = filterProgress.value
            if (state.phase === 'starting') return 'Запускаем проверку фильтра…'
            if (state.total) return `Шаг ${Math.min(state.done + 1, state.total)} из ${state.total}`
            return 'Проверяем фильтр…'
        })
        const carsFilterProgressText = computed(() => {
            const state = carsFilterProgress.value
            if (state.phase === 'starting') return 'Запускаем проверку фильтра на /cars…'
            if (state.total) return `Шаг ${Math.min(state.done + 1, state.total)} из ${state.total}`
            return 'Проверяем фильтр на /cars…'
        })
        const bannersProgressText = computed(() => {
            const state = bannersProgress.value
            if (state.phase === 'starting') return 'Запускаем проверку баннеров…'
            if (state.total) return `Шаг ${Math.min(state.done + 1, state.total)} из ${state.total}`
            return 'Проверяем баннеры…'
        })

        const formatDate = (value) => new Date(value).toLocaleString('ru-RU')

        const pollProgress = async () => {
            try {
                const response = await fetch('/api/progress', {cache: 'no-store'})
                if (response.ok) progress.value = await response.json()
            } catch {
                // следующий опрос повторит запрос
            }
        }

        const pollFilterProgress = async () => {
            try {
                const response = await fetch('/api/filter-progress', {cache: 'no-store'})
                if (response.ok) filterProgress.value = await response.json()
            } catch {
                // следующий опрос повторит запрос
            }
        }

        const pollCarsFilterProgress = async () => {
            try {
                const response = await fetch('/api/cars-filter-progress', {cache: 'no-store'})
                if (response.ok) carsFilterProgress.value = await response.json()
            } catch {
                // следующий опрос повторит запрос
            }
        }

        const pollBannersProgress = async () => {
            try {
                const response = await fetch('/api/banners-progress', {cache: 'no-store'})
                if (response.ok) bannersProgress.value = await response.json()
            } catch {
                // следующий опрос повторит запрос
            }
        }

        onMounted(async () => {
            const response = await fetch('/api/options')
            const data = await response.json()
            environments.value = data.environments
        })

        const run = async () => {
            running.value = true
            error.value = ''
            result.value = null
            detailsHidden.value = false
            progress.value = {phase: 'starting', total: 0, done: 0, current: null}
            progressTimer = setInterval(pollProgress, 500)
            pollProgress()
            try {
                const response = await fetch('/api/run', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({environment: environment.value}),
                })
                const data = await response.json()
                if (!response.ok) throw new Error(data.error || 'Не удалось запустить проверку')
                result.value = data
            } catch (runError) {
                error.value = runError.message
            } finally {
                clearInterval(progressTimer)
                progressTimer = null
                running.value = false
            }
        }

        const runFilter = async () => {
            filterRunning.value = true
            filterError.value = ''
            filterResult.value = null
            filterDetailsHidden.value = false
            filterProgress.value = {phase: 'starting', total: 0, done: 0, current: null}
            filterTimer = setInterval(pollFilterProgress, 500)
            pollFilterProgress()
            try {
                const response = await fetch('/api/filter-run', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({environment: environment.value}),
                })
                const data = await response.json()
                if (!response.ok) throw new Error(data.error || 'Не удалось запустить проверку')
                filterResult.value = data
            } catch (runError) {
                filterError.value = runError.message
            } finally {
                clearInterval(filterTimer)
                filterTimer = null
                filterRunning.value = false
            }
        }

        const runCarsFilter = async () => {
            carsFilterRunning.value = true
            carsFilterError.value = ''
            carsFilterResult.value = null
            carsFilterDetailsHidden.value = false
            carsFilterProgress.value = {phase: 'starting', total: 0, done: 0, current: null}
            carsFilterTimer = setInterval(pollCarsFilterProgress, 500)
            pollCarsFilterProgress()
            try {
                const response = await fetch('/api/cars-filter-run', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({environment: environment.value}),
                })
                const data = await response.json()
                if (!response.ok) throw new Error(data.error || 'Не удалось запустить проверку')
                carsFilterResult.value = data
            } catch (runError) {
                carsFilterError.value = runError.message
            } finally {
                clearInterval(carsFilterTimer)
                carsFilterTimer = null
                carsFilterRunning.value = false
            }
        }

        const runBanners = async () => {
            bannersRunning.value = true
            bannersError.value = ''
            bannersResult.value = null
            bannersDetailsHidden.value = false
            bannersProgress.value = {phase: 'starting', total: 0, done: 0, current: null}
            bannersTimer = setInterval(pollBannersProgress, 500)
            pollBannersProgress()
            try {
                const response = await fetch('/api/banners-run', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({environment: environment.value}),
                })
                const data = await response.json()
                if (!response.ok) throw new Error(data.error || 'Не удалось запустить проверку')
                bannersResult.value = data
            } catch (runError) {
                bannersError.value = runError.message
            } finally {
                clearInterval(bannersTimer)
                bannersTimer = null
                bannersRunning.value = false
            }
        }

        return {
            environments,
            environment,
            running,
            result,
            error,
            progress,
            progressText,
            detailsHidden,
            filterRunning,
            filterResult,
            filterDetailsHidden,
            filterError,
            filterProgress,
            filterProgressText,
            carsFilterRunning,
            carsFilterResult,
            carsFilterError,
            carsFilterProgress,
            carsFilterDetailsHidden,
            carsFilterProgressText,
            bannersRunning,
            bannersResult,
            bannersError,
            bannersProgress,
            bannersDetailsHidden,
            bannersProgressText,
            currentBase,
            canRun,
            formatDate,
            run,
            runFilter,
            runCarsFilter,
            runBanners,
        }
    },
}).mount('#app')
