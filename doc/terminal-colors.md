# 字体与终端配色

## 应用主题

在「设置 → 常规 → 主题」选择跟随系统、浅色、暗色，或暖陶土（Warm Terracotta）、薄荷绿（Mint Green）、薰衣草（Lavender）、彩虹玻璃（Rainbow Glass）、冰透玻璃（Ice Glass）。五套自定义主题均为固定浅色模式，不随 Windows 明暗变化，沿用当前界面布局和交互。选择独立保存，启动缓存使重启首屏直接使用所选配色。切回跟随系统后继续响应系统应用模式。

主题标识分别为 `terracotta`、`mint`、`lavender`、`iridescentGlass`、`iceGlass`，复用现有 `theme` 设置字段和保存接口。界面的亮暗模式与配色身份分开处理，自定义主题相互切换也立即刷新界面和现有终端。Windows 原生安全确认窗口使用现有浅色样式，系统 UAC 不变。中文选项「浅色」仍对应原有 `light` 配置值。

自定义主题只改变终端背景、普通文字、光标和选区；默认 ANSI 16 色沿用原浅色配色，手动选择的终端文字配色继续优先。SSH 与本地终端更新原 xterm 实例，不重新连接或启动进程；后台标签及轻量恢复使用当前选择，输出和历史保留。

彩虹玻璃使用粉紫、淡蓝、青色静态渐变及深色文字，冰透玻璃使用蓝青渐变及白色文字。玻璃效果由应用内背景、半透明表面及局部背景模糊实现，不透出桌面，不使用联网图片或原生透明窗口。菜单、提示和弹窗保留遮蔽底层内容的表面；不支持背景模糊时使用实色回退。

终端创建时即启用透明渲染，原主题继续使用不透明背景；切换玻璃主题不重新打开终端。玻璃终端默认背景完全透明，直接显示应用的同一层渐变，不再单独叠加文字区域底色；不支持模糊时由外层提供实色背景。透明色保留用于对比度计算的有色 RGB，光标反色文字使用不透明颜色。默认彩色文字按现有浅色 ANSI 输出，因此冰透玻璃上的部分深色 ANSI 文字对比度较低；本功能不擅自更换用户配色，可在「终端文字配色」选择独立预设，沿用既有 4.5 对比度策略。应用不能从任意 CSS 渐变位置精确推导 xterm 的背景对比度。

## 终端文字配色

在「设置 → 常规 → 终端文字配色」可以选择跟随应用主题，或使用 10 套独立配色：Ayu Mirage、Catppuccin Mocha、Dracula、Everforest Dark、Gruvbox Dark、Kanagawa Wave、Nord、One Half Dark、Rosé Pine、Solarized。

选择独立保存，重启后保留。改变应用主题不会重置已选配色；已有终端直接更新颜色，不重新连接 SSH，也不清除屏幕内容。

预设覆盖 ANSI 16 色调色板。终端默认背景、普通文字、光标和选区继续使用应用主题。程序通过 ANSI 调色板输出的彩色文字会使用所选颜色；程序指定的背景色也会使用这套 ANSI 调色板。纯文本不会自动获得语法或日志级别高亮，程序指定的 RGB 颜色不通过这套调色板。

预设启用 xterm.js 的 `minimumContrastRatio: 4.5`，渲染时按当前背景调整文字对比度，因此实际文字颜色可能比源色值更深或更浅。切回「跟随应用主题」恢复原有的配色及对比度行为。

旧设置缺少 `terminalColorScheme` 字段时，默认跟随应用主题。

## 字体

在「设置 → 常规 → 字体」选择应用的全局字体。该设置紧接「主题」，选项包括默认、JetBrains Mono、Cascadia Mono、Cascadia Code、Consolas、Courier New、Lucida Console、Fira Code、Source Code Pro。除内置字体外，需先在 Windows 中安装；没有安装的字体及缺失字形由原有字体链回退。

选择应用于终端列表、标签、设置、应用内弹窗、代码文本及所有 SSH／本地终端。Windows 原生安全确认窗口和系统 UAC 继续使用系统字体。「默认」保留原有界面字体及各代码区域、终端各自的等宽回退链。

JetBrains Mono 使用官方 v2.304 的 Regular、Bold、Italic、BoldItalic 四款 WOFF2，共 380,768 字节（约 371.84KiB），不安装到系统，也不通过 CDN 加载。内置资源使用独立 CSS 字体名称，与本机同名字体隔离。来源、SHA-256、大小及版权记录见 [字体资源说明](../src/assets/fonts/jetbrains-mono/README.md) 和 [OFL 许可证](../src/assets/fonts/jetbrains-mono/OFL.txt)。字体资源大小不等同于安装包实际增量。

字体选择即时应用并独立保存。内置字体加载期间使用默认字体，加载失败时保留选择并提示，可切换到其他字体后重新选择，或重启应用重试。保存失败则恢复最后成功保存的选择。更换字体重新适配现有终端尺寸，不重建连接或进程；后台标签和轻量恢复沿用最新选择。

旧设置缺少 `fontFamily` 时使用 `default`。该设置只接受预设标识，不接受任意 CSS 或字体路径。

## 终端字体大小

在「设置 → 常规 → 终端字体大小」输入 8～32 的整数（px），按 Enter 或移出输入框后应用，默认 13px。鼠标位于终端内容区域时，按住 Ctrl 向上滚轮增大字号，向下减小。这是「快捷键」中两个字号动作的默认绑定，可分别录制键盘组合键或带 Ctrl／Alt 的滚轮，也可清除或恢复默认。每个动作只保留一个绑定，改绑后原组合不再调整字号。高分辨率滚轮按累计滚动量换算，普通滚动保持原行为；终端内 Ctrl＋滚轮在清除或改绑后仍阻止页面缩放。键盘绑定仅在终端内容获得焦点时处理，命中的按键不发送给 Shell。

字号仅作用于终端，不改变应用界面字号；字体名称选择与字号设置分别保存。

字号由所有 SSH、本地终端标签共用，即时更新并独立保存；重启后保留。通过快捷键连续调整停止 300ms 后合并保存，保存失败时提示并恢复最近成功保存的字号。旧设置缺少 `terminalFontSize` 时使用 13px。

字号调整更新现有 xterm 实例，沿用尺寸适配及 PTY resize，不重启连接或本地进程。后台标签激活、轻量模式恢复后使用最新字号；文字配色和历史输出继续保留。

## 配色来源与许可

ANSI 色值保存在 `src/shared/terminalColors.ts`，来源如下。

| 配色 | 来源 | 版权声明 |
| --- | --- | --- |
| Ayu Mirage | [iTerm2 Color Schemes 的 Ayu Mirage](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/windowsterminal/Ayu%20Mirage.json)，基于 [ayu-colors](https://github.com/ayu-theme/ayu-colors) | Copyright (c) Konstantin Pschera；Copyright (c) 2011 to Present Mark Badolato |
| Catppuccin Mocha | [Catppuccin Kitty Mocha](https://github.com/catppuccin/kitty/blob/main/themes/mocha.conf) | Copyright (c) 2021 Catppuccin |
| Dracula | [iTerm2 Color Schemes 的 Dracula](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/yaml/Dracula.yml)，由 [Dracula Kitty](https://github.com/dracula/kitty) 移植 | Copyright (c) 2018 Dracula Theme；Copyright (c) 2011 to Present Mark Badolato |
| Everforest Dark | [iTerm2 Color Schemes 的 Everforest Dark Med](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/windowsterminal/Everforest%20Dark%20Med.json)，基于 [Everforest](https://github.com/sainnhe/everforest) | Copyright (c) 2019 sainnhe；Copyright (c) 2011 to Present Mark Badolato |
| Gruvbox Dark | [iTerm2 Color Schemes 的 Gruvbox Dark](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/windowsterminal/Gruvbox%20Dark.json)，基于 [Gruvbox](https://github.com/morhetz/gruvbox) | Copyright (c) Pavel Pertsev；Copyright (c) 2011 to Present Mark Badolato |
| Kanagawa Wave | [iTerm2 Color Schemes 的 Kanagawa Wave](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/windowsterminal/Kanagawa%20Wave.json)，基于 [Kanagawa.nvim](https://github.com/rebelot/kanagawa.nvim) | Copyright (c) 2021 Tommaso Laurenzi；Copyright (c) 2011 to Present Mark Badolato |
| Nord | [Nord Xresources](https://github.com/nordtheme/xresources/blob/develop/src/nord) | Copyright (c) 2016-present Sven Greb |
| One Half Dark | [iTerm2 Color Schemes 的 One Half Dark](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/windowsterminal/One%20Half%20Dark.json)，基于 [One Half](https://github.com/sonph/onehalf) | Copyright (c) 2019 Son A. Pham；Copyright (c) 2011 to Present Mark Badolato |
| Rosé Pine | [iTerm2 Color Schemes 的 Rose Pine](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/windowsterminal/Rose%20Pine.json)，基于 [Rosé Pine for iTerm2](https://github.com/rose-pine/iterm) | Copyright (c) Rosé Pine；Copyright (c) 2011 to Present Mark Badolato |
| Solarized | [Solarized Xresources](https://github.com/altercation/solarized/blob/master/xresources/solarized) | Copyright (c) 2011 Ethan Schoonover |

以上配色均按 MIT 许可使用，保留版权声明及许可文本：

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
