import { createApp } from 'vue'
import { createPinia } from 'pinia'
// 令牌与重置必须先于组件样式：后者大量引用 var(--…)
import '../../shared/theme.css'
import App from './App.vue'
import './styles/global.css'

createApp(App).use(createPinia()).mount('#app')
