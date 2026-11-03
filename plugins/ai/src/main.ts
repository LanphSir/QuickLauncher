import { createApp } from 'vue'
// 与核心渲染层共用同一份令牌/重置：插件页和主面板是同一块面板里的两块，
// 圆角、滚动条、字体差一点就能看出来
import '../../../src/shared/theme.css'
import App from './App.vue'

createApp(App).mount('#app')
