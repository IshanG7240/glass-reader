package dev.glassreader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/** The notification shown while the Read button is hidden: tap it to bring the button back. */
object Notify {
    const val ACTION_SHOW = "dev.glassreader.SHOW_BUTTON"
    private const val CHANNEL = "button"
    private const val ID = 1

    fun allowed(c: Context): Boolean =
        Build.VERSION.SDK_INT < 33 || c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Returns false when notifications are off (the caller says so another way). */
    fun hidden(c: Context, ms: Long): Boolean {
        val nm = c.getSystemService(NotificationManager::class.java)
        if (!allowed(c) || !nm.areNotificationsEnabled()) return false
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Read button", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while the Read button is hidden, to bring it back"
            setShowBadge(false)
        })
        val show = PendingIntent.getBroadcast(
            c, 0, Intent(ACTION_SHOW).setPackage(c.packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_read)
            .setContentTitle("Read button hidden")
            .setContentText("It comes back in ${ms / 60_000} minutes. Tap to show it now.")
            .setContentIntent(show)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(ms)
            .setShowWhen(false)
            .addAction(Notification.Action.Builder(null, "Show now", show).build())
            .build()
        nm.notify(ID, n)
        return true
    }

    fun cancel(c: Context) = c.getSystemService(NotificationManager::class.java).cancel(ID)
}
