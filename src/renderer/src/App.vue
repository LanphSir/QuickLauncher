<script setup lang="ts">
import { NConfigProvider, NMessageProvider, dateZhCN, zhCN } from 'naive-ui'
import PanelShell from './components/PanelShell.vue'

/**
 * naive-ui 的默认主色是绿色，和面板的 indigo 放在一起像两套设计。
 * 这里只改公共令牌：颜色、圆角、字号。组件级尺寸仍由各自的 size 控制。
 */
const themeOverrides = {
  common: {
    primaryColor: '#6366f1',
    primaryColorHover: '#565ae8',
    primaryColorPressed: '#4f46e5',
    primaryColorSuppl: '#6366f1',
    infoColor: '#6366f1',
    successColor: '#0a7d43',
    warningColor: '#a4620a',
    errorColor: '#d5304f',
    textColorBase: '#1f2329',
    borderRadius: '8px',
    fontSize: '13px',
    fontSizeSmall: '12px',
    fontSizeTiny: '11.5px'
  }
}
</script>

<template>
  <NConfigProvider :locale="zhCN" :date-locale="dateZhCN" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <PanelShell />
    </NMessageProvider>
  </NConfigProvider>
</template>
