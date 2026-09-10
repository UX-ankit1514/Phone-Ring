package com.arnifi.phonebell.ring

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.arnifi.phonebell.R
import com.arnifi.phonebell.ui.MainActivity
import com.arnifi.phonebell.notifications.RequestActionReceiver

class RingService : Service() {
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var stopAt = 0L
    private var requestId: String? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startRing(intent)
            ACTION_STOP -> {
                val id = intent.getStringExtra(EXTRA_REQUEST_ID)
                // A stop received before START is also safe; a stop for another
                // active request must never silence the current one.
                if (requestId == null || id == null || id == requestId) stopRing(id.takeIf { requestId != null })
            }
        }
        return START_NOT_STICKY
    }

    private fun startRing(intent: Intent) {
        val id = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return stopSelf()
        val requester = intent.getStringExtra(EXTRA_REQUESTER).orEmpty().ifBlank { "An Arnifi teammate" }
        val expiresAt = intent.getLongExtra(EXTRA_EXPIRES_AT, System.currentTimeMillis() + 10_000)
        val duration = intent.getIntExtra(EXTRA_DURATION, 10).coerceIn(1, 30)
        if (expiresAt <= System.currentTimeMillis()) return stopSelf()
        if (requestId != null) stopRing(null)
        requestId = id
        stopAt = minOf(expiresAt, System.currentTimeMillis() + duration * 1000L)
        startForeground(NOTIFICATION_ID, notification(id, requester))
        val audioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val audioManager = getSystemService(AudioManager::class.java)
        val notificationManager = getSystemService(NotificationManager::class.java)
        val interruptionsAllowed = notificationManager.currentInterruptionFilter ==
            NotificationManager.INTERRUPTION_FILTER_ALL
        if (interruptionsAllowed && audioManager.ringerMode == AudioManager.RINGER_MODE_NORMAL) {
            player = MediaPlayer.create(
                this,
                R.raw.phone_bell,
                audioAttributes,
                AudioManager.AUDIO_SESSION_ID_GENERATE,
            )?.apply {
                isLooping = true
                start()
            }
        }
        if (interruptionsAllowed && audioManager.ringerMode != AudioManager.RINGER_MODE_SILENT) {
            vibrator = getSystemService(Vibrator::class.java)?.also {
                if (it.hasVibrator()) it.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 500, 500), 0))
            }
        }
        val remaining = stopAt - System.currentTimeMillis()
        android.os.Handler(mainLooper).postDelayed({ if (requestId == id) stopRing(id) }, remaining.coerceAtLeast(1))
    }

    private fun stopRing(expectedId: String?) {
        if (expectedId != null && expectedId != requestId) return
        player?.runCatching { stop(); release() }
        player = null
        vibrator?.cancel()
        vibrator = null
        requestId = null
        NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun notification(id: String, requester: String): Notification {
        val open = PendingIntent.getActivity(this, 11, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val acknowledge = PendingIntent.getBroadcast(this, id.hashCode(), Intent(this, RequestActionReceiver::class.java)
            .setAction(RequestActionReceiver.ACTION_ACKNOWLEDGE)
            .putExtra(RequestActionReceiver.EXTRA_REQUEST_ID, id), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_phone_bell)
            .setContentTitle(getString(R.string.incoming_phone_request))
            .setContentText(getString(R.string.incoming_phone_request_from, requester))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setSilent(true)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(open)
            .addAction(NotificationCompat.Action(R.drawable.ic_phone_bell, getString(R.string.ive_got_it), acknowledge))
            .build()
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build()
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel_name), NotificationManager.IMPORTANCE_HIGH).apply {
            description = getString(R.string.notification_channel_description)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 500, 500)
            setSound(android.net.Uri.parse("android.resource://$packageName/${R.raw.phone_bell}"), attributes)
        })
    }

    override fun onDestroy() {
        player?.runCatching { stop(); release() }
        player = null
        vibrator?.cancel()
        vibrator = null
        requestId = null
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "com.arnifi.phonebell.action.START_RING"
        const val ACTION_STOP = "com.arnifi.phonebell.action.STOP_RING"
        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_REQUESTER = "requester"
        const val EXTRA_EXPIRES_AT = "expires_at"
        const val EXTRA_DURATION = "duration_seconds"
        const val CHANNEL_ID = "uae_phone_requests"
        const val NOTIFICATION_ID = 1401
    }
}
