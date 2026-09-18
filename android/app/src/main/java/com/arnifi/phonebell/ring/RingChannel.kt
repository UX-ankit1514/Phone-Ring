package com.arnifi.phonebell.ring

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import com.arnifi.phonebell.R

/**
 * The single definition of the urgent phone-request notification channel, shared by
 * [RingService] and the [RingController] fallback so both alert paths sound identical.
 *
 * Android freezes a channel's sound and importance when the channel is first created, so
 * every change to either needs a new [ID]: V2 moved from the ringtone stream to the alarm
 * stream, then from the bundled bell to the phone's own ringtone. [ensure] retires each
 * superseded channel on the way, leaving upgraded phones with a single entry in system
 * notification settings.
 */
internal object RingChannel {
    const val ID = "uae_phone_requests_v3"

    private val SUPERSEDED_IDS = listOf("uae_phone_requests", "uae_phone_requests_v2")
    private val VIBRATION_PATTERN = longArrayOf(0, 500, 500)

    fun ensure(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        SUPERSEDED_IDS.forEach(manager::deleteNotificationChannel)
        manager.createNotificationChannel(
            NotificationChannel(
                ID,
                context.getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.notification_channel_description)
                enableVibration(true)
                vibrationPattern = VIBRATION_PATTERN
                setSound(
                    RingTone.channelSound(),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
            },
        )
    }
}
