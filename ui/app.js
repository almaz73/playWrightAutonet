import {computed, createApp, onMounted, ref} from '/vue.js'

createApp({
    setup() {
        const environments = ref([])
        const environment = ref('local')
        const running = ref(false)
        const result = ref(null)
        const error = ref('')
        const progress = ref({phase: 'idle', total: 0, done: 0, current: null})
        let progressTimer = null

        const currentBase = computed(() => environments.value.find((env) => env.value === environment.value)?.baseUrl || '')
        const canRun = computed(() => !running.value)
        const progressText = computed(() => {
            const state = progress.value
            if (state.phase === 'starting' || state.phase === 'discovering') return 'Читаем меню на главной…'
            if (state.total) return `Проверено ${state.done} из ${state.total}`
            return 'Проверяем…'
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

        onMounted(async () => {
            const response = await fetch('/api/options')
            const data = await response.json()
            environments.value = data.environments
        })

        const run = async () => {
            running.value = true
            error.value = ''
            result.value = null
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

        return {
            environments,
            environment,
            running,
            result,
            error,
            progress,
            progressText,
            currentBase,
            canRun,
            formatDate,
            run,
        }
    },
}).mount('#app')
