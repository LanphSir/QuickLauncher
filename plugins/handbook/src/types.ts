export interface ManualChapter {
  id: string
  title: string
  /** 章节正文（构建期由 md 打包进来；自定义文档运行时从主进程读取） */
  content: string
}

export interface Manual {
  id: string
  title: string
  description?: string
  keywords: string[]
  /** 列表排序（小的在前） */
  order: number
  source?: string
  license?: string
  chapters: ManualChapter[]
  /** 运行时标记：用户导入的文档集合 */
  custom?: boolean
}

export interface PluginDocMeta {
  id: string
  title: string
  size: number
  updatedAt: number
}
