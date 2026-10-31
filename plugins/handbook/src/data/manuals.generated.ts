// 由 plugins/handbook/scripts/build-manuals.mjs 生成，请勿手改（改 manuals/ 后重新 build）
import type { Manual } from '../types'
import m0c0 from '../../manuals/typescript/the-handbook.md?raw'
import m0c1 from '../../manuals/typescript/basics.md?raw'
import m0c2 from '../../manuals/typescript/everyday-types.md?raw'
import m0c3 from '../../manuals/typescript/narrowing.md?raw'
import m0c4 from '../../manuals/typescript/more-on-functions.md?raw'
import m0c5 from '../../manuals/typescript/object-types.md?raw'
import m0c6 from '../../manuals/typescript/type-manipulation/_creating-types-from-types.md?raw'
import m0c7 from '../../manuals/typescript/type-manipulation/generics.md?raw'
import m0c8 from '../../manuals/typescript/type-manipulation/keyof-type-operator.md?raw'
import m0c9 from '../../manuals/typescript/type-manipulation/typeof-type-operator.md?raw'
import m0c10 from '../../manuals/typescript/type-manipulation/indexed-access-types.md?raw'
import m0c11 from '../../manuals/typescript/type-manipulation/conditional-types.md?raw'
import m0c12 from '../../manuals/typescript/type-manipulation/mapped-types.md?raw'
import m0c13 from '../../manuals/typescript/type-manipulation/template-literal-types.md?raw'
import m0c14 from '../../manuals/typescript/classes.md?raw'
import m0c15 from '../../manuals/typescript/modules.md?raw'
import m1c0 from '../../manuals/linux-command/ls.md?raw'
import m1c1 from '../../manuals/linux-command/cd.md?raw'
import m1c2 from '../../manuals/linux-command/pwd.md?raw'
import m1c3 from '../../manuals/linux-command/cat.md?raw'
import m1c4 from '../../manuals/linux-command/less.md?raw'
import m1c5 from '../../manuals/linux-command/head.md?raw'
import m1c6 from '../../manuals/linux-command/tail.md?raw'
import m1c7 from '../../manuals/linux-command/grep.md?raw'
import m1c8 from '../../manuals/linux-command/sed.md?raw'
import m1c9 from '../../manuals/linux-command/awk.md?raw'
import m1c10 from '../../manuals/linux-command/find.md?raw'
import m1c11 from '../../manuals/linux-command/xargs.md?raw'
import m1c12 from '../../manuals/linux-command/cp.md?raw'
import m1c13 from '../../manuals/linux-command/mv.md?raw'
import m1c14 from '../../manuals/linux-command/rm.md?raw'
import m1c15 from '../../manuals/linux-command/mkdir.md?raw'
import m1c16 from '../../manuals/linux-command/chmod.md?raw'
import m1c17 from '../../manuals/linux-command/chown.md?raw'
import m1c18 from '../../manuals/linux-command/ln.md?raw'
import m1c19 from '../../manuals/linux-command/tar.md?raw'
import m1c20 from '../../manuals/linux-command/ps.md?raw'
import m1c21 from '../../manuals/linux-command/top.md?raw'
import m1c22 from '../../manuals/linux-command/kill.md?raw'
import m1c23 from '../../manuals/linux-command/df.md?raw'
import m1c24 from '../../manuals/linux-command/du.md?raw'
import m1c25 from '../../manuals/linux-command/free.md?raw'
import m1c26 from '../../manuals/linux-command/uname.md?raw'
import m1c27 from '../../manuals/linux-command/date.md?raw'
import m1c28 from '../../manuals/linux-command/echo.md?raw'
import m1c29 from '../../manuals/linux-command/which.md?raw'
import m1c30 from '../../manuals/linux-command/curl.md?raw'
import m1c31 from '../../manuals/linux-command/ssh.md?raw'
import m1c32 from '../../manuals/linux-command/rsync.md?raw'
import m1c33 from '../../manuals/linux-command/systemctl.md?raw'
import m1c34 from '../../manuals/linux-command/crontab.md?raw'

export const MANUALS: Manual[] = [
  {
    id: "typescript",
    title: "TypeScript 手册",
    description: "TypeScript 官方手册中文版（handbook v2 全 16 章）：常见类型、类型收窄、函数进阶、对象类型、类、模块，以及泛型等类型操纵能力。",
    keywords: ["ts","typescript","类型","泛型","handbook","类型体操"],
    order: 10,
    source: "https://github.com/zhongsp/TypeScript",
    license: "译文：zhongsp/TypeScript（社区翻译）；原文版权归 Microsoft",
    chapters: [
      { id: "the-handbook", title: "TypeScript 手册（引言）", content: m0c0 },
      { id: "basics", title: "基础", content: m0c1 },
      { id: "everyday-types", title: "常见类型", content: m0c2 },
      { id: "narrowing", title: "缩小类型范围", content: m0c3 },
      { id: "more-on-functions", title: "函数进阶", content: m0c4 },
      { id: "object-types", title: "对象类型", content: m0c5 },
      { id: "type-manipulation-_creating-types-from-types", title: "用现有类型创建新类型", content: m0c6 },
      { id: "type-manipulation-generics", title: "泛型", content: m0c7 },
      { id: "type-manipulation-keyof-type-operator", title: "keyof 类型运算符", content: m0c8 },
      { id: "type-manipulation-typeof-type-operator", title: "typeof 类型运算符", content: m0c9 },
      { id: "type-manipulation-indexed-access-types", title: "索引访问类型", content: m0c10 },
      { id: "type-manipulation-conditional-types", title: "条件类型", content: m0c11 },
      { id: "type-manipulation-mapped-types", title: "映射类型", content: m0c12 },
      { id: "type-manipulation-template-literal-types", title: "模板字面量类型", content: m0c13 },
      { id: "classes", title: "类", content: m0c14 },
      { id: "modules", title: "模块", content: m0c15 },
    ]
  },
  {
    id: "linux-command",
    title: "Linux 命令手册",
    description: "35 个高频 Linux 命令的中文速查：文件与目录、文本处理、进程与磁盘、网络、服务管理。",
    keywords: ["linux","命令","shell","bash","grep","awk","sed","cheatsheet"],
    order: 20,
    source: "https://github.com/jaywcjlove/linux-command",
    license: "MIT（jaywcjlove/linux-command）",
    chapters: [
      { id: "ls", title: "ls · 显示目录内容列表", content: m1c0 },
      { id: "cd", title: "cd · 切换用户当前工作目录", content: m1c1 },
      { id: "pwd", title: "pwd · 显示当前工作目录的绝对路径", content: m1c2 },
      { id: "cat", title: "cat · 连接多个文件并打印到标准输出", content: m1c3 },
      { id: "less", title: "less · 分屏上下翻页浏览文件内容", content: m1c4 },
      { id: "head", title: "head · 显示文件的开头部分", content: m1c5 },
      { id: "tail", title: "tail · 在屏幕上显示指定文件的末尾若干行", content: m1c6 },
      { id: "grep", title: "grep · 强大的文本搜索工具", content: m1c7 },
      { id: "sed", title: "sed · 功能强大的流式文本编辑器", content: m1c8 },
      { id: "awk", title: "awk · 文本和数据进行处理的编程语言", content: m1c9 },
      { id: "find", title: "find · 在指定目录下查找文件", content: m1c10 },
      { id: "xargs", title: "xargs · 给其他命令传递参数的一个过滤器", content: m1c11 },
      { id: "cp", title: "cp · 将源文件或目录复制到目标文件或目录中", content: m1c12 },
      { id: "mv", title: "mv · 用来对文件或目录重新命名", content: m1c13 },
      { id: "rm", title: "rm · 用于删除给定的文件和目录", content: m1c14 },
      { id: "mkdir", title: "mkdir · 用来创建目录", content: m1c15 },
      { id: "chmod", title: "chmod · 用来变更文件或目录的权限", content: m1c16 },
      { id: "chown", title: "chown · 用来变更文件或目录的拥有者或所属群组", content: m1c17 },
      { id: "ln", title: "ln · 用来为文件创建链接", content: m1c18 },
      { id: "tar", title: "tar", content: m1c19 },
      { id: "ps", title: "ps · 报告当前系统的进程状态", content: m1c20 },
      { id: "top", title: "top · 显示或管理执行中的程序", content: m1c21 },
      { id: "kill", title: "kill · 发送信号到进程", content: m1c22 },
      { id: "df", title: "df · 显示磁盘的相关信息", content: m1c23 },
      { id: "du", title: "du · 显示每个文件和目录的磁盘使用空间", content: m1c24 },
      { id: "free", title: "free · 显示内存的使用情况", content: m1c25 },
      { id: "uname", title: "uname · 打印系统信息", content: m1c26 },
      { id: "date", title: "date · 显示或设置系统时间与日期", content: m1c27 },
      { id: "echo", title: "echo · 输出指定的字符串或者变量", content: m1c28 },
      { id: "which", title: "which · 查找并显示给定命令的绝对路径", content: m1c29 },
      { id: "curl", title: "curl · 利用URL规则在命令行下工作的文件传输工具", content: m1c30 },
      { id: "ssh", title: "ssh · openssh套件中的客户端连接工具", content: m1c31 },
      { id: "rsync", title: "rsync · 远程数据同步工具", content: m1c32 },
      { id: "systemctl", title: "systemctl · Systemd服务管理器", content: m1c33 },
      { id: "crontab", title: "crontab · 提交和管理用户的需要周期性执行的任务", content: m1c34 },
    ]
  },
]
