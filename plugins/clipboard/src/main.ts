import { createApp } from 'vue'
// 视觉基线只此两份：theme.css 给令牌与 reset，plugin-ui.css 给插件页共有的骨架类
import '../../../src/shared/theme.css'
import '../../../src/shared/plugin-ui.css'
import App from './App.vue'

createApp(App).mount('#app')
