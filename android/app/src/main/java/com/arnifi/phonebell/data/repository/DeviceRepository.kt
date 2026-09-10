package com.arnifi.phonebell.data.repository

import com.arnifi.phonebell.data.api.PhoneBellApi
import com.arnifi.phonebell.firebase.FirebaseCoordinator
import com.arnifi.phonebell.storage.DeviceSettingsStore
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.tasks.await

class DeviceRepository(
    private val firebase: FirebaseCoordinator,
    private val api: PhoneBellApi,
    private val settings: DeviceSettingsStore,
) {
    val isFirebaseConfigured: Boolean get() = firebase.isConfigured
    val isEnrolled: Boolean get() = firebase.isEnrolled()

    suspend fun enroll(enrollmentCode: String) {
        require(enrollmentCode.trim().length in 6..128) { "Enter a valid one-time enrollment code" }
        require(firebase.isConfigured) { "Add Firebase configuration for this build before enrollment" }
        val customToken = api.enroll(enrollmentCode.trim())
        firebase.enroll(customToken)
        settings.setEnrolled(true)
        registerCurrentToken()
    }

    suspend fun registerCurrentToken() {
        require(firebase.isEnrolled()) { "Target device is not enrolled" }
        settings.setTokenRegistered(false)
        val token = FirebaseMessaging.getInstance().token.await()
        api.registerDevice(token)
        settings.setTokenRegistered(true)
    }

    suspend fun registerToken(token: String) {
        require(firebase.isEnrolled()) { "Target device is not enrolled" }
        settings.setTokenRegistered(false)
        api.registerDevice(token)
        settings.setTokenRegistered(true)
    }

    suspend fun delivered(requestId: String) {
        api.delivered(requestId)
        settings.recordRequestStatus(requestId, "delivered")
    }

    suspend fun acknowledge(requestId: String) {
        api.acknowledge(requestId)
        settings.recordRequestStatus(requestId, "acknowledged")
    }

    suspend fun heartbeat() {
        api.heartbeat()
        settings.recordHeartbeat(System.currentTimeMillis())
    }
}
