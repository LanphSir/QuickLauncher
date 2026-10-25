<script setup lang="ts">
import { NConfigProvider, NMessageProvider, dateZhCN, zhCN } from 'naive-ui'
import PanelShell from './components/PanelShell.vue'
</script>

<template>
  <NConfigProvider :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <PanelShell />
    </NMessageProvider>
  </NConfigProvider>
</template>
