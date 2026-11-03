import { createApp } from 'vue'
// 视觉基线只此两份：theme.css 给令牌与 reset，plugin-ui.css 给插件页共有的骨架类。
// 插件页与主面板是同一块面板里的两块，圆角、颜色、滚动条差一点就能看出来。
import '../../../src/shared/theme.css'
import '../../../src/shared/plugin-ui.css'
import App from './App.vue'

createApp(App).mount('#app')
