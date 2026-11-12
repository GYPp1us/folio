param(
  [string]$SdkRoot = $env:ANDROID_HOME,
  [string]$JdkRoot = $env:JAVA_HOME,
  [string]$OutputDir,
  [string]$SigningDir
)
$ErrorActionPreference = 'Stop'
if (!$SdkRoot) { $SdkRoot = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
if (!$JdkRoot) { $JdkRoot = Split-Path (Split-Path (Get-Command java).Source) }
if (!$OutputDir) { $OutputDir = Join-Path $PSScriptRoot 'build' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$tools = Join-Path $SdkRoot 'build-tools/36.0.0'
$androidJar = Join-Path $SdkRoot 'platforms/android-36/android.jar'
if (!(Test-Path -LiteralPath $androidJar) -or !(Test-Path -LiteralPath $tools)) {
  throw '需要 Android SDK Platform 36 和 Build Tools 36.0.0'
}
$work = Join-Path $OutputDir ([guid]::NewGuid().ToString('N'))
$classes = Join-Path $work 'classes'
$dex = Join-Path $work 'dex'
New-Item -ItemType Directory -Path $classes,$dex -Force | Out-Null

function Invoke-Tool([string]$Program,[string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program 退出码 $LASTEXITCODE" }
}
$manifest = Join-Path $PSScriptRoot 'AndroidManifest.xml'
$version = ([xml](Get-Content -Raw -LiteralPath $manifest)).manifest.GetAttribute(
  'versionName', 'http://schemas.android.com/apk/res/android'
)
$resources = Join-Path $work 'resources.zip'
$unsigned = Join-Path $work 'unsigned.apk'
$aligned = Join-Path $work 'aligned.apk'
$java = Join-Path $JdkRoot 'bin'
$oldJava = $env:JAVA_HOME
$env:JAVA_HOME = $JdkRoot
try {
  Invoke-Tool (Join-Path $tools 'aapt2.exe') @('compile','--dir',(Join-Path $PSScriptRoot 'res'),'-o',$resources)
  Invoke-Tool (Join-Path $tools 'aapt2.exe') @('link','-o',$unsigned,'--manifest',$manifest,'-I',$androidJar,$resources)
  $sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Recurse -Filter '*.java' | ForEach-Object FullName)
  Invoke-Tool (Join-Path $java 'javac.exe') (@('-encoding','UTF-8','--release','8','-classpath',$androidJar,'-d',$classes) + $sources)
  $classJar = Join-Path $work 'classes.jar'
  Invoke-Tool (Join-Path $java 'jar.exe') @('--create','--file',$classJar,'-C',$classes,'.')
  Invoke-Tool (Join-Path $tools 'd8.bat') @('--lib',$androidJar,'--min-api','29','--output',$dex,$classJar)
  Invoke-Tool (Join-Path $java 'jar.exe') @('--update','--file',$unsigned,'-C',$dex,'classes.dex')
  Invoke-Tool (Join-Path $tools 'zipalign.exe') @('-f','4',$unsigned,$aligned)

  if (!$SigningDir) {
    $output = Join-Path $OutputDir "Folio-$version-android-unsigned.apk"
    Copy-Item -LiteralPath $aligned -Destination $output
  } else {
    $keystore = Join-Path $SigningDir 'folio-release.jks'
    $passwordFile = Join-Path $SigningDir 'store.pass'
    if (!(Test-Path -LiteralPath $keystore) -or !(Test-Path -LiteralPath $passwordFile)) {
      throw '签名需要 folio-release.jks 和 store.pass'
    }
    $signer = Join-Path $tools 'apksigner.bat'
    $candidate = Join-Path $work 'signed.apk'
    Invoke-Tool $signer @('sign','--ks',$keystore,'--ks-pass',("file:" + $passwordFile),
      '--out',$candidate,$aligned)
    $report = Invoke-Tool $signer @('verify','--print-certs',$candidate)
    $fingerprint = 'a2e653c610d2ade0fb15cd3ad3063abb340b8bbc21917e42eff852d815462234'
    if ($report -notcontains "Signer #1 certificate SHA-256 digest: $fingerprint") {
      throw '签名与 Folio 发布证书不匹配'
    }
    $output = Join-Path $OutputDir "Folio-$version-android.apk"
    Copy-Item -LiteralPath $candidate -Destination $output
  }
  Write-Output $output
} finally {
  $env:JAVA_HOME = $oldJava
}
