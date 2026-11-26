package dev.glassreader

import android.app.AppOpsManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import android.util.Log
import android.view.WindowManager

/**
 * The quiet way to read from the screen. Payment apps (Google Pay and others) refuse to work
 * while any accessibility service that isn't an assistive tool is switched on, so here the
 * service is off almost all the time: [ButtonService] draws the Read button as an ordinary
 * overlay, and a tap switches [CaptureService] on for the few seconds one read takes, after
 * which it switches itself off again.
 *
 * Needs three things an app can't ask for by itself, given once from a computer
 * (`npm run build:android -- --install` does it):
 *   adb shell pm grant dev.glassreader android.permission.WRITE_SECURE_SETTINGS
 *   adb shell appops set dev.glassreader SYSTEM_ALERT_WINDOW allow
 *   adb shell appops set dev.glassreader GET_USAGE_STATS allow
 */
object Quiet {
    private const val WINDOW = 20_000L

    private fun canSwitch(c: Context) =
        c.checkSelfPermission(android.Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED

    private fun canSeeFront(c: Context): Boolean {
        val ops = c.getSystemService(AppOpsManager::class.java)
        val mode = if (Build.VERSION.SDK_INT >= 29) ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), c.packageName)
        else @Suppress("DEPRECATION") ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), c.packageName)
        return mode == AppOpsManager.MODE_ALLOWED
    }

    fun ready(c: Context) = canSwitch(c) && Settings.canDrawOverlays(c) && canSeeFront(c)

    private fun prefs(c: Context) = c.getSharedPreferences("quiet", Context.MODE_PRIVATE)

    /** Switch the service on for one read. */
    fun read(c: Context): Boolean {
        if (!canSwitch(c)) return false
        prefs(c).edit().putLong("ask", System.currentTimeMillis()).commit()
        return runCatching {
            val cr = c.contentResolver
            val me = ComponentName(c, CaptureService::class.java).flattenToString()
            val on = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
            val others = on.split(':').filter { it.isNotEmpty() && !it.equals(me, true) }
            // Listed but not running (left over from a reinstall): off and on again starts it.
            if (others.size != on.split(':').count { it.isNotEmpty() } && CaptureService.instance == null) {
                Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, others.joinToString(":"))
            }
            Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, (others + me).joinToString(":"))
            Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
        }.onFailure { Log.e(CaptureService.TAG, "switching on failed", it) }.isSuccess
    }

    /**
     * The chat apps glide from one screen to the next, and most of a read used to be spent
     * waiting for that. With the system's animations off for the length of the read, each
     * screen jumps into place. Put back afterwards (and at the next start, should a read die).
     */
    fun still(c: Context, on: Boolean) {
        if (!canSwitch(c)) return
        val p = prefs(c)
        runCatching {
            val cr = c.contentResolver
            val key = Settings.Global.ANIMATOR_DURATION_SCALE
            if (on) {
                if (!p.contains("anim")) p.edit().putFloat("anim", Settings.Global.getFloat(cr, key, 1f)).commit()
                Settings.Global.putFloat(cr, key, 0f)
            } else if (p.contains("anim")) {
                Settings.Global.putFloat(cr, key, p.getFloat("anim", 1f))
                p.edit().remove("anim").commit()
            }
        }.onFailure { Log.w(CaptureService.TAG, "animations: ${it.message}") }
    }

    /** Was the service just switched on for one read? (Asked once, by the service as it connects.) */
    fun take(c: Context): Boolean {
        val p = prefs(c)
        val asked = p.getLong("ask", 0L)
        if (asked == 0L) return false
        p.edit().remove("ask").commit()
        return System.currentTimeMillis() - asked in 0..WINDOW
    }

    /** Start (or stop) the button to match what is allowed. Safe to call any time. */
    fun sync(c: Context) {
        if (CaptureService.instance == null) still(c, false)
        val i = Intent(c, ButtonService::class.java)
        if (ready(c)) {
            CaptureService.instance?.retire()
            runCatching { c.startForegroundService(i) }.onFailure { Log.w(CaptureService.TAG, "button not started: ${it.message}") }
        } else c.stopService(i)
    }
}

/** Keeps the Read button over ChatGPT, Claude and Gemini without any accessibility service running. */
class ButtonService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var button: ReadButton
    private lateinit var usage: UsageStatsManager
    private var since = 0L
    private var front: String? = null
    private var frontClass: String? = null
    private var reading = 0L

    private val tick = object : Runnable {
        override fun run() {
            look()
            main.postDelayed(this, 700)
        }
    }

    private val screen = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            main.removeCallbacks(tick)
            when (i.action) {
                Intent.ACTION_SCREEN_ON -> main.post(tick)
                Notify.ACTION_SHOW -> { button.unhide(); main.post(tick) }
            }
        }
    }

    override fun onBind(i: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        usage = getSystemService(UsageStatsManager::class.java)
        button = ReadButton(this, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY) {
            reading = System.currentTimeMillis()
            Log.w(CaptureService.TAG, "quiet: tap")
            button.set(false)
            if (!Quiet.read(this)) reading = 0L
        }
        val f = IntentFilter(Intent.ACTION_SCREEN_ON).apply { addAction(Intent.ACTION_SCREEN_OFF) }
        registerReceiver(screen, f)
        registerReceiver(screen, IntentFilter(Notify.ACTION_SHOW), RECEIVER_NOT_EXPORTED)
        since = System.currentTimeMillis() - 12 * 3600_000L
    }

    override fun onStartCommand(i: Intent?, flags: Int, id: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Read button is ready", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Keeps the Read button available over ChatGPT, Claude and Gemini"
            setShowBadge(false)
        })
        val open = PendingIntent.getActivity(this, 0, Intent(this, ReaderActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_read)
            .setContentTitle("Read button is ready")
            .setContentText("It appears over ChatGPT, Claude and Gemini.")
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(ID, n)
        main.removeCallbacks(tick)
        if (getSystemService(PowerManager::class.java).isInteractive) main.post(tick)
        return START_STICKY
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        runCatching { unregisterReceiver(screen) }
        button.destroy()
        super.onDestroy()
    }

    /** Which app is in front, from the system's record of screens coming to the front. */
    private fun look() {
        if (!Quiet.ready(this)) { stopSelf(); return }
        val now = System.currentTimeMillis()
        runCatching {
            val ev = usage.queryEvents(since, now)
            val e = UsageEvents.Event()
            while (ev.hasNextEvent()) {
                ev.getNextEvent(e)
                if (e.eventType == UsageEvents.Event.ACTIVITY_RESUMED) { front = e.packageName; frontClass = e.className }
            }
            since = now - 1500 // events can land a little late
        }
        // While a read is under way the service draws its own screen over the chat.
        if (CaptureService.instance != null) { reading = 0L; button.set(false); return }
        if (now - reading < 4000) return
        button.set(isChat(front, frontClass))
    }

    private fun isChat(pkg: String?, cls: String?): Boolean {
        if (pkg == null || pkg !in CaptureService.APPS) return false
        if (pkg != CaptureService.GOOGLE) return true
        // The Google app is also Search, Discover and Lens: only its Gemini screens count.
        val c = cls?.lowercase() ?: return false
        return "robin" in c || "gemini" in c || "bard" in c
    }

    companion object {
        private const val CHANNEL = "ready"
        private const val ID = 2
    }
}

/** After a restart, bring the button back. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        if (i.action == Intent.ACTION_BOOT_COMPLETED || i.action == Intent.ACTION_MY_PACKAGE_REPLACED) Quiet.sync(c)
    }
}
