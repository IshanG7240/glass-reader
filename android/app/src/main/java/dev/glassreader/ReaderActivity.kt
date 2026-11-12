package dev.glassreader

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File

/**
 * The reader: a full-screen, see-through window over whatever you were reading, with the
 * desktop renderer inside. Everything that opens a document comes through here: the
 * launcher, Share, "Glass Reader" in a text selection menu, opening a file, and the
 * Read button over the chat apps.
 */
class ReaderActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private var ready = false
    private val pending = ArrayList<String>()
    private var link: LinkCapture? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 31) {
            window.addFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND)
            window.attributes = window.attributes.apply { blurBehindRadius = 90 }
        }

        WebView.setWebContentsDebuggingEnabled(true)
        root = FrameLayout(this)
        web = WebView(this)
        web.setBackgroundColor(Color.TRANSPARENT)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
            textZoom = 100
        }
        web.addJavascriptInterface(Bridge(), "GRAndroid")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? =
                Assets.serve(this@ReaderActivity, req.url)

            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                if (req.url.host == Assets.HOST) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, req.url)) }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d(TAG, "js: ${m.message()} (${m.sourceId().substringAfterLast('/')}:${m.lineNumber()})")
                return true
            }
            override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                cb.onReceiveValue(null)
                pickFile()
                return true
            }
            override fun onCreateWindow(v: WebView, dialog: Boolean, user: Boolean, msg: android.os.Message): Boolean = false
        }
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        immersive()
        web.loadUrl("https://${Assets.HOST}/web/renderer/index.html")
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        immersive()
        // With reading from the screen on, ask once for notifications: the Read button can
        // be dragged away, and the notification is how it comes back early.
        val asked = getSharedPreferences("ui", MODE_PRIVATE)
        if (android.os.Build.VERSION.SDK_INT >= 33 && !Notify.allowed(this) && CaptureService.isEnabled(this) && !asked.getBoolean("askedNotify", false)) {
            asked.edit().putBoolean("askedNotify", true).apply()
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        if (ready) web.evaluateJavascript("window.__grAndroid.shown()", null)
    }

    override fun onDestroy() {
        link?.cancel()
        web.destroy()
        super.onDestroy()
    }

    @Deprecated("Back is handled by the page first")
    override fun onBackPressed() {
        if (!ready) return leave()
        web.evaluateJavascript("window.__grAndroid.back()") { handled -> if (handled != "true") leave() }
    }

    // Volume keys turn pages, like an e-reader.
    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        val key = when (e.keyCode) {
            KeyEvent.KEYCODE_VOLUME_DOWN -> "PageDown"
            KeyEvent.KEYCODE_VOLUME_UP -> "PageUp"
            else -> null
        }
        if (key != null && ready && hasDoc) {
            if (e.action == KeyEvent.ACTION_DOWN) web.evaluateJavascript("window.__grAndroid.key('$key')", null)
            return true
        }
        return super.dispatchKeyEvent(e)
    }

    private var hasDoc = false

    private fun leave() {
        if (!moveTaskToBack(true)) finish()
    }

    private fun immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            window.decorView.windowInsetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
    }

    // ---------- what to open ----------

    private fun handle(i: Intent?) {
        i ?: return
        when (i.action) {
            Intent.ACTION_SEND -> {
                val stream = streamOf(i)
                val text = i.getStringExtra(Intent.EXTRA_TEXT)
                when {
                    stream != null && text.isNullOrBlank() -> openUri(stream)
                    !text.isNullOrBlank() -> openText(text, i.getStringExtra(Intent.EXTRA_SUBJECT), i.`package`)
                    stream != null -> openUri(stream)
                }
            }
            Intent.ACTION_PROCESS_TEXT -> i.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()?.let { openText(it, null, null) }
            Intent.ACTION_VIEW -> i.data?.let { if (it.scheme == "http" || it.scheme == "https") openLink(it.toString()) else openUri(it) }
            ACTION_CAPTURE -> i.getStringExtra(EXTRA_FILE)?.let { f ->
                val file = File(f)
                if (file.exists()) { js("window.__grAndroid.wall()"); openFile(file, chat = true) }
            }
            ACTION_CAPTURE_ERROR -> i.getStringExtra(EXTRA_MESSAGE)?.let { js("window.__grAndroid.error(${JSONObject.quote(it)})") }
            ACTION_FETCHING -> js("window.__grAndroid.fetching(true)")
        }
        // Handled once; a later recreate must not open it again.
        i.action = Intent.ACTION_MAIN
    }

    private fun streamOf(i: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") i.getParcelableExtra(Intent.EXTRA_STREAM)

    /** Shared or selected text. A lone link is opened as a page; anything else is read as Markdown. */
    private fun openText(text: String, subject: String?, from: String?) {
        val t = text.trim()
        val url = Regex("""^(?:[^\n]{0,200}?\s)?(https?://\S+)$""").find(t)?.groupValues?.get(1)
        if (url != null && t.length < url.length + 200 && !t.contains('\n')) return openLink(url)
        val title = subject?.takeIf { it.isNotBlank() && !it.startsWith("http") }
            ?: t.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.trimStart('#', ' ')?.take(80) ?: "Shared text"
        val md = if (Regex("""^\s*#\s""").containsMatchIn(t.lineSequence().take(6).joinToString("\n"))) t else "# ${title}\n\n$t"
        val f = Docs.write(this, Docs.slug(title) + ".md", md.toByteArray())
        openFile(f, chat = false)
    }

    /** A web page: a ChatGPT / Claude / Gemini share link, or any article. */
    private fun openLink(url: String) {
        js("window.__grAndroid.fetching(true)")
        link?.cancel()
        link = LinkCapture(this, root, url) { result ->
            link = null
            result.fold(
                onSuccess = { openFile(it.file, it.chat) },
                onFailure = { js("window.__grAndroid.error(${JSONObject.quote(it.message ?: "Couldn’t read that page.")})") },
            )
        }.also { it.start() }
    }

    private fun openUri(uri: Uri) {
        try {
            val name = displayName(uri) ?: uri.lastPathSegment?.substringAfterLast('/') ?: "document"
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: error("Couldn’t open that file.")
            openFile(Docs.write(this, name, bytes), chat = false)
        } catch (e: Exception) {
            js("window.__grAndroid.error(${JSONObject.quote(e.message ?: "Couldn’t open that file.")})")
        }
    }

    private fun displayName(uri: Uri): String? = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull()

    private fun openFile(f: File, chat: Boolean) {
        val id = f.parentFile!!.name
        val d = JSONObject()
            .put("name", f.name)
            .put("url", "/doc/$id/${Uri.encode(f.name)}")
            // Chats open at the latest answer: the reader knows them by this path.
            .put("path", (if (chat) "/glass-reader/captures/" else "/android/docs/") + "$id/${f.name}")
        js("window.__grAndroid.open($d)")
    }

    private fun js(code: String) {
        if (ready) web.evaluateJavascript(code, null) else pending.add(code)
    }

    private fun pickFile() {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(
                "application/pdf", "application/epub+zip", "text/*", "text/markdown", "text/html",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"))
        startActivityForResult(i, PICK)
    }

    @Deprecated("Simple single request")
    override fun onActivityResult(req: Int, res: Int, data: Intent?) {
        super.onActivityResult(req, res, data)
        if (req == PICK && res == RESULT_OK) data?.data?.let { openUri(it) }
    }

    inner class Bridge {
        @JavascriptInterface fun ready() = runOnUiThread {
            ready = true
            pending.forEach { web.evaluateJavascript(it, null) }
            pending.clear()
        }
        @JavascriptInterface fun hide() = runOnUiThread { leave() }
        @JavascriptInterface fun quit() = runOnUiThread { finishAndRemoveTask() }
        @JavascriptInterface fun log(m: String) { Log.d(TAG, m) }
        @JavascriptInterface fun pickFile() = runOnUiThread { this@ReaderActivity.pickFile() }
        @JavascriptInterface fun docOpen(open: Boolean) { hasDoc = open }
        @JavascriptInterface fun hasWall(): Boolean = File(filesDir, "wall.jpg").isFile
        @JavascriptInterface fun status(): String =
            JSONObject().put("screen", CaptureService.isEnabled(this@ReaderActivity)).toString()
        @JavascriptInterface fun openAccessibilitySettings() = runOnUiThread {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    companion object {
        const val TAG = "GlassReader"
        const val ACTION_CAPTURE = "dev.glassreader.CAPTURE"
        const val ACTION_CAPTURE_ERROR = "dev.glassreader.CAPTURE_ERROR"
        const val ACTION_FETCHING = "dev.glassreader.FETCHING"
        const val EXTRA_FILE = "file"
        const val EXTRA_MESSAGE = "message"
        private const val PICK = 7

        fun intent(c: Context, action: String) =
            Intent(c, ReaderActivity::class.java).setAction(action)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}
