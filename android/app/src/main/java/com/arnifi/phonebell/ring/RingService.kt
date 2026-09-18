package com.arnifi.phonebell.ring

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.arnifi.phonebell.R
import com.arnifi.phonebell.notifications.RequestActionReceiver
import com.arnifi.phonebell.ui.MainActivity

class RingService : Service() {
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var stopAt = 0L
    private var requestId: String? = null
    private lateinit var audioManager: AudioManager
    private lateinit var audioSession: RingAudioSession

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(AudioManager::class.java)
        audioSession = RingAudioSession(audioManager)
        RingChannel.ensure(this)
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
        val requester = intent.getStringExtra(EXTRA_REQUESTER).orEmpty().ifBlank { DEFAULT_REQUESTER }
        val expiresAt = intent.getLongExtra(EXTRA_EXPIRES_AT, System.currentTimeMillis() + 10_000)
        val duration = intent.getIntExtra(EXTRA_DURATION, 10).coerceIn(1, 30)
        if (expiresAt <= System.currentTimeMillis()) return stopSelf()
        if (requestId != null) stopRing(null)
        requestId = id
        stopAt = minOf(expiresAt, System.currentTimeMillis() + duration * 1000L)
        startForeground(NOTIFICATION_ID, notification(id, requester))
        showCallerOverlay(id, requester)
        if (alertsAudible()) {
            startAlarmAudio()
            startAlarmVibration()
        }
        val remaining = stopAt - System.currentTimeMillis()
        Handler(mainLooper).postDelayed({ if (requestId == id) stopRing(id) }, remaining.coerceAtLeast(1))
    }

    /**
     * Alarm-usage audio survives Silent mode and every Do Not Disturb profile except
     * total silence, which is the one setting the phone's owner uses to mean "nothing
     * at all". Everything quieter than that should still ring.
     */
    private fun alertsAudible(): Boolean =
        getSystemService(NotificationManager::class.java).currentInterruptionFilter !=
            NotificationManager.INTERRUPTION_FILTER_NONE

    private fun startAlarmAudio() {
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        audioSession.begin(attributes)
        // The phone's own ringtone is the bell; the bundled one covers a phone set to Silent
        // or a tone this app cannot read.
        val tone = RingTone.deviceRingtone(this)
        player = (tone?.let { openPlayer(it, attributes) } ?: openPlayer(RingTone.bundledBell(this), attributes))
            ?.apply {
                routeToLoudspeaker(this)
                isLooping = true
                setVolume(1f, 1f)
                audioSession.amplify(audioSessionId)
                start()
            }
    }

    /** Returns null rather than throwing when a tone turns out to be unreadable or unplayable. */
    private fun openPlayer(tone: Uri, attributes: AudioAttributes): MediaPlayer? = runCatching {
        MediaPlayer.create(this, tone, null, attributes, AudioManager.AUDIO_SESSION_ID_GENERATE)
    }.getOrNull()

    /**
     * Keeps the bell on the phone's own speaker even when a headset or car kit is paired:
     * this handset is shared, and whoever is standing next to it has to hear it.
     */
    private fun routeToLoudspeaker(player: MediaPlayer) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
        player.preferredDevice = audioManager
            .getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
    }

    private fun startAlarmVibration() {
        vibrator = getSystemService(Vibrator::class.java)?.also {
            if (it.hasVibrator()) {
                it.vibrate(
                    VibrationEffect.createWaveform(
                        VIBRATION_TIMINGS,
                        VIBRATION_AMPLITUDES,
                        VIBRATION_REPEAT_INDEX,
                    ),
                )
            }
        }
    }

    /**
     * Shows the caller's name directly. This succeeds while the app is in the foreground
     * or while "display over other apps" is granted; otherwise the notification's
     * full-screen intent covers the locked-screen case and a heads-up covers the rest.
     */
    private fun showCallerOverlay(id: String, requester: String) {
        runCatching { startActivity(RingOverlayActivity.createIntent(this, id, requester, stopAt)) }
    }

    private fun stopRing(expectedId: String?) {
        if (expectedId != null && expectedId != requestId) return
        val stoppedId = requestId
        player?.runCatching { stop(); release() }
        player = null
        audioSession.end()
        vibrator?.cancel()
        vibrator = null
        requestId = null
        // Named explicitly so a stop for the request just replaced cannot race ahead and
        // close the overlay that the replacing request has already opened.
        stoppedId?.let { sendBroadcast(RingOverlayActivity.dismissIntent(packageName, it)) }
        NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun notification(id: String, requester: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            OPEN_APP_REQUEST_CODE,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val callerOverlay = PendingIntent.getActivity(
            this,
            id.hashCode(),
            RingOverlayActivity.createIntent(this, id, requester, stopAt),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val acknowledge = PendingIntent.getBroadcast(
            this,
            id.hashCode(),
            Intent(this, RequestActionReceiver::class.java)
                .setAction(RequestActionReceiver.ACTION_ACKNOWLEDGE)
                .putExtra(RequestActionReceiver.EXTRA_REQUEST_ID, id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, RingChannel.ID)
            .setSmallIcon(R.drawable.ic_phone_bell)
            .setContentTitle(getString(R.string.incoming_phone_request))
            .setContentText(getString(R.string.incoming_phone_request_from, requester))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            // This service drives its own alarm-stream audio and vibration, so the
            // notification must not add a second, quieter bell on top of it.
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(open)
            .setFullScreenIntent(callerOverlay, true)
            .addAction(NotificationCompat.Action(R.drawable.ic_phone_bell, getString(R.string.ive_got_it), acknowledge))
            .build()
    }

    override fun onDestroy() {
        player?.runCatching { stop(); release() }
        player = null
        if (::audioSession.isInitialized) audioSession.end()
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
        const val NOTIFICATION_ID = 1401

        internal const val DEFAULT_REQUESTER = "An Arnifi teammate"

        private const val OPEN_APP_REQUEST_CODE = 11

        private const val MAX_VIBRATION_AMPLITUDE = 255

        /** Off, buzz, pause — repeated, at full strength, for an unmistakable alert. */
        private val VIBRATION_TIMINGS = longArrayOf(0, 500, 500)
        private val VIBRATION_AMPLITUDES = intArrayOf(0, MAX_VIBRATION_AMPLITUDE, 0)
        private const val VIBRATION_REPEAT_INDEX = 0
    }
}
