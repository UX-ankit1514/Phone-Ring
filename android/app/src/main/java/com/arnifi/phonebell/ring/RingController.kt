package com.arnifi.phonebell.ring

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.arnifi.phonebell.R
import com.arnifi.phonebell.model.IncomingPhoneRequest
import com.arnifi.phonebell.notifications.RequestActionReceiver
import com.arnifi.phonebell.ui.MainActivity

/** Shared facade used by real FCM requests and the local Test Ring action. */
class RingController(private val context: Context) {
    /** Returns true when RingService owns the alert; false when the safe notification fallback is used. */
    fun start(request: IncomingPhoneRequest, allowForegroundService: Boolean = true): Boolean {
        val intent = Intent(context, RingService::class.java)
            .setAction(RingService.ACTION_START)
            .putExtra(RingService.EXTRA_REQUEST_ID, request.requestId)
            .putExtra(RingService.EXTRA_REQUESTER, request.requestedByName)
            .putExtra(RingService.EXTRA_EXPIRES_AT, request.expiresAtEpochMs)
            .putExtra(RingService.EXTRA_DURATION, request.ringDurationSeconds)
        if (allowForegroundService && runCatching { ContextCompat.startForegroundService(context, intent) }.isSuccess) {
            return true
        }
        postNotificationFallback(request)
        return false
    }

    fun stop(requestId: String) {
        if (fallbackRequestId == requestId) {
            NotificationManagerCompat.from(context).cancel(RingService.NOTIFICATION_ID)
            fallbackRequestId = null
        }
        runCatching {
            context.startService(
                Intent(context, RingService::class.java)
                    .setAction(RingService.ACTION_STOP)
                    .putExtra(RingService.EXTRA_REQUEST_ID, requestId),
            )
        }
    }

    private fun postNotificationFallback(request: IncomingPhoneRequest) {
        createChannel()
        val acknowledge = PendingIntent.getBroadcast(
            context,
            request.requestId.hashCode(),
            Intent(context, RequestActionReceiver::class.java)
                .setAction(RequestActionReceiver.ACTION_ACKNOWLEDGE)
                .putExtra(RequestActionReceiver.EXTRA_REQUEST_ID, request.requestId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val open = PendingIntent.getActivity(
            context,
            11,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, RingService.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_phone_bell)
            .setContentTitle(context.getString(R.string.incoming_phone_request))
            .setContentText(context.getString(R.string.incoming_phone_request_from, request.requestedByName))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(open)
            .setAutoCancel(false)
            .setTimeoutAfter(request.ringDurationSeconds.coerceIn(1, 30) * 1_000L)
            .addAction(R.drawable.ic_phone_bell, context.getString(R.string.ive_got_it), acknowledge)
            .build()
        fallbackRequestId = request.requestId
        val canPostNotifications = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (canPostNotifications) {
            NotificationManagerCompat.from(context).notify(RingService.NOTIFICATION_ID, notification)
        }
    }

    private fun createChannel() {
        val manager = context.getSystemService(NotificationManager::class.java)
        val sound = Uri.parse("android.resource://${context.packageName}/${R.raw.phone_bell}")
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        manager.createNotificationChannel(
            NotificationChannel(
                RingService.CHANNEL_ID,
                context.getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.notification_channel_description)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 500, 500)
                setSound(sound, attributes)
            },
        )
    }

    companion object {
        @Volatile private var fallbackRequestId: String? = null
    }
}
