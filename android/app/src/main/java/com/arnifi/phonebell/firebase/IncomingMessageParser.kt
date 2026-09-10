package com.arnifi.phonebell.firebase

import com.arnifi.phonebell.model.IncomingMessage
import com.arnifi.phonebell.model.IncomingPhoneRequest

class IncomingMessageParser(
    private val targetDeviceId: String,
    private val nowEpochMs: () -> Long = System::currentTimeMillis,
) {
    fun parse(data: Map<String, String>): Result<IncomingMessage> = runCatching {
        when (data.required("type")) {
            PHONE_REQUEST -> parseRequest(data)
            PHONE_REQUEST_CANCELLED -> IncomingMessage.Cancellation(
                requestId = data.requiredRequestId().also {
                    require(data.required("targetDeviceId") == targetDeviceId) { "Cancellation is for a different target" }
                },
            )
            else -> error("Unsupported message type")
        }
    }

    private fun parseRequest(data: Map<String, String>): IncomingMessage.Request {
        val target = data.required("targetDeviceId")
        require(target == targetDeviceId) { "Message is for a different target" }

        val requester = data.required("requestedByName").trim()
        require(requester.length in MIN_NAME_LENGTH..MAX_NAME_LENGTH) { "Invalid requester name" }

        val expiresAt = data.required("expiresAtEpochMs").toLongOrNull()
            ?: error("Invalid request expiry")
        require(expiresAt > nowEpochMs()) { "Request has expired" }
        require(expiresAt <= nowEpochMs() + MAX_FUTURE_WINDOW_MS) { "Request expiry is too far in the future" }

        val ringDuration = data.required("ringDurationSeconds").toIntOrNull()
            ?: error("Invalid ring duration")
        require(ringDuration in MIN_RING_SECONDS..MAX_RING_SECONDS) { "Ring duration is out of range" }

        return IncomingMessage.Request(
            IncomingPhoneRequest(
                requestId = data.requiredRequestId(),
                requestedByName = requester,
                targetDeviceId = target,
                expiresAtEpochMs = expiresAt,
                ringDurationSeconds = ringDuration,
            ),
        )
    }

    private fun Map<String, String>.required(key: String): String =
        this[key]?.takeIf(String::isNotBlank) ?: error("Missing $key")

    private fun Map<String, String>.requiredRequestId(): String =
        required("requestId").also {
            require(REQUEST_ID_REGEX.matches(it)) { "Invalid requestId" }
        }

    companion object {
        const val PHONE_REQUEST = "PHONE_REQUEST"
        const val PHONE_REQUEST_CANCELLED = "PHONE_REQUEST_CANCELLED"
        private const val MIN_NAME_LENGTH = 2
        private const val MAX_NAME_LENGTH = 50
        private const val MIN_RING_SECONDS = 1
        private const val MAX_RING_SECONDS = 30
        private const val MAX_FUTURE_WINDOW_MS = 5 * 60 * 1000L
        private val REQUEST_ID_REGEX = Regex("^[A-Za-z0-9_-]{1,128}$")
    }
}
