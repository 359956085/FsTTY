# 终端文字配色

在「设置 → 常规 → 终端文字配色」选择跟随应用主题、Dracula、Catppuccin Mocha、Nord 或 Solarized。

选择独立保存，重启后保留。改变应用主题不会重置已选配色；已有终端直接更新颜色，不重新连接 SSH，也不清除屏幕内容。

预设覆盖 ANSI 16 色调色板。终端默认背景、普通文字、光标和选区继续使用应用的明暗主题。程序通过 ANSI 调色板输出的彩色文字会使用所选颜色；程序指定的背景色也会使用这套 ANSI 调色板。纯文本不会自动获得语法或日志级别高亮，程序指定的 RGB 颜色不通过这套调色板。

预设启用 xterm.js 的 `minimumContrastRatio: 4.5`，渲染时按当前背景调整文字对比度，因此实际文字颜色可能比源色值更深或更浅。切回「跟随应用主题」恢复原有的配色及对比度行为。

旧设置缺少 `terminalColorScheme` 字段时，默认跟随应用主题。

## 配色来源与许可

ANSI 色值保存在 `src/shared/terminalColors.ts`，来源如下。

| 配色 | 来源 | 版权声明 |
| --- | --- | --- |
| Dracula | [iTerm2 Color Schemes 的 Dracula](https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/yaml/Dracula.yml)，由 [Dracula Kitty](https://github.com/dracula/kitty) 移植 | Copyright (c) 2018 Dracula Theme；Copyright (c) 2011 to Present Mark Badolato |
| Catppuccin Mocha | [Catppuccin Kitty Mocha](https://github.com/catppuccin/kitty/blob/main/themes/mocha.conf) | Copyright (c) 2021 Catppuccin |
| Nord | [Nord Xresources](https://github.com/nordtheme/xresources/blob/develop/src/nord) | Copyright (c) 2016-present Sven Greb |
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
