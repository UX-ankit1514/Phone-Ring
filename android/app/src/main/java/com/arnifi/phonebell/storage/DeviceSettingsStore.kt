package com.arnifi.phonebell.storage

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.arnifi.phonebell.model.DiagnosticsSnapshot
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private val Context.phoneBellDataStore by preferencesDataStore(name = "phone_bell_device")

class DeviceSettingsStore(private val context: Context) {
    private val dedupeMutex = Mutex()

    val diagnostics: Flow<DiagnosticsSnapshot> = context.phoneBellDataStore.data.map { preferences ->
        DiagnosticsSnapshot(
            enrolled = preferences[Keys.ENROLLED] ?: false,
            firebaseConfigured = preferences[Keys.FIREBASE_CONFIGURED] ?: false,
            tokenRegistered = preferences[Keys.TOKEN_REGISTERED] ?: false,
            lastHeartbeatAtEpochMs = preferences[Keys.LAST_HEARTBEAT_AT],
            lastFcmAtEpochMs = preferences[Keys.LAST_FCM_AT],
            lastRequestId = preferences[Keys.LAST_REQUEST_ID],
            lastRequesterName = preferences[Keys.LAST_REQUESTER_NAME],
            lastRequestStatus = preferences[Keys.LAST_REQUEST_STATUS],
            lastError = preferences[Keys.LAST_ERROR],
        )
    }

    suspend fun setFirebaseConfigured(configured: Boolean) {
        context.phoneBellDataStore.edit { it[Keys.FIREBASE_CONFIGURED] = configured }
    }

    suspend fun setEnrolled(enrolled: Boolean) {
        context.phoneBellDataStore.edit { it[Keys.ENROLLED] = enrolled }
    }

    suspend fun setTokenRegistered(registered: Boolean) {
        context.phoneBellDataStore.edit { it[Keys.TOKEN_REGISTERED] = registered }
    }

    suspend fun recordFcmReceived(atEpochMs: Long) {
        context.phoneBellDataStore.edit { it[Keys.LAST_FCM_AT] = atEpochMs }
    }

    suspend fun recordRequest(requestId: String, requesterName: String, status: String) {
        context.phoneBellDataStore.edit {
            it[Keys.LAST_REQUEST_ID] = requestId
            it[Keys.LAST_REQUESTER_NAME] = requesterName
            it[Keys.LAST_REQUEST_STATUS] = status
            it.remove(Keys.LAST_ERROR)
        }
    }

    suspend fun recordRequestStatus(requestId: String, status: String) {
        context.phoneBellDataStore.edit {
            if (it[Keys.LAST_REQUEST_ID] == requestId) it[Keys.LAST_REQUEST_STATUS] = status
        }
    }

    suspend fun recordHeartbeat(atEpochMs: Long) {
        context.phoneBellDataStore.edit {
            it[Keys.LAST_HEARTBEAT_AT] = atEpochMs
            it.remove(Keys.LAST_ERROR)
        }
    }

    suspend fun recordError(message: String) {
        context.phoneBellDataStore.edit { it[Keys.LAST_ERROR] = message.take(MAX_ERROR_LENGTH) }
    }

    /**
     * Atomically persists a bounded, ordered request history before an alert starts.
     * Returning false means the request was already observed and must not ring again.
     */
    suspend fun markRequestHandledIfNew(requestId: String): Boolean = dedupeMutex.withLock {
        var isNew = false
        context.phoneBellDataStore.edit { preferences ->
            val requests = preferences[Keys.RECENT_REQUEST_IDS]
                .orEmpty()
                .lineSequence()
                .filter(String::isNotBlank)
                .toMutableList()
            if (requestId !in requests) {
                isNew = true
                requests += requestId
                preferences[Keys.RECENT_REQUEST_IDS] = requests.takeLast(MAX_RECENT_REQUESTS).joinToString("\n")
            }
        }
        isNew
    }

    companion object {
        const val MAX_RECENT_REQUESTS = 100
        private const val MAX_ERROR_LENGTH = 240
    }

    private object Keys {
        val ENROLLED = booleanPreferencesKey("enrolled")
        val FIREBASE_CONFIGURED = booleanPreferencesKey("firebase_configured")
        val TOKEN_REGISTERED = booleanPreferencesKey("token_registered")
        val LAST_HEARTBEAT_AT = longPreferencesKey("last_heartbeat_at")
        val LAST_FCM_AT = longPreferencesKey("last_fcm_at")
        val LAST_REQUEST_ID = stringPreferencesKey("last_request_id")
        val LAST_REQUESTER_NAME = stringPreferencesKey("last_requester_name")
        val LAST_REQUEST_STATUS = stringPreferencesKey("last_request_status")
        val LAST_ERROR = stringPreferencesKey("last_error")
        val RECENT_REQUEST_IDS = stringPreferencesKey("recent_request_ids")
    }
}
