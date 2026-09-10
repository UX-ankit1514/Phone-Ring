package com.arnifi.phonebell.firebase

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class IncomingMessageParserTest {
    private val parser = IncomingMessageParser("uae-phone-01") { 1_000L }

    @Test fun parsesCanonicalBackendEnvelopeFields() {
        val parsed = parser.parse(mapOf(
            "type" to "PHONE_REQUEST",
            "requestId" to "req_123",
            "targetDeviceId" to "uae-phone-01",
            "requestedByName" to "Rahul Sharma",
            "expiresAtEpochMs" to "60000",
            "ringDurationSeconds" to "10",
        )).getOrThrow()
        val request = (parsed as com.arnifi.phonebell.model.IncomingMessage.Request).value
        assertEquals("Rahul Sharma", request.requestedByName)
        assertEquals(60_000L, request.expiresAtEpochMs)
        assertEquals(10, request.ringDurationSeconds)
    }

    @Test fun rejectsExpiredAndForeignMessages() {
        assertTrue(parser.parse(mapOf("type" to "PHONE_REQUEST", "requestId" to "r", "targetDeviceId" to "uae-phone-01", "requestedByName" to "Ab", "expiresAtEpochMs" to "999", "ringDurationSeconds" to "10")).isFailure)
        assertTrue(parser.parse(mapOf("type" to "PHONE_REQUEST_CANCELLED", "requestId" to "r", "targetDeviceId" to "other")).isFailure)
    }
}
