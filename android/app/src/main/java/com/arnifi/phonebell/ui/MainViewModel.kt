package com.arnifi.phonebell.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.arnifi.phonebell.ArnifiPhoneBellApp
import com.arnifi.phonebell.model.DiagnosticsSnapshot
import com.arnifi.phonebell.model.IncomingPhoneRequest
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class MainViewModel(private val app: ArnifiPhoneBellApp) : ViewModel() {
    val diagnostics: StateFlow<DiagnosticsSnapshot> = app.settings.diagnostics.stateIn(
        viewModelScope, SharingStarted.WhileSubscribed(5_000),
        DiagnosticsSnapshot(firebaseConfigured = app.firebase.isConfigured, enrolled = app.repository.isEnrolled),
    )
    val busy = kotlinx.coroutines.flow.MutableStateFlow(false)
    val message = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)

    init {
        viewModelScope.launch {
            app.settings.setFirebaseConfigured(app.firebase.isConfigured)
            if (app.repository.isEnrolled) {
                runCatching { app.repository.registerCurrentToken() }
                runCatching { app.repository.heartbeat() }
            }
        }
    }

    fun enroll(code: String) {
        viewModelScope.launch {
            busy.value = true
            message.value = null
            runCatching { app.repository.enroll(code) }
                .onSuccess { message.value = "This phone is enrolled and ready." }
                .onFailure { message.value = it.message ?: "Enrollment failed"; app.settings.recordError(message.value!!) }
            busy.value = false
        }
    }

    fun retryTokenRegistration() {
        viewModelScope.launch {
            busy.value = true
            runCatching { app.repository.registerCurrentToken() }
                .onSuccess { message.value = "FCM token registered." }
                .onFailure { message.value = it.message ?: "Registration failed" }
            busy.value = false
        }
    }

    fun testRing() {
        val now = System.currentTimeMillis()
        app.ringController.start(
            IncomingPhoneRequest(
                requestId = "test-$now",
                requestedByName = "Arnifi Test Ring",
                targetDeviceId = com.arnifi.phonebell.BuildConfig.TARGET_DEVICE_ID,
                expiresAtEpochMs = now + com.arnifi.phonebell.BuildConfig.DEFAULT_RING_DURATION_SECONDS * 1_000L,
                ringDurationSeconds = com.arnifi.phonebell.BuildConfig.DEFAULT_RING_DURATION_SECONDS,
            ),
        )
        message.value = "Test Ring started."
    }
}
