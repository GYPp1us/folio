package site.arcol.folio;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/** Thin client: all models, credentials and sandbox work remain on Folio's server. */
public final class MainActivity extends Activity {
    private static final String HOME = "https://folio.arcol.site/";
    private static final String HOST = "folio.arcol.site";
    private static final int FILE_PICKER = 41;
    private static final int DEFAULT_THEME = 0xff0e0e0f;
    private static final long THEME_CHECK_MS = 400;
    private static final String READ_THEME =
        "(function(){var meta=document.querySelector('meta[name=theme-color]');return meta && meta.content;})()";

    private WebView web;
    private FrameLayout root;
    private boolean foreground;
    private boolean readingTheme;
    private int themeColor = DEFAULT_THEME;
    private final Handler themeHandler = new Handler(Looper.getMainLooper());
    private final Runnable themeCheck = new Runnable() {
        @Override public void run() {
            if (!foreground) return;
            readPageTheme();
            themeHandler.postDelayed(this, THEME_CHECK_MS);
        }
    };
    private ProgressBar progress;
    private LinearLayout error;
    private ValueCallback<Uri[]> files;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        root = new FrameLayout(this);
        root.setBackgroundColor(themeColor);
        setContentView(root);
        getWindow().setStatusBarContrastEnforced(false);
        getWindow().setNavigationBarContrastEnforced(false);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
            root.setOnApplyWindowInsetsListener((view,insets) -> {
                android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime=insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left,bars.top,bars.right,Math.max(bars.bottom,ime.bottom));
                return WindowInsets.CONSUMED;
            });
        }
        web = new WebView(this);
        root.addView(web,new FrameLayout.LayoutParams(-1,-1));
        applyTheme(themeColor);
        WebSettings settings=web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        WebView.setWebContentsDebuggingEnabled(false);
        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(Color.rgb(199,124,89)));
        FrameLayout.LayoutParams bar=new FrameLayout.LayoutParams(-1,dp(2),Gravity.TOP);
        root.addView(progress,bar);
        error=new LinearLayout(this); error.setOrientation(LinearLayout.VERTICAL); error.setGravity(Gravity.CENTER);
        error.setPadding(dp(28),dp(28),dp(28),dp(28)); error.setBackgroundColor(Color.rgb(250,248,243));
        TextView title=new TextView(this);title.setText("暂时无法连接 Folio");title.setTextSize(19);title.setTextColor(Color.rgb(82,67,53));error.addView(title);
        TextView detail=new TextView(this);detail.setText("请检查网络连接后重试。");detail.setTextSize(14);detail.setPadding(0,dp(12),0,dp(18));error.addView(detail);
        Button retry=new Button(this);retry.setText("重新连接");retry.setOnClickListener(v -> {error.setVisibility(View.GONE);web.loadUrl(HOME);});error.addView(retry);
        root.addView(error,new FrameLayout.LayoutParams(-1,-1));error.setVisibility(View.GONE);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request) {
                Uri uri=request.getUrl();
                if (isHome(uri)) return false;
                if (request.isForMainFrame() && request.hasGesture()) openExternal(uri);
                return true;
            }
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon) {progress.setVisibility(View.VISIBLE);}
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                progress.setVisibility(View.GONE);
                readPageTheme();
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError problem) {
                if(request.isForMainFrame()) {error.setVisibility(View.VISIBLE);progress.setVisibility(View.GONE);}
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view,int value) {progress.setProgress(value);progress.setVisibility(value<100?View.VISIBLE:View.GONE);}
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params) {
                if(files!=null) files.onReceiveValue(null);
                files=callback;
                try {
                    Intent intent=params.createIntent();intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
                    startActivityForResult(Intent.createChooser(intent,"选择文件或图片"),FILE_PICKER);
                } catch(ActivityNotFoundException problem) {files.onReceiveValue(null);files=null;Toast.makeText(MainActivity.this,"没有可用的文件选择器",Toast.LENGTH_SHORT).show();}
                return true;
            }
            @Override public boolean onCreateWindow(WebView view,boolean dialog,boolean gesture,android.os.Message result) {
                if(!gesture) return false;
                WebView popup=new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest request) {
                        Uri uri=request.getUrl();
                        if(isHome(uri)) web.loadUrl(uri.toString());else openExternal(uri);
                        popup.destroy();return true;
                    }
                });
                ((WebView.WebViewTransport)result.obj).setWebView(popup);result.sendToTarget();return true;
            }
        });
        web.setDownloadListener((url,agent,disposition,mime,length) -> {
            Uri uri=Uri.parse(url);
            if(!isHome(uri)) {openExternal(uri);return;}
            try {
                String name=URLUtil.guessFileName(url,disposition,mime).replaceAll("[\\\\/:*?\"<>|]","_");
                DownloadManager.Request request=new DownloadManager.Request(uri).setTitle(name).setMimeType(mime)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,name);
                String cookie=CookieManager.getInstance().getCookie(url);
                if(cookie!=null) request.addRequestHeader("Cookie",cookie);
                request.addRequestHeader("User-Agent",agent);
                ((DownloadManager)getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
                Toast.makeText(this,"已加入下载",Toast.LENGTH_SHORT).show();
            } catch(RuntimeException problem) {Toast.makeText(this,"无法开始下载，请稍后重试",Toast.LENGTH_LONG).show();}
        });
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,this::navigateBack);
        if(saved==null || web.restoreState(saved)==null) web.loadUrl(HOME);
    }
    private void readPageTheme() {
        if (!foreground || readingTheme || web == null) return;
        WebView view = web;
        String page = view.getUrl();
        if (page == null || !isHome(Uri.parse(page))) return;
        readingTheme = true;
        view.evaluateJavascript(READ_THEME, result -> {
            readingTheme = false;
            if (!foreground || web != view || !page.equals(view.getUrl()) ||
                result == null || !result.matches("\"#[0-9a-fA-F]{6}\"")) return;
            int color = Color.parseColor(result.substring(1, result.length() - 1));
            if (color != themeColor) applyTheme(color);
        });
    }

    private void applyTheme(int color) {
        themeColor = color;
        root.setBackgroundColor(color);
        web.setBackgroundColor(color);
        boolean darkIcons = Color.luminance(color) > 0.179;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
                    WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(darkIcons ? light : 0, light);
            }
        } else {
            getWindow().setStatusBarColor(color);
            getWindow().setNavigationBarColor(color);
            View decor = getWindow().getDecorView();
            int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR |
                View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility((decor.getSystemUiVisibility() & ~light) |
                (darkIcons ? light : 0));
        }
    }

    private static boolean isHome(Uri uri) {return "https".equalsIgnoreCase(uri.getScheme()) && HOST.equalsIgnoreCase(uri.getHost()) && (uri.getPort()==-1 || uri.getPort()==443);}
    private void openExternal(Uri uri) {
        if(!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())) return;
        try {startActivity(new Intent(Intent.ACTION_VIEW,uri).addCategory(Intent.CATEGORY_BROWSABLE));}
        catch(ActivityNotFoundException ignored) {Toast.makeText(this,"没有可用的浏览器",Toast.LENGTH_SHORT).show();}
    }
    private int dp(int value) {return Math.round(value*getResources().getDisplayMetrics().density);}
    private void navigateBack() {if(web.canGoBack()) web.goBack();else finish();}
    @Override public void onBackPressed() {navigateBack();}
    @Override protected void onSaveInstanceState(Bundle state) {web.saveState(state);super.onSaveInstanceState(state);}
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request==FILE_PICKER && files!=null) {
            Uri[] chosen=WebChromeClient.FileChooserParams.parseResult(result,data);
            if(chosen!=null) for(Uri uri:chosen) if(!"content".equalsIgnoreCase(uri.getScheme())) {chosen=null;break;}
            files.onReceiveValue(chosen);files=null;
        }
    }
    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        themeHandler.removeCallbacks(themeCheck);
        themeHandler.post(themeCheck);
    }

    @Override protected void onPause() {
        foreground = false;
        themeHandler.removeCallbacks(themeCheck);
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override protected void onDestroy() {
        if (files != null) files.onReceiveValue(null);
        web.stopLoading();
        web.destroy();
        web = null;
        super.onDestroy();
    }
}
