package dev.glassreader

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executor
import kotlin.math.abs

/**
 * "Read from the screen": while ChatGPT, Claude or Gemini is in front, a small Read
 * button sits at the edge of the screen. Tapping it walks the chat from top to bottom
 * (scrolling it, since the apps only keep what is on screen) and opens it in the reader.
 *
 * The service does nothing else: it only looks at windows when one of the three apps is
 * in front, and only reads their content when Read is tapped.
 */
class CaptureService : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var worker: Handler
    private lateinit var wm: WindowManager
    private lateinit var button: ReadButton
    /** Turned on just to read one chat (see [Quiet]); turns itself off when that is done. */
    private var oneShot = false
    private var scrim: View? = null
    private var scrimText: TextView? = null
    private var current: String? = null
    @Volatile private var busy = false
    @Volatile private var cancelled = false
    private var debugReceiver: BroadcastReceiver? = null

    override fun onServiceConnected() {
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        worker = Handler(HandlerThread("capture").apply { start() }.looper)
        // The notification's "Show" (only this app can send it).
        registerReceiver(object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) = button.unhide()
        }, IntentFilter(Notify.ACTION_SHOW), RECEIVER_NOT_EXPORTED)
        button = ReadButton(this, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY) { current?.let { read(it) } }
        if (button.hiddenUntil <= System.currentTimeMillis()) Notify.cancel(this)
        instance = this
        oneShot = Quiet.take(this)
        Log.w(TAG, "quiet: connected oneShot=$oneShot")
        when {
            oneShot -> main.postDelayed({ readFront(0) }, 150)
            // Left on from before the quiet way was set up: payment apps refuse to work
            // while any service like this one is on, so it steps aside.
            Quiet.ready(this) -> { retire(); return }
            else -> update()
        }
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            // adb shell am broadcast -a dev.glassreader.DUMP  → the chat's node tree in logcat
            debugReceiver = object : BroadcastReceiver() {
                override fun onReceive(c: Context, i: Intent) {
                    worker.post {
                        val root = appRoot() ?: run { Log.d(TAG, "dump: no chat app in front"); return@post }
                        Log.d(TAG, "dump: ${root.packageName}")
                        Debug.dump(root, 0)
                    }
                }
            }
            val f = IntentFilter("dev.glassreader.DUMP").apply { addAction("dev.glassreader.READ") }
            registerReceiver(object : BroadcastReceiver() {
                override fun onReceive(c: Context, i: Intent) {
                    if (i.action == "dev.glassreader.READ") main.post { current?.let { read(it) } }
                    else debugReceiver?.onReceive(c, i)
                }
            // Only adb may send these (the shell holds DUMP; other apps can't), so no app on
            // the phone can make Glass Reader read or log a chat.
            }, f, android.Manifest.permission.DUMP, null, RECEIVER_EXPORTED)
        }
    }

    override fun onAccessibilityEvent(e: AccessibilityEvent) {
        if (e.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || e.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) update()
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        Quiet.still(this, false)
        if (::button.isInitialized) button.destroy()
        hideScrim()
        main.removeCallbacksAndMessages(null)
        if (::worker.isInitialized) worker.looper.quitSafely()
        super.onDestroy()
    }

    /** The app in front: the active application window's package. */
    private fun frontApp(): String? = try {
        val w = windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.isActive }
            ?: windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.isFocused }
        val root = w?.root
        val p = root?.packageName?.toString()
        when {
            p == null -> null
            p == packageName -> p
            isChat(root) -> p
            else -> "other"
        }
    } catch (_: Exception) { null }

    private fun appRoot(pkg: String? = null): AccessibilityNodeInfo? = try {
        windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            .mapNotNull { it.root }
            .firstOrNull { r -> if (pkg != null) r.packageName == pkg else isChat(r) }
    } catch (_: Exception) { null }

    private fun update() {
        if (busy || oneShot) return
        val pkg = frontApp()
        if (pkg == packageName) return // our own reader in front: leave the button as it was
        current = pkg?.takeIf { it in APPS }
        button.set(current != null)
    }

    /** One read of the chat in front, asked for by [ButtonService]; then the service turns itself off. */
    private fun readFront(tries: Int) {
        val pkg = frontApp()?.takeIf { it in APPS }
        when {
            pkg != null -> { Log.w(TAG, "quiet: front found, try $tries"); read(pkg) }
            tries < 5 -> main.postDelayed({ readFront(tries + 1) }, 200)
            else -> {
                startActivity(ReaderActivity.intent(this, ReaderActivity.ACTION_CAPTURE_ERROR)
                    .putExtra(ReaderActivity.EXTRA_MESSAGE, "No chat found on screen. Open a conversation and tap Read again."))
                retire()
            }
        }
    }

    /** Off again, so nothing is left running in Accessibility. */
    fun retire() {
        oneShot = true // no button from here on
        if (::button.isInitialized) button.set(false)
        if (instance === this) instance = null
        main.postDelayed({ runCatching { disableSelf() } }, 300)
    }

    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    /** Covers the chat while it scrolls by itself, so it doesn't flicker past you. Tap to stop. */
    private fun showScrim(app: String) {
        if (scrim != null) return
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.argb(235, 11, 13, 20))
        }
        val t = TextView(this).apply {
            text = "Reading the $app chat…"
            setTextColor(Color.argb(240, 244, 245, 250)); textSize = 17f; gravity = Gravity.CENTER
        }
        val s = TextView(this).apply {
            text = "Tap to stop"
            setTextColor(Color.argb(130, 244, 245, 250)); textSize = 13f; gravity = Gravity.CENTER
            setPadding(0, dp(10f), 0, 0)
        }
        box.addView(t); box.addView(s)
        box.setOnClickListener { cancelled = true; t.text = "Stopping…" }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
        runCatching { wm.addView(box, lp); scrim = box; scrimText = t }
    }

    private fun hideScrim() {
        scrim?.let { runCatching { wm.removeView(it) } }
        scrim = null; scrimText = null
    }

    // ---------- reading ----------

    private fun read(pkg: String) {
        if (busy) return
        busy = true
        cancelled = false
        val app = APPS.getValue(pkg)
        button.set(false)
        // A picture of the chat first: the reader's Glass background is this screen, blurred.
        screenshot { shot ->
            Log.w(TAG, "read: screenshot done")
            shot?.let { saveWall(it) }
            showScrim(app)
            worker.post {
                Quiet.still(this, true)
                val result = runCatching {
                    ChatReader(this, pkg, app, ::appRoot, { cancelled }) { n ->
                        main.post { scrimText?.text = "Reading the $app chat… $n".trimEnd() }
                    }.read()
                }
                Quiet.still(this, false)
                main.post {
                    hideScrim()
                    busy = false
                    result.fold(
                        onSuccess = { md ->
                            Log.w(TAG, "read: ${md?.markdown?.length ?: "nothing"}")
                            if (md == null) {
                                startActivity(ReaderActivity.intent(this, ReaderActivity.ACTION_CAPTURE_ERROR)
                                    .putExtra(ReaderActivity.EXTRA_MESSAGE, "No chat found on screen. Open a conversation in $app and tap Read again."))
                            } else {
                                val f = Docs.write(this, Docs.slug(md.title) + ".md", md.markdown.toByteArray())
                                startActivity(ReaderActivity.intent(this, ReaderActivity.ACTION_CAPTURE).putExtra(ReaderActivity.EXTRA_FILE, f.path))
                            }
                        },
                        onFailure = { e ->
                            Log.e(TAG, "read failed", e)
                            startActivity(ReaderActivity.intent(this, ReaderActivity.ACTION_CAPTURE_ERROR)
                                .putExtra(ReaderActivity.EXTRA_MESSAGE, "Couldn’t read the chat: ${e.message}"))
                        },
                    )
                    if (oneShot) retire() else update()
                }
            }
        }
    }

    private fun screenshot(done: (Bitmap?) -> Unit) {
        if (Build.VERSION.SDK_INT < 30) return done(null)
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, Executor { main.post(it) }, object : TakeScreenshotCallback {
                override fun onSuccess(s: ScreenshotResult) {
                    val bmp = runCatching { Bitmap.wrapHardwareBuffer(s.hardwareBuffer, s.colorSpace)?.copy(Bitmap.Config.ARGB_8888, false) }.getOrNull()
                    s.hardwareBuffer.close()
                    done(bmp)
                }
                override fun onFailure(code: Int) = done(null)
            })
        } catch (_: Exception) { done(null) }
    }

    /** Small and soft is all a blurred background needs. */
    private fun saveWall(b: Bitmap) = worker.post {
        runCatching {
            val small = Bitmap.createScaledBitmap(b, b.width / 4, b.height / 4, true)
            FileOutputStream(File(filesDir, "wall.jpg")).use { small.compress(Bitmap.CompressFormat.JPEG, 70, it) }
        }
    }

    companion object {
        const val TAG = "GlassReader"
        /** The connected service, if it is on right now. */
        @Volatile var instance: CaptureService? = null
        val APPS = mapOf(
            "com.openai.chatgpt" to "ChatGPT",
            "com.anthropic.claude" to "Claude",
            "com.google.android.apps.bard" to "Gemini",
            // The Gemini app's screens belong to the Google app.
            GOOGLE to "Gemini",
        )
        const val GOOGLE = "com.google.android.googlequicksearchbox"

        /** The Google app is also Search, Discover and Lens: only its Gemini screens count. */
        fun isChat(root: AccessibilityNodeInfo): Boolean {
            val p = root.packageName?.toString() ?: return false
            if (p !in APPS) return false
            if (p != GOOGLE) return true
            return root.findAccessibilityNodeInfosByViewId("$GOOGLE:id/assistant_robin_main_activity").isNotEmpty()
        }

        fun isEnabled(c: Context): Boolean {
            val me = ComponentName(c, CaptureService::class.java).flattenToString()
            val on = Settings.Secure.getString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return on.split(':').any { it.equals(me, true) || it.equals(me.replace("dev.glassreader/dev.glassreader.", "dev.glassreader/."), true) }
        }
    }
}

object Debug {
    fun dump(n: AccessibilityNodeInfo?, depth: Int) {
        n ?: return
        val r = Rect().also { n.getBoundsInScreen(it) }
        val flags = buildString {
            if (n.isClickable) append('C'); if (n.isLongClickable) append('L'); if (n.isFocusable) append('F')
            if (n.isScrollable) append('S'); if (!n.isVisibleToUser) append('-'); if (n.isHeading) append('H')
        }
        val text = n.text
        val spans = if (text is android.text.Spanned) text.getSpans(0, text.length, Any::class.java).joinToString(" ") { s ->
            val d = when (s) {
                is android.text.style.StyleSpan -> "style=${s.style}"
                is android.text.style.RelativeSizeSpan -> "rel=${s.sizeChange}"
                is android.text.style.AbsoluteSizeSpan -> "abs=${s.size}${if (s.dip) "dp" else "px"}"
                is android.text.style.URLSpan -> "url=${s.url.take(40)}"
                is android.text.style.TypefaceSpan -> "face=${s.family}"
                is android.text.style.ForegroundColorSpan -> "fg=${Integer.toHexString(s.foregroundColor)}"
                else -> ""
            }
            "${s.javaClass.simpleName}[${text.getSpanStart(s)},${text.getSpanEnd(s)}]$d"
        } else ""
        val desc = n.contentDescription?.toString()?.take(40)
        val extra = n.availableExtraData.joinToString(",") { it.substringAfterLast('.') }
        val coll = n.collectionInfo?.let { " coll=${it.rowCount}x${it.columnCount}" } ?: ""
        val item = n.collectionItemInfo?.let { " item=${it.rowIndex},${it.columnIndex}${if (it.isHeading) "H" else ""}" } ?: ""
        Log.d(CaptureService.TAG, "${"  ".repeat(depth)}${n.className?.toString()?.substringAfterLast('.')} ${n.viewIdResourceName?.substringAfterLast('/') ?: ""} $r $flags$coll$item" +
            (if (text != null) " text=${text.toString().replace("\n", "⏎").take(160).let { "\"$it\"" }}" else "") +
            (if (desc != null) " desc=\"$desc\"" else "") + (if (spans.isNotEmpty()) " SPANS{$spans}" else "") +
            (if (extra.isNotEmpty()) " extra=$extra" else "") + " role=${n.extras.getCharSequence("AccessibilityNodeInfo.roleDescription") ?: ""}")
        if (text != null && text.length > 1 && n.availableExtraData.contains(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY)) {
            val rects = CharBoxes.of(n)
            val starts = listOf(0) + text.indices.filter { text[it] == '\n' }.map { it + 1 }.filter { it < text.length }
            val pad = "  ".repeat(depth + 1)
            for ((k, st) in starts.withIndex().take(40)) {
                val rf = rects?.getOrNull(st)
                val line = text.substring(st, text.indexOf('\n', st).let { if (it < 0) text.length else it })
                val seps = line.filter { it == '\t' || it.code == 0xA0 || it.code == 0x200B || it.code < 32 }.map { Integer.toHexString(it.code) }.distinct()
                val firstReal = (st until text.length).firstOrNull { text[it] != '\u200b' && text[it] != '\n' }
                val fr = firstReal?.let { rects?.getOrNull(it) }
                val sp = (st until (text.indexOf('\n', st).let { if (it < 0) text.length else it })).filter { text[it] == ' ' }
                    .mapNotNull { i -> rects?.getOrNull(i)?.let { "${it.width().toInt()}" } }.joinToString(",")
                Log.d(CaptureService.TAG, "$pad   real: ${fr?.let { "x=${it.left.toInt()} y=${it.top.toInt()} h=${it.height().toInt()}" }} spaces=[$sp]")
                Log.d(CaptureService.TAG, "$pad#$k ${rf?.let { "x=${it.left.toInt()} y=${it.top.toInt()} h=${it.height().toInt()} w=${it.width().toInt()}" } ?: "offscreen"} seps=$seps \"${line.take(70)}\"")
            }
        }
        for (i in 0 until n.childCount) dump(n.getChild(i), depth + 1)
    }
}

/** Where each character of a text is on screen (null where it isn't on screen). */
object CharBoxes {
    fun of(n: AccessibilityNodeInfo, max: Int = 20000): Array<android.graphics.RectF?>? {
        val len = minOf(n.text?.length ?: 0, max)
        if (len == 0) return null
        val args = android.os.Bundle().apply {
            putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_START_INDEX, 0)
            putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_LENGTH, len)
        }
        if (!n.refreshWithExtraData(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY, args)) return null
        @Suppress("DEPRECATION")
        val arr = n.extras.getParcelableArray(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY) ?: return null
        return Array(arr.size) { arr[it] as? android.graphics.RectF }
    }
}
