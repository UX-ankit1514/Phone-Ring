package com.arnifi.phonebell.firebase

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.arnifi.phonebell.ArnifiPhoneBellApp
import com.arnifi.phonebell.work.CallbackAction
import com.arnifi.phonebell.work.PhoneBellWorkScheduler
import kotlinx.coroutines.launch

class ArnifiFirebaseMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val app = application as ArnifiPhoneBellApp
        val payload = message.data
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launchSafely {
            app.settings.recordFcmReceived(System.currentTimeMillis())
            when (val incoming = IncomingMessageParser(com.arnifi.phonebell.BuildConfig.TARGET_DEVICE_ID).parse(payload).getOrElse {
                app.settings.recordError(it.message ?: "Invalid push payload")
                return@launchSafely
            }) {
                is com.arnifi.phonebell.model.IncomingMessage.Cancellation -> {
                    app.ringController.stop(incoming.requestId)
                    app.settings.recordRequestStatus(incoming.requestId, "cancelled")
                }
                is com.arnifi.phonebell.model.IncomingMessage.Request -> {
                    val request = incoming.value
                    if (!app.settings.markRequestHandledIfNew(request.requestId)) return@launchSafely
                    app.settings.recordRequest(request.requestId, request.requestedByName, "received")
                    PhoneBellWorkScheduler.enqueueCallback(this@ArnifiFirebaseMessagingService, request.requestId, CallbackAction.DELIVERED)
                    val foregroundAlert = app.ringController.start(
                        request,
                        allowForegroundService = message.priority == RemoteMessage.PRIORITY_HIGH,
                    )
                    if (!foregroundAlert) {
                        app.settings.recordError("Foreground alert unavailable; notification fallback used")
                    }
                }
            }
        }
    }

    override fun onNewToken(token: String) {
        PhoneBellWorkScheduler.enqueueTokenRegistration(this, token)
    }
}

private fun kotlinx.coroutines.CoroutineScope.launchSafely(block: suspend () -> Unit) = launch {
    runCatching { block() }.onFailure { /* FCM callbacks must never crash the process. */ }
}
