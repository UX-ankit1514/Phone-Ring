package com.arnifi.phonebell.model

data class IncomingPhoneRequest(
    val requestId: String,
    val requestedByName: String,
    val targetDeviceId: String,
    val expiresAtEpochMs: Long,
    val ringDurationSeconds: Int,
)

sealed interface IncomingMessage {
    data class Request(val value: IncomingPhoneRequest) : IncomingMessage
    data class Cancellation(val requestId: String) : IncomingMessage
}

enum class CallbackAction(val wireName: String) {
    DELIVERED("delivered"),
    ACKNOWLEDGE("acknowledge"),
}

data class DiagnosticsSnapshot(
    val enrolled: Boolean = false,
    val firebaseConfigured: Boolean = false,
    val tokenRegistered: Boolean = false,
    val lastHeartbeatAtEpochMs: Long? = null,
    val lastFcmAtEpochMs: Long? = null,
    val lastRequestId: String? = null,
    val lastRequesterName: String? = null,
    val lastRequestStatus: String? = null,
    val lastError: String? = null,
)
