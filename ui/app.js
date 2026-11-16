import {computed, createApp, onMounted, ref} from '/vue.js'

createApp({
    setup() {
        const environments = ref([])
        const pages = ref([])
        const environment = ref('local')
        const selected = ref([])
        const running = ref(false)
        const result = ref(null)
        const error = ref('')

        const currentBase = computed(() => environments.value.find((env) => env.value === environment.value)?.baseUrl || '')
        const canRun = computed(() => selected.value.length > 0 && !running.value)

        const formatDate = (value) => new Date(value).toLocaleString('ru-RU')

        onMounted(async () => {
            const response = await fetch('/api/options')
            const data = await response.json()
            environments.value = data.environments
            pages.value = data.pages
            selected.value = data.pages.map((page) => page.path)
        })

        const run = async () => {
            running.value = true
            error.value = ''
            result.value = null
            try {
                const response = await fetch('/api/run', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({environment: environment.value, pages: selected.value}),
                })
                const data = await response.json()
                if (!response.ok) throw new Error(data.error || 'Не удалось запустить проверку')
                result.value = data
            } catch (runError) {
                error.value = runError.message
            } finally {
                running.value = false
            }
        }

        return {
            environments,
            pages,
            environment,
            selected,
            running,
            result,
            error,
            currentBase,
            canRun,
            formatDate,
            run,
        }
    },
}).mount('#app')
