# Folio Android

需要 JDK、Android SDK Platform 36 和 Build Tools 36.0.0。使用 PowerShell 运行 `./apps/android/build.ps1` 生成未签名 APK。用 `-SdkRoot` 指定 SDK 的安装位置，用 `-OutputDir` 指定输出目录。

推送与 Android manifest 版本一致的注释标签（例如 `android-v0.5.6`）后，GitHub Actions 会构建、校验签名并发布 APK 和 SHA-256 校验文件。标签说明用作发布说明。也可在 Actions 的 Android release 工作流手动选择已推送的标签。

签名使用仓库的 Actions Secrets `FOLIO_ANDROID_KEYSTORE_BASE64`（JKS 的 Base64）和 `FOLIO_ANDROID_KEYSTORE_PASSWORD`。构建脚本会校验发布证书指纹。从 0.5.6 起沿用这套签名，后续版本才能覆盖安装。

本地签名时，传入 `-SigningDir`，目录应包含 `folio-release.jks` 和 `store.pass`。

应用读取 Folio 主页面的 `theme-color`，同步 Android 状态栏和导航栏颜色。Android 15 及以上使用系统栏后方的窗口背景填色。
