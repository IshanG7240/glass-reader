package dev.glassreader

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import kotlin.math.abs

/**
 * The Read button at the edge of the screen: tap to read, drag to move, drag onto the ✕ to
 * hide it for 10 minutes. [type] is the window type its owner may draw: the accessibility
 * service's own overlay, or "display over other apps" for [ButtonService].
 */
class ReadButton(private val c: Context, private val type: Int, private val onTap: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val wm = c.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var button: View? = null
    private var wanted = false

    /** Show it (unless it was dragged away for now) or take it down. */
    fun set(show: Boolean) {
        wanted = show
        if (show && System.currentTimeMillis() >= hiddenUntil) showButton() else hideButton()
    }

    fun destroy() { wanted = false; hideButton(); main.removeCallbacks(showAgain) }

    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.resources.displayMetrics).toInt()

    private val prefs by lazy { c.getSharedPreferences("ui", Context.MODE_PRIVATE) }

    /** Dragged onto the ✕: the button stays away until this time (or the notification is tapped). */
    val hiddenUntil get() = prefs.getLong("hiddenUntil", 0L)
    private val showAgain = Runnable { unhide() }

    init {
        val left = hiddenUntil - System.currentTimeMillis()
        if (left > 0) main.postDelayed(showAgain, left)
    }

    private fun showButton() {
        if (button != null) return
        val size = dp(46f)
        val b = android.widget.ImageView(c).apply {
            setImageResource(R.drawable.ic_read)
            scaleType = android.widget.ImageView.ScaleType.CENTER_INSIDE
            setPadding(dp(11f), dp(11f), dp(9f), dp(11f))
            background = GradientDrawable().apply {
                cornerRadii = floatArrayOf(size / 2f, size / 2f, 0f, 0f, 0f, 0f, size / 2f, size / 2f)
                setColor(Color.argb(215, 22, 24, 34))
                setStroke(dp(1f), Color.argb(60, 255, 255, 255))
            }
            elevation = dp(6f).toFloat()
            contentDescription = "Read this chat in Glass Reader"
        }
        val lp = WindowManager.LayoutParams(
            size, size,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.END or Gravity.TOP
            x = 0
            y = prefs.getInt("y", c.resources.displayMetrics.heightPixels * 2 / 5)
        }
        // A tap reads. Dragging moves it up and down the edge; dragging it onto the ✕ that
        // appears at the bottom hides it for 10 minutes.
        var downX = 0f; var downY = 0f; var startY = 0; var moved = false; var over = false
        b.setOnTouchListener { v, ev ->
            val dm = c.resources.displayMetrics
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> { downX = ev.rawX; downY = ev.rawY; startY = lp.y; moved = false; over = false; v.alpha = 0.75f }
                MotionEvent.ACTION_MOVE -> {
                    val dx = ev.rawX - downX; val dy = ev.rawY - downY
                    if (!moved && (abs(dx) > dp(8f) || abs(dy) > dp(8f))) { moved = true; showDismiss() }
                    if (moved) {
                        lp.y = (startY + dy.toInt()).coerceIn(dp(40f), dm.heightPixels - size)
                        lp.x = (-dx).toInt().coerceIn(0, dm.widthPixels - size)
                        over = overDismiss(ev.rawX, ev.rawY)
                        dismissTarget?.let { t -> t.scaleX = if (over) 1.25f else 1f; t.scaleY = t.scaleX; t.alpha = if (over) 1f else 0.85f }
                        runCatching { wm.updateViewLayout(v, lp) }
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    v.alpha = 1f
                    hideDismiss()
                    when {
                        moved && over && ev.actionMasked == MotionEvent.ACTION_UP -> {
                            lp.x = 0; lp.y = startY
                            hideFor(10 * 60_000L)
                        }
                        moved -> {
                            lp.x = 0
                            runCatching { wm.updateViewLayout(v, lp) }
                            prefs.edit().putInt("y", lp.y).apply()
                        }
                        ev.actionMasked == MotionEvent.ACTION_UP -> onTap()
                    }
                }
            }
            true
        }
        runCatching { wm.addView(b, lp); button = b }
    }

    private fun hideButton() {
        button?.let { runCatching { wm.removeView(it) } }
        button = null
        hideDismiss()
    }

    // ---------- hiding the button for a while ----------

    private var dismissTarget: View? = null

    private fun dismissCenter(): Pair<Float, Float> {
        val dm = c.resources.displayMetrics
        return dm.widthPixels / 2f to dm.heightPixels - dp(110f).toFloat()
    }

    private fun overDismiss(x: Float, y: Float): Boolean {
        val (cx, cy) = dismissCenter()
        return kotlin.math.hypot(x - cx, y - cy) < dp(70f)
    }

    private fun showDismiss() {
        if (dismissTarget != null) return
        val size = dp(58f)
        val t = TextView(c).apply {
            text = "✕"
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            textSize = 20f
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.argb(200, 22, 24, 34))
                setStroke(dp(1.5f), Color.argb(110, 255, 255, 255))
            }
            alpha = 0.85f
        }
        val (_, cy) = dismissCenter()
        val lp = WindowManager.LayoutParams(
            size, size,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = (cy - size / 2f).toInt()
        }
        runCatching { wm.addView(t, lp); dismissTarget = t }
    }

    private fun hideDismiss() {
        dismissTarget?.let { runCatching { wm.removeView(it) } }
        dismissTarget = null
    }

    private fun hideFor(ms: Long) {
        prefs.edit().putLong("hiddenUntil", System.currentTimeMillis() + ms).apply()
        hideButton()
        main.removeCallbacks(showAgain)
        main.postDelayed(showAgain, ms)
        if (!Notify.hidden(c, ms)) {
            android.widget.Toast.makeText(c, "Read button hidden for 10 minutes", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    fun unhide() {
        main.removeCallbacks(showAgain)
        prefs.edit().remove("hiddenUntil").apply()
        Notify.cancel(c)
        set(wanted)
    }
}
