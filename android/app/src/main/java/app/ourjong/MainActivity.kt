package app.ourjong

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader

/**
 * Ourjong: the web game (apps/client) carried inside the APK and shown full screen.
 *
 * Pages are served from the APK's assets at https://appassets.androidplatform.net/, a name only
 * this WebView answers, so nothing is ever fetched from the internet (the app has no internet
 * permission in any case). Links that would leave the game are ignored.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A game in progress keeps the screen on.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/", GameFiles(assets))
            .build()

        web = WebView(this).apply {
            setBackgroundColor(BACKGROUND)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true          // names and difficulty are kept in localStorage
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = false
                allowContentAccess = false
                setSupportMultipleWindows(false)
                setGeolocationEnabled(false)
            }
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    if (request.url.host == HOST) loader.shouldInterceptRequest(request.url) else blocked()

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    request.url.host != HOST
            }
        }
        // Full screen for the table: the system bars hide (a swipe from the edge shows them for a
        // moment), and the page is kept clear of camera cut-outs.
        val frame = FrameLayout(this).apply {
            setBackgroundColor(BACKGROUND)
            addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        setContentView(frame)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        hideSystemBars()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl("https://$HOST/index.html")
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        hideSystemBars()
    }

    private fun hideSystemBars() {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    private companion object {
        const val HOST = WebViewAssetLoader.DEFAULT_DOMAIN
        /** The game's splash green, so there's no white flash while it starts. */
        val BACKGROUND = Color.parseColor("#12382D")
        /** Anything outside the game gets an empty answer instead of a network request. */
        fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0)))
    }
}

/** Serves files from assets/www, with "/" as index.html and unknown paths falling back to it. */
private class GameFiles(private val assets: android.content.res.AssetManager) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        val clean = path.trimStart('/').ifEmpty { "index.html" }
        if (clean.contains("..") || clean.contains('\\')) return null
        val name = clean.takeIf { exists(it) } ?: if ('.' !in clean.substringAfterLast('/')) "index.html" else return null
        return runCatching {
            WebResourceResponse(mimeOf(name), if (isText(name)) "utf-8" else null, assets.open("www/$name"))
        }.getOrNull()
    }

    private fun exists(name: String): Boolean = runCatching { assets.open("www/$name").close(); true }.getOrDefault(false)

    private fun isText(name: String) = name.substringAfterLast('.') in setOf("html", "js", "css", "json", "svg", "webmanifest", "txt")

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.').lowercase()) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "json", "webmanifest" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "ico" -> "image/x-icon"
        "mp3" -> "audio/mpeg"
        "wav" -> "audio/wav"
        "ogg" -> "audio/ogg"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        "ttf" -> "font/ttf"
        "wasm" -> "application/wasm"
        else -> "application/octet-stream"
    }
}
