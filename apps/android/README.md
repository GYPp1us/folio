# Folio Android

需要 JDK、Android SDK Platform 36 和 Build Tools 36.0.0。使用 PowerShell 运行 `./apps/android/build.ps1` 生成未签名 APK。用 `-SdkRoot` 指定 SDK 的安装位置，用 `-OutputDir` 指定输出目录。

发布覆盖升级包时，传入 `-SigningDir`，目录应包含原发布用的 `folio-release.jks` 和 `store.pass`。构建脚本会核对签名证书与公开版 0.4.3 的指纹。

应用读取 Folio 主页面的 `theme-color`，同步 Android 状态栏和导航栏颜色。Android 15 及以上使用系统栏后方的窗口背景填色。
